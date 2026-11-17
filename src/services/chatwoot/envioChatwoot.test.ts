import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';
import { listarEnviosDaConversa, RegistroDeEnvioIndisponivel } from './envioChatwoot';

const scope = { organizationId: 'e0080000-0000-4000-8000-00000000000a', actorId: 'e0080000-0000-4000-8000-0000000000a1' } as VerifiedOrganizationScope;

function respondendo(data: unknown): SupabaseClient {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    order: () => cadeia,
    limit: async () => ({ data, error: null }),
  };
  return { from: () => cadeia } as unknown as SupabaseClient;
}

describe('listarEnviosDaConversa', () => {
  it('linha fora do formato esperado é indisponibilidade tipada, não exceção solta', async () => {
    await expect(listarEnviosDaConversa(respondendo([{ id: 1 }]), scope, 'e0080000-0000-4000-8000-0000000000d1'))
      .rejects.toBeInstanceOf(RegistroDeEnvioIndisponivel);
  });
  it('exibe a invalidação de autorresposta registrada na outbox', async () => {
    const supabase = respondendo([{
      id: 'envio', command_id: 'comando', conteudo: 'sintético', mensagem_id_local: null,
      invalidado_em: null, created_at: '2026-11-16T00:00:00Z',
      outbox_eventos: {
        status: 'dead_letter', motivo_bloqueio: null, resolucao: null, last_error: 'autorresposta_invalidada',
      },
    }]);
    const [envio] = await listarEnviosDaConversa(supabase, scope, 'e0080000-0000-4000-8000-0000000000d1');
    expect(envio).toMatchObject({
      estado: 'invalidado',
      explicacao: 'Resposta automática invalidada pela política antes do envio.',
    });
  });});
