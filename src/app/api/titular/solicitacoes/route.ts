import { supabaseServer } from '@/lib/supabaseServer';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { VERIFICATION_CHALLENGE_TTL_MINUTES } from '@/services/privacy/titularVerificationService';
import { createTitularIntakeHandlers, type IntakePort } from './handlers';

export const dynamic = 'force-dynamic';

/** SLA técnico default de confirmação — needs-owner se o prazo jurídico
 * exato por tipo de direito for diferente (ver ADR seção "Lacunas
 * jurídicas", item 5). */
const SLA_DIAS_DEFAULT = 15;

const supabasePort: IntakePort = {
  resolveSessionOrganizationContext: (request) => resolveActiveRequestOrganizationContext(request),

  async findClienteIdByEmail(organizationId, email) {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('id')
      .eq('organizacao_id', organizationId)
      .eq('email', email)
      .maybeSingle();
    if (error) throw new Error(`Falha ao consultar cliente: ${error.message}`);
    return data?.id ?? null;
  },

  async registerRequest(params) {
    const slaVencimento = new Date(Date.now() + SLA_DIAS_DEFAULT * 24 * 60 * 60 * 1000).toISOString();
    const idempotencyWindow = new Date().toISOString().slice(0, 10); // janela diária
    const idempotencyKey = `${params.titularTipo}-${params.titularRefUserId ?? params.titularRefClienteId}-${params.tipoDireito}-${idempotencyWindow}`;

    const { data, error } = await supabaseServer.rpc('registrar_solicitacao_titular', {
      p_organizacao_id: params.organizationId,
      p_titular_tipo: params.titularTipo,
      p_titular_ref_user_id: params.titularRefUserId,
      p_titular_ref_cliente_id: params.titularRefClienteId,
      p_titular_contato_cifrado: null,
      p_tipo_direito: params.tipoDireito,
      p_canal: 'web',
      p_sla_vencimento: slaVencimento,
      p_idempotency_key: idempotencyKey,
      p_correlation_id: params.correlationId,
      p_metadata: {},
    });
    if (error) throw new Error(`Falha ao registrar solicitação do titular: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    return { requestId: row.solicitacao_id, isDuplicate: Boolean(row.is_duplicate) };
  },
};

const handlers = createTitularIntakeHandlers({ port: supabasePort });

/** Intake de solicitação de direitos do titular. Resposta sempre genérica —
 * ver `handlers.ts`. `VERIFICATION_CHALLENGE_TTL_MINUTES` documenta a janela
 * de verificação usada pela etapa seguinte (emissão do desafio), ainda não
 * disparada automaticamente aqui (needs-owner: canal de envio, ver ADR). */
void VERIFICATION_CHALLENGE_TTL_MINUTES;

export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
