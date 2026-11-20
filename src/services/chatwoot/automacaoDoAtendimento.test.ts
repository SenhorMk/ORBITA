import { createClient } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyOrganizationScope } from '../../lib/verifiedOrganizationScope';
import { automacaoDoAtendimentoAtiva } from './automacaoDoAtendimento';

afterEach(() => vi.unstubAllEnvs());

it.each([{ rpc: true, esperada: true }, { rpc: false, esperada: false }, { rpc: null, esperada: false }])(
  'devolução segue a autorização durável e falha fechada: $rpc', async ({ rpc, esperada }) => {
  vi.stubEnv('CHATWOOT_AI_FIRST_ENABLED', '');
  const client = createClient('https://ci-test.supabase.co', 'ci-test-public-key-not-a-secret', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/membros_organizacao')) return Response.json({ papel: 'owner' });
      return rpc === null ? Response.json({ message: 'Fixture indisponível' }, { status: 503 }) : Response.json(rpc);
    } },
  });
  const verificado = await verifyOrganizationScope(client, {
    organizationId: 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f', actorId: '1151545f-d4ee-4043-88a9-d1f05c76f504',
  });
  if (verificado._tag !== 'OrganizationScopeVerified') throw new Error('Fixture sem escopo verificado');
  expect(await automacaoDoAtendimentoAtiva(client, verificado.scope, 'd2200000-0000-4000-8000-000000000001')).toBe(esperada);
});
