/**
 * PRE-007B, fatia 2 — `POST /api/nfe` registra a nota pela RPC auditada.
 *
 * A rota e o `pedidoRepository` reais; só o banco e o Bling são substituídos.
 * `registrar_documento_fiscal_emitido` (migration 83) grava a nota e
 * `fiscal.document_issued` na mesma transação. Sem ela no banco, a rota recusa
 * antes do Bling: uma nota emitida lá e impossível de registrar aqui é o
 * pior desfecho.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FronteiraDeAutorizacao, ORG_ID, OUTRA_ORG_ID, OWNER_ID } from '../__testkit__/fronteiraDeAutorizacao';

type Resposta = { data: unknown; error: { code?: string; message: string } | null };

const fronteira = new FronteiraDeAutorizacao();
const createNfeMock = vi.fn();
let sonda: Resposta;
let registro: Resposta;
const chamadasDoRegistro: Record<string, unknown>[] = [];

vi.mock('@/lib/supabaseServer', () => ({
  get supabaseServer() {
    const banco = fronteira.supabaseServer;
    return {
      ...banco,
      rpc: async (nome: string, argumentos: Record<string, unknown>) => {
        if (nome !== 'registrar_documento_fiscal_emitido') return banco.rpc(nome, argumentos);
        chamadasDoRegistro.push(argumentos);
        return argumentos.p_organizacao_id === null ? sonda : registro;
      },
    };
  },
}));
vi.mock('@/services/bling', () => ({
  bling: { forVerifiedOrganization: () => ({ createNfe: createNfeMock }) },
}));

const PEDIDO_ID = '40000000-0000-4000-8000-000000000001';
const SEM_A_83: Resposta = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
const SONDA_OK: Resposta = { data: null, error: { code: '22023', message: 'Organizacao, ator e pedido sao obrigatorios.' } };

async function faturar(corpo: Record<string, unknown> = { pedidoId: PEDIDO_ID, blingPedidoId: '99' }) {
  const { POST } = await import('./route');
  return POST(new Request('https://orbita.test/api/nfe', {
    method: 'POST',
    headers: { Authorization: 'Bearer token-de-sessao', 'Content-Type': 'application/json', 'x-correlation-id': 'corr_nfe_teste' },
    body: JSON.stringify(corpo),
  }));
}

describe('POST /api/nfe — registro auditado da NF-e (PRE-007B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chamadasDoRegistro.length = 0;
    fronteira.limparChamadas().sessaoDe(OWNER_ID).vinculoDe('owner')
      .rpcResponde('tentar_lock_nfe_organizacao', { data: true, error: null });
    sonda = SONDA_OK;
    registro = { data: null, error: null };
    createNfeMock.mockResolvedValue({ data: { id: 777, numero: '1002', chave: 'chave-sintetica', situacao: 'Emitida' } });
  });

  it('banco sem a migration 83: responde 503 e não chama o Bling', async () => {
    sonda = SEM_A_83;

    const resposta = await faturar();

    expect(resposta.status).toBe(503);
    expect(createNfeMock).not.toHaveBeenCalled();
    expect(chamadasDoRegistro.filter((a) => a.p_organizacao_id !== null)).toEqual([]);
  });

  it('qualquer outra resposta da sonda também conta como indisponível (falha fechada)', async () => {
    sonda = { data: null, error: { code: 'XX000', message: 'banco fora' } };

    expect((await faturar()).status).toBe(503);
    expect(createNfeMock).not.toHaveBeenCalled();
  });

  it('fluxo autorizado: registra pela RPC com a organização e o ator do escopo e a correlação da requisição', async () => {
    registro = {
      data: { id: 'doc-1', organizacao_id: ORG_ID, bling_id: '777', numero: '1002', chave_acesso: 'chave-sintetica', status: 'Emitida', pedido_id: PEDIDO_ID },
      error: null,
    };

    const resposta = await faturar({ pedidoId: PEDIDO_ID, blingPedidoId: '99', organizacao_id: OUTRA_ORG_ID });

    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ success: true, data: { id: 'doc-1', numero: '1002', chave: 'chave-sintetica' } });
    expect(createNfeMock).toHaveBeenCalledTimes(1);
    expect(chamadasDoRegistro.filter((a) => a.p_organizacao_id !== null)).toEqual([{
      p_organizacao_id: ORG_ID,
      p_ator_id: OWNER_ID,
      p_pedido_id: PEDIDO_ID,
      p_bling_id: '777',
      p_numero: '1002',
      p_chave_acesso: 'chave-sintetica',
      p_status: 'Emitida',
      p_correlation_id: 'corr_nfe_teste',
    }]);
  });

  it('auditoria recusada: nada local, 500 com o que permite reconciliar e sem a mensagem do banco', async () => {
    registro = { data: null, error: { code: 'P0001', message: 'Ator x não pertence à organização y — evento de auditoria recusado' } };

    const resposta = await faturar();
    const corpo = await resposta.json();

    expect(resposta.status).toBe(500);
    expect(corpo).toMatchObject({ success: false, compensation_required: true, bling_nfe_id: '777', numero: '1002' });
    expect(JSON.stringify(corpo)).not.toMatch(/auditoria recusado|pertence/);
    expect(createNfeMock).toHaveBeenCalledTimes(1);
  });
});
