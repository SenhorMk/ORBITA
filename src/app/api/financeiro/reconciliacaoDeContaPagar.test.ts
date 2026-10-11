import { describe, expect, it } from 'vitest';

import type { LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { BorderoLido, ContaPagarDetalhada } from '@/services/blingPort';

import {
  MAXIMO_DE_BORDEROS,
  MAXIMO_DE_CANDIDATOS,
  decidirAutoriaDaBaixa,
  decidirConfirmacaoManual,
  decidirCriacao,
  decidirPagamentoConfirmado,
  pendenciaDaOperacao,
  situacaoLocalComprovada,
  triarContaDaBaixa,
  triarListagem,
  validarContaConfirmada,
  type TentativaParaReconciliar,
} from './reconciliacaoDeContaPagar';

const REF = 'ORB-0123456789ABCDEF';
const tentativa: TentativaParaReconciliar = {
  valor: 1200, dataVencimento: '2026-10-20', dataEmissao: '2026-10-09', contatoBlingId: 7001, numeroDocumento: REF,
};

function conta(overrides: Partial<ContaPagarDetalhada> = {}): ContaPagarDetalhada {
  return {
    id: '88123', situacao: 1, valor: 1200, vencimento: '2026-10-20', contatoId: 7001, dataEmissao: '2026-10-09',
    numeroDocumento: REF, saldo: 1200, historico: 'Aluguel', categoriaId: 900, borderos: [], ...overrides,
  };
}

const presente = (c: ContaPagarDetalhada): LeituraRemota<ContaPagarDetalhada> => ({ _tag: 'RemotoPresente', valor: c });

describe('decidirCriacao — só prova inequívoca confirma', () => {
  it('exatamente uma conta com a referência e os campos batendo: comprovada', () => {
    const prova = decidirCriacao(tentativa, [presente(conta()), presente(conta({ id: '2', numeroDocumento: null }))]);
    expect(prova).toMatchObject({ _tag: 'Comprovada', conta: { id: '88123' }, candidatos: 2 });
  });

  it.each([
    ['busca vazia: não prova que a conta não existe', [], 'nenhum_candidato'],
    ['contas parecidas sem a referência: não é prova', [presente(conta({ numeroDocumento: null })), presente(conta({ id: '2', numeroDocumento: 'ORB-FFFFFFFFFFFFFFFF' }))], 'nenhum_candidato'],
    ['duas contas com a mesma referência', [presente(conta()), presente(conta({ id: '2' }))], 'multiplos_candidatos'],
    ['referência certa, valor divergente', [presente(conta({ valor: 1300 }))], 'candidato_divergente'],
    ['referência certa, fornecedor divergente', [presente(conta({ contatoId: 9999 }))], 'candidato_divergente'],
    ['referência certa, vencimento divergente', [presente(conta({ vencimento: '2026-10-21' }))], 'candidato_divergente'],
    ['referência certa, emissão divergente', [presente(conta({ dataEmissao: '2026-10-08' }))], 'candidato_divergente'],
    ['referência certa e emissão ausente na leitura', [presente(conta({ dataEmissao: null }))], 'candidato_divergente'],
    ['conta some entre a listagem e a leitura', [{ _tag: 'RemotoAusente' } as const], 'leitura_inconsistente'],
    ['timeout na leitura', [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const], 'consulta_incompleta'],
    ['429 na leitura', [{ _tag: 'RemotoLimitado' } as const], 'consulta_incompleta'],
    ['5xx na leitura', [{ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' } as const], 'consulta_incompleta'],
    ['corpo inválido na leitura', [{ _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' } as const], 'consulta_incompleta'],
    ['recusa na leitura', [{ _tag: 'RemotoRecusou', status: 403 } as const], 'consulta_incompleta'],
  ] as const)('%s → revisão manual (%s)', (_caso, leituras, motivo) => {
    expect(decidirCriacao(tentativa, leituras)).toMatchObject({ _tag: 'RevisaoManual', motivo });
  });

  it('referência divergente em uma conta e certa em outra: a divergente não confirma nada', () => {
    const prova = decidirCriacao(tentativa, [presente(conta()), presente(conta({ id: '2', valor: 1 }))]);
    expect(prova).toMatchObject({ _tag: 'RevisaoManual', motivo: 'candidato_divergente' });
  });

  it('tentativa sem referência (anterior à migration 74): nenhuma conta, por mais parecida, é prova', () => {
    const semReferencia = { ...tentativa, numeroDocumento: null };
    expect(decidirCriacao(semReferencia, [presente(conta({ numeroDocumento: null }))]))
      .toMatchObject({ _tag: 'RevisaoManual', motivo: 'sem_referencia', candidatos: 1 });
  });
});

describe('triarListagem', () => {
  it('listagem incompleta (teto de páginas) não prova nada', () => {
    expect(triarListagem(tentativa, { _tag: 'ListagemIncompleta' })).toMatchObject({ motivo: 'listagem_incompleta' });
  });

  it.each([
    [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const],
    [{ _tag: 'RemotoLimitado' } as const],
    [{ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' } as const],
    [{ _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' } as const],
  ])('falha na listagem: revisão manual', (falha) => {
    expect(triarListagem(tentativa, falha)).toMatchObject({ _tag: 'RevisaoManual', motivo: 'consulta_incompleta' });
  });

  it('só valor, vencimento e contato iguais viram candidatos', () => {
    const base = { situacao: 1 as const, valor: 1200, vencimento: '2026-10-20', contatoId: 7001 };
    const triagem = triarListagem(tentativa, {
      _tag: 'Listada',
      contas: [{ id: '1', ...base }, { id: '2', ...base, valor: 1200.01 }, { id: '3', ...base, contatoId: 1 }, { id: '4', ...base, vencimento: '2026-10-21' }],
    });
    expect(triagem).toEqual({ _tag: 'LerCandidatos', candidatos: [{ id: '1', ...base }] });
  });

  it('candidatos demais: revisão manual, sem ler um por um', () => {
    const contas = Array.from({ length: MAXIMO_DE_CANDIDATOS + 1 }, (_, i) => ({
      id: String(i), situacao: 1 as const, valor: 1200, vencimento: '2026-10-20', contatoId: 7001,
    }));
    expect(triarListagem(tentativa, { _tag: 'Listada', contas })).toMatchObject({ motivo: 'candidatos_demais' });
  });
});

describe('triarContaDaBaixa — a conta precisa estar quitada, com saldo e borderô informados', () => {
  it('Pago, saldo zero e borderôs: segue para a autoria', () => {
    expect(triarContaDaBaixa('88123', presente(conta({ situacao: 2, saldo: 0, borderos: ['7001'] }))))
      .toMatchObject({ _tag: 'LerBorderos', conta: { id: '88123' } });
  });

  it.each([
    ['em aberto: não prova que a baixa não aconteceu, e não autoriza outra', conta(), 'conta_nao_quitada'],
    ['parcial', conta({ situacao: 3, saldo: 600 }), 'conta_nao_quitada'],
    ['Pago com saldo restante (inconsistente)', conta({ situacao: 2, saldo: 10, borderos: ['7001'] }), 'conta_nao_quitada'],
    ['Pago sem saldo informado', conta({ situacao: 2, saldo: null, borderos: ['7001'] }), 'saldo_ausente'],
    ['Pago sem borderô', conta({ situacao: 2, saldo: 0 }), 'bordero_ausente'],
    ['borderôs demais para ler', conta({ situacao: 2, saldo: 0, borderos: Array.from({ length: MAXIMO_DE_BORDEROS + 1 }, (_, i) => String(i)) }), 'borderos_demais'],
    ['outra conta lida', conta({ id: '999', situacao: 2, saldo: 0, borderos: ['7001'] }), 'leitura_inconsistente'],
  ])('%s → revisão manual', (_caso, lida, motivo) => {
    expect(triarContaDaBaixa('88123', presente(lida))).toMatchObject({ _tag: 'RevisaoManual', motivo });
  });

  it.each([
    [{ _tag: 'RemotoAusente' } as const, 'conta_ausente'],
    [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const, 'consulta_incompleta'],
    [{ _tag: 'RemotoLimitado' } as const, 'consulta_incompleta'],
  ])('leitura %o → revisão manual', (leitura, motivo) => {
    expect(triarContaDaBaixa('88123', leitura)).toMatchObject({ _tag: 'RevisaoManual', motivo });
  });
});

describe('decidirAutoriaDaBaixa — conta paga não prova que foi o ORBITA quem pagou', () => {
  const BAIXA = { referencia: 'ORBQ-0123456789ABCDEF', dataBaixa: '2026-10-09' };
  const paga = conta({ situacao: 2, saldo: 0, borderos: ['7001', '7002'] });
  const bordero = (b: Partial<BorderoLido>): LeituraRemota<BorderoLido> => ({
    _tag: 'RemotoPresente', valor: { id: '7001', data: '2026-10-09', historico: 'Aluguel [ORBQ-0123456789ABCDEF]', ...b },
  });

  it('exatamente um borderô com a referência e a data da baixa: comprovada, com o borderô', () => {
    expect(decidirAutoriaDaBaixa(BAIXA, paga, [bordero({}), bordero({ id: '7002', historico: 'Pagamento manual' })]))
      .toMatchObject({ _tag: 'Comprovada', borderoId: '7001' });
  });

  it.each([
    ['pagamento de terceiro: borderô sem a referência', [bordero({ historico: 'Pagamento manual' })], 'quitada_sem_autoria'],
    ['borderô sem histórico', [bordero({ historico: null })], 'quitada_sem_autoria'],
    ['referência certa em outra data', [bordero({ data: '2026-10-10' })], 'quitada_sem_autoria'],
    ['referência de OUTRA baixa', [bordero({ historico: 'Aluguel [ORBQ-FFFFFFFFFFFFFFFF]' })], 'quitada_sem_autoria'],
    ['dois borderôs com a referência: ambíguo', [bordero({}), bordero({ id: '7002' })], 'multiplos_borderos'],
    ['borderô some na leitura', [{ _tag: 'RemotoAusente' } as const], 'leitura_inconsistente'],
    ['timeout na leitura do borderô', [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const], 'consulta_incompleta'],
  ] as const)('%s → revisão manual (%s)', (_caso, leituras, motivo) => {
    // Uma leitura por borderô da conta, na mesma ordem.
    const daConta = conta({ situacao: 2, saldo: 0, borderos: leituras.map((_, i) => String(7001 + i)) });
    expect(decidirAutoriaDaBaixa(BAIXA, daConta, leituras)).toMatchObject({ _tag: 'RevisaoManual', motivo });
  });
});

describe('decidirConfirmacaoManual — evidência humana, nunca contra os fatos', () => {
  const decidir = (lida: LeituraRemota<ContaPagarDetalhada>, declaracao = false) =>
    decidirConfirmacaoManual(tentativa, '88123', lida, declaracao);

  it('conta com a referência da operação: evidência positiva, sem declaração', () => {
    expect(decidir(presente(conta()))).toMatchObject({ prova: { _tag: 'Comprovada' }, metodo: 'confirmacao_manual' });
  });

  it('conta sem referência e com os campos batendo: NÃO é prova', () => {
    expect(decidir(presente(conta({ numeroDocumento: null }))))
      .toMatchObject({ prova: { _tag: 'RevisaoManual', motivo: 'sem_evidencia_positiva' } });
  });

  it('conta sem referência, com a declaração explícita: vinculada como declaração', () => {
    expect(decidir(presente(conta({ numeroDocumento: null })), true))
      .toMatchObject({ prova: { _tag: 'Comprovada' }, metodo: 'declaracao_do_operador' });
  });

  it.each([
    ['referência de outra operação', conta({ numeroDocumento: 'ORB-FFFFFFFFFFFFFFFF' }), 'referencia_de_outra_operacao'],
    ['valor divergente', conta({ valor: 1 }), 'candidato_divergente'],
    ['valor divergente, mesmo declarada', conta({ valor: 1, numeroDocumento: null }), 'candidato_divergente'],
    ['conta diferente da apontada', conta({ id: '777' }), 'leitura_inconsistente'],
  ])('%s → recusada (%s), com ou sem declaração', (_caso, lida, motivo) => {
    expect(decidir(presente(lida), true)).toMatchObject({ prova: { _tag: 'RevisaoManual', motivo } });
  });

  it('conta inexistente ou leitura falha: recusada', () => {
    expect(decidir({ _tag: 'RemotoAusente' }, true)).toMatchObject({ prova: { motivo: 'conta_ausente' } });
    expect(decidir({ _tag: 'RemotoLimitado' }, true)).toMatchObject({ prova: { motivo: 'consulta_incompleta' } });
  });
});

describe('decidirPagamentoConfirmado / situacaoLocalComprovada — pago só com saldo informado e zero', () => {
  it.each([
    ['Pago, saldo zero', conta({ situacao: 2, saldo: 0 }), 'PagamentoConfirmado', 'pago'],
    ['Pago, saldo ausente', conta({ situacao: 2, saldo: null }), 'RevisaoManual', 'aberto'],
    ['Pago, saldo restante', conta({ situacao: 2, saldo: 10 }), 'RevisaoManual', 'aberto'],
    ['Em aberto', conta(), 'RevisaoManual', 'aberto'],
  ])('%s → %s; título %s', (_caso, lida, tag, situacao) => {
    expect(decidirPagamentoConfirmado('88123', presente(lida))).toMatchObject({ _tag: tag });
    expect(situacaoLocalComprovada(lida)).toBe(situacao);
  });
});

describe('validarContaConfirmada — o reparo só usa a conta confirmada, ainda compatível', () => {
  it.each([
    ['a mesma conta, compatível', presente(conta()), 'ContaValida'],
    ['outra conta', presente(conta({ id: '777' })), 'leitura_inconsistente'],
    ['valor mudou', presente(conta({ valor: 1300 })), 'candidato_divergente'],
    ['sumiu', { _tag: 'RemotoAusente' } as const, 'conta_ausente'],
    ['timeout', { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const, 'consulta_incompleta'],
  ] as const)('%s → %s', (_caso, leitura, esperado) => {
    const r = validarContaConfirmada(tentativa, '88123', leitura);
    expect(r._tag === 'ContaValida' ? 'ContaValida' : r._tag === 'RevisaoManual' ? r.motivo : r._tag).toBe(esperado);
  });
});

describe('pendenciaDaOperacao — concluída só quando Bling e projeção local batem', () => {
  const base = { estado: 'confirmada', tituloId: 't', tituloSituacao: 'aberto', quitacaoSolicitada: false, baixa: null };
  it.each([
    ['criação sem desfecho', { ...base, estado: 'indeterminada', tituloId: null }, 'conferir_criacao'],
    ['confirmada sem título', { ...base, tituloId: null, tituloSituacao: null }, 'reparo_titulo'],
    ['título vinculado não encontrado', { ...base, tituloSituacao: null }, 'titulo_inconsistente'],
    ['situação local desconhecida', { ...base, tituloSituacao: 'x' }, 'titulo_inconsistente'],
    ['título cancelado com quitação pedida', { ...base, tituloSituacao: 'cancelado', quitacaoSolicitada: true }, 'titulo_inconsistente'],
    ['título estornado com baixa', { ...base, tituloSituacao: 'estornado', baixa: { estado: 'confirmada' } }, 'titulo_inconsistente'],
    ['baixa sem desfecho', { ...base, quitacaoSolicitada: true, baixa: { estado: 'indeterminada' } }, 'conferir_baixa'],
    ['baixa em voo', { ...base, quitacaoSolicitada: true, baixa: { estado: 'em_voo' } }, 'conferir_baixa'],
    ['baixa confirmada e título aberto', { ...base, quitacaoSolicitada: true, baixa: { estado: 'confirmada' } }, 'reparo_titulo_pago'],
    ['baixa recusada e título aberto', { ...base, quitacaoSolicitada: true, baixa: { estado: 'recusada' } }, 'quitacao_recusada'],
    ['quitação pedida e nunca enviada', { ...base, quitacaoSolicitada: true }, 'quitacao_solicitada'],
    ['quitação pedida e baixa não enviada', { ...base, quitacaoSolicitada: true, baixa: { estado: 'nao_enviada' } }, 'quitacao_solicitada'],
    ['concluída sem quitação', base, null],
    ['título cancelado sem quitação em jogo', { ...base, tituloSituacao: 'cancelado' }, null],
    ['quitação pedida, título já pago', { ...base, quitacaoSolicitada: true, tituloSituacao: 'pago' }, null],
    ['baixa recusada, título pago por fora', { ...base, quitacaoSolicitada: true, tituloSituacao: 'pago', baixa: { estado: 'recusada' } }, null],
    ['criação recusada', { ...base, estado: 'recusada', tituloId: null }, null],
  ] as const)('%s → %s', (_caso, operacao, esperada) => {
    expect(pendenciaDaOperacao(operacao)).toBe(esperada);
  });
});
