import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authorizeSignedServiceTenant,
  resolveAuthenticatedIdentity,
  type AuthenticatedUser,
  type AuthUserLookup,
} from './auth';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

function requestWithToken(): Request {
  return new Request('https://orbita.test/api/dashboard', {
    headers: { Authorization: 'Bearer signed-access-token' },
  });
}

function lookupReturning(user: AuthenticatedUser): AuthUserLookup {
  return {
    getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
  };
}

/**
 * Ticket 22, fatia C — os testes de `resolveActorContext` saíram com a função.
 *
 * Eles exercitavam a resolução de papel por `app_metadata.role`, com sessões
 * fabricadas em `{ role: 'dono' }` e `{ role: 'colaborador', tenant_id }`.
 * Nenhum fluxo deste sistema escreve esse campo, então o que eles provavam era o
 * comportamento de um modelo que ninguém alimentava. A cobertura equivalente,
 * contra a fonte real, vive em `requestOrganizationContext` e nas regressões de
 * rota que atravessam `membros_organizacao`.
 */

describe('resolveAuthenticatedIdentity', () => {
  it('distingue provedor indisponível de sessão inválida', async () => {
    const indisponivel = await resolveAuthenticatedIdentity(requestWithToken(), {
      getUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'upstream', status: 503, code: 'auth_provider_error' },
      }),
    });
    expect(indisponivel._tag).toBe('IdentityProviderUnavailable');

    const invalida = await resolveAuthenticatedIdentity(requestWithToken(), {
      getUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'bad jwt', status: 401 },
      }),
    });
    expect(invalida._tag).toBe('SessionInvalid');
  });

  it('devolve SessionMissing sem token, sem consultar o provedor', async () => {
    const getUser = vi.fn();
    const resultado = await resolveAuthenticatedIdentity(
      new Request('https://orbita.test/api/dashboard'),
      { getUser },
    );

    expect(resultado).toEqual({ _tag: 'SessionMissing' });
    expect(getUser).not.toHaveBeenCalled();
  });

  // O que a identidade responde é "quem é", e nada além. Papel e vínculo são de
  // outra fronteira — foi misturar as duas coisas que criou o Ticket 20.
  it('verifica a identidade sem olhar para papel em app_metadata', async () => {
    const resultado = await resolveAuthenticatedIdentity(
      requestWithToken(),
      lookupReturning({
        id: OWNER_ID,
        app_metadata: { provider: 'email', providers: ['email'], role: 'dono' },
      }),
    );

    expect(resultado).toEqual({
      _tag: 'IdentityVerified',
      user: {
        id: OWNER_ID,
        app_metadata: { provider: 'email', providers: ['email'], role: 'dono' },
      },
    });
  });
});

describe('authorizeSignedServiceTenant', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a tenant from a server mapping and a valid signature', () => {
    const rawBody = '{"event":"product.updated"}';
    const secret = 'provider-webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    const result = authorizeSignedServiceTenant(rawBody, signature, [{
      tenantId: TENANT_ID,
      secret,
    }]);

    expect(result).toMatchObject({
      _tag: 'ServiceTenantAuthorized',
      tenant: { id: TENANT_ID },
    });
  });

  it('denies invalid signatures and malformed server mappings', () => {
    expect(authorizeSignedServiceTenant('body', 'sha256=invalid', [{
      tenantId: TENANT_ID,
      secret: 'provider-webhook-secret',
    }])).toEqual({
      _tag: 'ServiceTenantDenied',
    });
    expect(authorizeSignedServiceTenant('body', 'sha256=invalid', [{
      tenantId: 'tenant-from-payload',
      secret: 'provider-webhook-secret',
    }])).toEqual({
      _tag: 'ServiceTenantDenied',
    });
  });
});
