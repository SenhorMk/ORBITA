import { describe, expect, it } from 'vitest';
import type { Atividade } from './historicoDeAtividades';
import { agruparPorDia, iniciais, rotuloDoDia, tituloDaAtividade } from './apresentacaoDoHistorico';

const PESSOA = { tipo: 'pessoa', userId: 'u', papel: 'admin', nome_exibicao: 'Maria', origem_do_nome: 'cadastro' } as const;
// 24/11/2026 às 15h em Brasília (18h UTC).
const AGORA = new Date('2026-11-24T18:00:00Z');

function atividade(id: string, createdAt: string): Atividade {
  return {
    id, acao: 'catalog.product_saved', descricao: 'd', recurso: 'produto', recursoId: null, correlationId: null,
    createdAt, autor: PESSOA, viaAssistente: false, gravidade: 'info',
  };
}

describe('tituloDaAtividade', () => {
  it('usa o título curto da ação', () => {
    expect(tituloDaAtividade('catalog.product_saved', PESSOA, 'descrição longa')).toBe('Salvou um produto');
  });

  it('distingue o bot respondendo sozinho de uma pessoa respondendo no atendimento', () => {
    expect(tituloDaAtividade('chatwoot.send_requested', { tipo: 'bot' }, 'd')).toBe('Respondeu um cliente pelo WhatsApp');
    expect(tituloDaAtividade('chatwoot.send_requested', PESSOA, 'd')).toBe('Respondeu um cliente no atendimento');
  });

  it('ação sem título cai na descrição do catálogo', () => {
    expect(tituloDaAtividade('evento.novo', PESSOA, 'Descrição do catálogo')).toBe('Descrição do catálogo');
  });
});

describe('rotuloDoDia', () => {
  it('hoje e ontem no fuso de Brasília, não no UTC', () => {
    expect(rotuloDoDia('2026-11-24T12:00:00Z', AGORA)).toBe('Hoje');
    // 01h UTC do dia 24 ainda é dia 23 em Brasília.
    expect(rotuloDoDia('2026-11-24T01:00:00Z', AGORA)).toBe('Ontem');
  });

  it('dias anteriores por extenso, e o ano só quando é outro', () => {
    expect(rotuloDoDia('2026-11-18T15:00:00Z', AGORA)).toBe('Quarta-feira, 18 de novembro');
    expect(rotuloDoDia('2025-03-03T15:00:00Z', AGORA)).toBe('3 de março de 2025');
  });
});

describe('agruparPorDia', () => {
  it('mantém a ordem e junta atividades seguidas do mesmo dia', () => {
    const grupos = agruparPorDia([
      atividade('a', '2026-11-24T17:00:00Z'), atividade('b', '2026-11-24T12:00:00Z'), atividade('c', '2026-11-23T12:00:00Z'),
    ], AGORA);

    expect(grupos.map((g) => [g.rotulo, g.atividades.map((a) => a.id)])).toEqual([['Hoje', ['a', 'b']], ['Ontem', ['c']]]);
  });
});

describe('iniciais', () => {
  it('primeira e última palavra, uma palavra só, ou sem nome', () => {
    expect(iniciais('Maria da Silva')).toBe('MS');
    expect(iniciais('João')).toBe('JO');
    expect(iniciais(null)).toBe('?');
  });
});
