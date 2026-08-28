import { describe, expect, it } from 'vitest';
import { createTitularIntakeHandlers, type IntakePort } from './handlers';
import type { OrganizationContextResult } from '@/lib/organizationAuthorization';

class FakeIntakePort implements IntakePort {
  sessionResult: OrganizationContextResult = { _tag: 'SessionMissing' } as OrganizationContextResult;
  clienteIdByEmail = new Map<string, string>();
  registeredCalls: Array<Parameters<IntakePort['registerRequest']>[0]> = [];
  nextRequestId = 'req-1';

  async resolveSessionOrganizationContext(): Promise<OrganizationContextResult> {
    return this.sessionResult;
  }
  async findClienteIdByEmail(organizationId: string, email: string) {
    return this.clienteIdByEmail.get(`${organizationId}:${email}`) ?? null;
  }
  async registerRequest(params: Parameters<IntakePort['registerRequest']>[0]) {
    this.registeredCalls.push(params);
    return { requestId: this.nextRequestId, isDuplicate: false };
  }
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/titular/solicitacoes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('titular intake handlers — generic confirmation, never reveals existence', () => {
  it('returns the exact same confirmation whether or not the cliente_final email matches a record', async () => {
    const port = new FakeIntakePort();
    port.clienteIdByEmail.set('11111111-1111-4111-8111-111111111111:known@example.com', 'cliente-1');
    const handlers = createTitularIntakeHandlers({ port });

    const resMatch = await handlers.POST(
      jsonRequest({
        titularTipo: 'cliente_final',
        tipoDireito: 'acesso',
        organizacaoId: '11111111-1111-4111-8111-111111111111',
        clienteEmail: 'known@example.com',
      }),
    );
    const resNoMatch = await handlers.POST(
      jsonRequest({
        titularTipo: 'cliente_final',
        tipoDireito: 'acesso',
        organizacaoId: '11111111-1111-4111-8111-111111111111',
        clienteEmail: 'unknown@example.com',
      }),
    );

    const bodyMatch = await resMatch.json();
    const bodyNoMatch = await resNoMatch.json();
    expect(resMatch.status).toBe(200);
    expect(resNoMatch.status).toBe(200);
    expect(bodyMatch).toEqual(bodyNoMatch);
  });

  it('only registers a request internally when the cliente_final email actually matches', async () => {
    const port = new FakeIntakePort();
    port.clienteIdByEmail.set('11111111-1111-4111-8111-111111111111:known@example.com', 'cliente-1');
    const handlers = createTitularIntakeHandlers({ port });

    await handlers.POST(
      jsonRequest({
        titularTipo: 'cliente_final',
        tipoDireito: 'acesso',
        organizacaoId: '11111111-1111-4111-8111-111111111111',
        clienteEmail: 'known@example.com',
      }),
    );
    await handlers.POST(
      jsonRequest({
        titularTipo: 'cliente_final',
        tipoDireito: 'acesso',
        organizacaoId: '11111111-1111-4111-8111-111111111111',
        clienteEmail: 'unknown@example.com',
      }),
    );

    expect(port.registeredCalls).toHaveLength(1);
    expect(port.registeredCalls[0].titularRefClienteId).toBe('cliente-1');
  });

  it('for lojista_user, titular is always the authenticated session actor — never a client-supplied id', async () => {
    const port = new FakeIntakePort();
    port.sessionResult = {
      _tag: 'OrganizationContextResolved',
      context: {
        actorId: 'session-user-1',
        organizationId: 'org-1',
      },
    } as unknown as OrganizationContextResult;
    const handlers = createTitularIntakeHandlers({ port });

    await handlers.POST(
      jsonRequest({
        titularTipo: 'lojista_user',
        tipoDireito: 'acesso',
        // campos extras tentando forjar outro titular são ignorados pelo schema/handler
        titularRefUserId: 'attacker-controlled-id',
      }),
    );

    expect(port.registeredCalls).toHaveLength(1);
    expect(port.registeredCalls[0].titularRefUserId).toBe('session-user-1');
    expect(port.registeredCalls[0].organizationId).toBe('org-1');
  });

  it('returns the generic confirmation (never a 401 detail) when there is no session for lojista_user', async () => {
    const port = new FakeIntakePort();
    port.sessionResult = { _tag: 'SessionMissing' } as OrganizationContextResult;
    const handlers = createTitularIntakeHandlers({ port });

    const res = await handlers.POST(jsonRequest({ titularTipo: 'lojista_user', tipoDireito: 'acesso' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(port.registeredCalls).toHaveLength(0);
  });

  it('rejects a malformed body with 400', async () => {
    const port = new FakeIntakePort();
    const handlers = createTitularIntakeHandlers({ port });
    const res = await handlers.POST(jsonRequest({ titularTipo: 'nao-existe' }));
    expect(res.status).toBe(400);
  });
});
