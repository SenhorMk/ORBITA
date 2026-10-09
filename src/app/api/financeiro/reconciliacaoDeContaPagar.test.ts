import { describe, expect, it } from 'vitest';

import type { LeituraRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { ContaPagarDetalhada } from '@/services/blingPort';

import {
  MAXIMO_DE_CANDIDATOS,
  decidirBaixa,
  decidirCriacao,
  triarListagem,
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

describe('decidirBaixa — só conta quitada prova a baixa', () => {
  it('Pago com saldo zero: comprovada', () => {
    expect(decidirBaixa('88123', presente(conta({ situacao: 2, saldo: 0, borderos: ['7001'] }))))
      .toMatchObject({ _tag: 'Comprovada' });
  });

  it.each([
    ['em aberto: não prova que a baixa não aconteceu, e não autoriza outra', conta(), 'conta_nao_quitada'],
    ['parcial', conta({ situacao: 3, saldo: 600 }), 'conta_nao_quitada'],
    ['Pago com saldo restante (inconsistente)', conta({ situacao: 2, saldo: 10 }), 'conta_nao_quitada'],
    ['outra conta lida', conta({ id: '999', situacao: 2, saldo: 0 }), 'leitura_inconsistente'],
  ])('%s → revisão manual', (_caso, lida, motivo) => {
    expect(decidirBaixa('88123', presente(lida))).toMatchObject({ _tag: 'RevisaoManual', motivo });
  });

  it.each([
    [{ _tag: 'RemotoAusente' } as const, 'conta_ausente'],
    [{ _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' } as const, 'consulta_incompleta'],
    [{ _tag: 'RemotoLimitado' } as const, 'consulta_incompleta'],
  ])('leitura %o → revisão manual', (leitura, motivo) => {
    expect(decidirBaixa('88123', leitura)).toMatchObject({ _tag: 'RevisaoManual', motivo });
  });
});
