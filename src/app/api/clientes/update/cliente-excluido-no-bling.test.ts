import { describe, expect, it } from 'vitest';

import {
  createClienteUpdateHandler,
  type ClienteBlingPort,
  type ClienteStorePort,
} from './handler';
import { buildClienteRequest } from '@/lib/config/clienteContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/**
 * PRE-005: editar um contato excluído no Bling faria um `PUT` que o reativaria
 * por fora da reconciliação. A recusa vem antes de qualquer envio e de
 * qualquer gravação.
 */

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', role: 'owner' } as unknown as VerifiedOrganizationScope;

function montar(excluidos: readonly string[]) {
  const enviados: string[] = [];
  const gravados: string[] = [];
  const consultados: Array<{ org: string; blingId: string }> = [];
  const bling: ClienteBlingPort = {
    async criar() { enviados.push('POST'); return { _tag: 'BlingOk', value: { id: '5150' } }; },
    async atualizar(id) { enviados.push(`PUT ${id}`); return { _tag: 'BlingOk', value: undefined }; },
  };
  const store: ClienteStorePort = {
    async upsert(_s, c) { gravados.push(c.blingId); return { id: 'local-1', blingId: c.blingId, nome: c.nome }; },
    async exclusaoVigenteNoBling(s, blingId) { consultados.push({ org: s.organizationId, blingId }); return excluidos.includes(blingId); },
  };
  const handler = createClienteUpdateHandler({ auth: { async authorize() { return { _tag: 'Authorized', scope }; } }, bling, store });
  return { handler, enviados, gravados, consultados };
}

const pedido = (corpo: unknown) => new Request('https://orbita.test/api/clientes/update', { method: 'POST', body: JSON.stringify(corpo) });
const edicao = (blingId: string) => buildClienteRequest({ nome: 'Ana Souza', tipo: 'F', indicadorIe: 9, blingId, id: '33333333-3333-4333-8333-333333333333' });

describe('edição de contato excluído no Bling (PRE-005)', () => {
  it('recusa com 409 antes de qualquer PUT ou gravação', async () => {
    const { handler, enviados, gravados, consultados } = montar(['4321']);

    const resposta = await handler(pedido(edicao('4321')));

    expect(resposta.status).toBe(409);
    expect((await resposta.json()).error).toContain('excluído no Bling');
    expect(enviados).toEqual([]);
    expect(gravados).toEqual([]);
    expect(consultados).toEqual([{ org: scope.organizationId, blingId: '4321' }]);
  });

  it('contato sem exclusão vigente segue a edição normal', async () => {
    const { handler, enviados, gravados } = montar([]);

    const resposta = await handler(pedido(edicao('4321')));

    expect(resposta.status).toBe(200);
    expect(enviados).toEqual(['PUT 4321']);
    expect(gravados).toEqual(['4321']);
  });
});
