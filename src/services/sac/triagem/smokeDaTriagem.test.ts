import { describe, expect, it, vi } from 'vitest';

import type { TriagemV1 } from '@/lib/integrations/contratoDaTriagem';

import { criarModeloFalso } from './modelosDeTriagem';
import { FIXTURES_DA_TRIAGEM, rodarSmokeDaTriagem } from './smokeDaTriagem';
import type { ModeloDeTriagem, RespostaDoModelo } from './triagemDoCaso';

const triagem = (intencao: TriagemV1['intencao']): TriagemV1 => ({
  versao: 1, intencao, motivo: 'MOTIVO-LIVRE-SINTETICO', confianca: 'alta', numeroDoPedido: null, resolucaoPedida: 'informacao', entidades: [],
  informacoesFaltando: [], proximaPergunta: null, precisaDeHumano: false, motivoDoHumano: null,
});

/** Modelo que acerta a primeira intenção aceitável de cada fixture, lendo o id embutido no texto. */
function modeloQueAcerta(): ModeloDeTriagem & { gerar: ReturnType<typeof vi.fn> } {
  return {
    provedor: 'teste', modelo: 'acerta',
    gerar: vi.fn(async ({ conteudo }: { conteudo: string }): Promise<RespostaDoModelo> => {
      const fixture = FIXTURES_DA_TRIAGEM.find((f) => f.mensagens.every((m) => conteudo.includes(m.slice(0, 20).replace(/[<>]/gu, ''))));
      return { _tag: 'Objeto', valor: triagem(fixture?.intencoes[0] ?? 'outro'), uso: { entrada: 100, saida: 20 } };
    }),
  };
}

describe('rodarSmokeDaTriagem', () => {
  it('fixtures sintéticas: a de segredo nunca chega ao modelo; as demais validam o schema e somam o uso', async () => {
    const modelo = modeloQueAcerta();
    const relatorio = await rodarSmokeDaTriagem(modelo, { timeoutMs: 1000 });
    const paraModelo = FIXTURES_DA_TRIAGEM.filter((f) => f.intencoes.length > 0).length;
    expect(modelo.gerar).toHaveBeenCalledTimes(paraModelo);
    expect(relatorio).toMatchObject({ schemaValidado: paraModelo, comModelo: paraModelo, tokensEntrada: 100 * paraModelo, aprovado: true });
    expect(relatorio.resultados.find((r) => r.id === 'segredo')).toMatchObject({ status: 'handoff', motivo: 'entrada_bloqueada', chamouModelo: false, esperado: true });
  });

  it('o relatório não leva texto das fixtures nem campos livres da resposta', async () => {
    const relatorio = await rodarSmokeDaTriagem(modeloQueAcerta(), { timeoutMs: 1000 });
    const texto = JSON.stringify(relatorio);
    for (const f of FIXTURES_DA_TRIAGEM) for (const m of f.mensagens) expect(texto).not.toContain(m.slice(0, 15));
    expect(texto).not.toContain('MOTIVO-LIVRE-SINTETICO');
  });

  it('provedor fora do ar ou schema inválido: reprovado, com o motivo por fixture', async () => {
    const fora: ModeloDeTriagem = { provedor: 'teste', modelo: 'fora', gerar: async () => ({ _tag: 'ErroDoProvedor' }) };
    const relatorio = await rodarSmokeDaTriagem(fora, { timeoutMs: 1000 });
    expect(relatorio.aprovado).toBe(false);
    expect(relatorio.resultados.find((r) => r.id === 'rastreio')).toMatchObject({ status: 'falha', motivo: 'erro_do_provedor' });
  });

  it('o modelo falso declarado valida o schema, mas a intenção não é a esperada: não substitui o teste real', async () => {
    const relatorio = await rodarSmokeDaTriagem(criarModeloFalso(), { timeoutMs: 1000 });
    expect(relatorio.provedor).toBe('fake');
    expect(relatorio.esperados).toBeLessThan(relatorio.resultados.length);
  });
});
