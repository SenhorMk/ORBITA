import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { conexaoDesligada } from '../../lib/integrations/conexaoDesligada';
import { verifyOrganizationScope } from '../../lib/verifiedOrganizationScope';
import type { DesfechoDoDespacho } from '../outbox/desfechoDoEfeito';
import { ChatwootAdapter } from './chatwootAdapter';
import type { EnvioReivindicado, MensagemDoRecibo, PortaDoConsumidorEnvio, ResolucaoDoCanal } from './consumidorEnvioChatwoot';

const ReivindicadoSchema = z.object({
  evento_id: z.string().uuid(),
  organizacao_id: z.string().uuid(),
  conexao_id: z.string().uuid(),
  envio_id: z.string().uuid(),
  ator_id: z.string().uuid().nullable(),
  conversa_id_externo: z.string().regex(/^[1-9][0-9]{0,9}$/u).transform(Number),
  conteudo: z.string().min(1),
  correlation_id: z.string().nullable(),
  fencing_token: z.coerce.number().int().positive(),
});

const ConclusaoSchema = z.array(z.object({ status: z.string().nullable() }));

/**
 * Os parâmetros da conclusão por desfecho, como na outbox; nada é inventado.
 * O `erro` é texto fixo do adapter/consumidor (nunca corpo do provedor),
 * validado pelo schema do desfecho.
 */
function parametrosDoDesfecho(desfecho: DesfechoDoDespacho) {
  switch (desfecho._tag) {
    case 'Confirmado':
      return { p_desfecho: 'confirmado', p_recibo_ref: desfecho.recibo };
    case 'NaoEnviado':
      return { p_desfecho: 'nao_enviado', p_motivo: desfecho.prova, p_erro: desfecho.erro, p_categoria: 'transient', p_retry_delay_sec: desfecho.retryAfterSeconds ?? 10 };
    case 'Recusado':
      return { p_desfecho: 'recusado', p_motivo: desfecho.codigo, p_erro: desfecho.erro, p_categoria: desfecho.categoria };
    case 'Desconhecido':
      return { p_desfecho: 'desconhecido', p_motivo: desfecho.motivo, p_erro: desfecho.erro, p_categoria: 'transient' };
  }
}

/**
 * A porta real: as RPCs do MSG-008 e o adapter da conexão do envio. O cliente é
 * `service_role`, que ignora RLS; cada RPC filtra pelo evento reivindicado, e
 * o canal é resolvido pelo vínculo persistido do autor, não por dado do evento.
 */
export function criarPortaDoConsumidorEnvio(supabase: SupabaseClient): PortaDoConsumidorEnvio {
  return {
    async liberarLeasesVencidas() {
      const { data, error } = await supabase.rpc('liberar_leases_expirados_outbox');
      if (error) throw new Error('Falha ao liberar leases vencidas da outbox.');
      return Array.isArray(data) ? data.length : 0;
    },

    async reivindicar({ workerId, limite, leaseSegundos, criadosDesde }) {
      const { data, error } = await supabase.rpc('reivindicar_envios_chatwoot', {
        p_worker_id: workerId,
        p_limit: limite,
        p_lease_ttl_sec: leaseSegundos,
        p_criados_desde: criadosDesde,
      });
      if (error) throw new Error('Falha ao reivindicar envios do Chatwoot.');
      return ReivindicadoSchema.array().parse(data ?? []).map((linha): EnvioReivindicado => ({
        eventoId: linha.evento_id,
        organizacaoId: linha.organizacao_id,
        conexaoId: linha.conexao_id,
        envioId: linha.envio_id,
        atorId: linha.ator_id,
        conversaIdExterno: linha.conversa_id_externo,
        conteudo: linha.conteudo,
        correlationId: linha.correlation_id,
        fencingToken: linha.fencing_token,
      }));
    },

    async resolverCanal(envio): Promise<ResolucaoDoCanal> {
      if (envio.atorId === null) return { _tag: 'SemVinculo' };
      const verificado = await verifyOrganizationScope(supabase, { organizationId: envio.organizacaoId, actorId: envio.atorId });
      if (verificado._tag === 'OrganizationScopeStoreUnavailable') throw new Error('Vínculo indisponível.');
      if (verificado._tag === 'OrganizationScopeDenied') return { _tag: 'SemVinculo' };
      // Lido aqui, com o erro conferido: `forScope` trata falha de leitura como "não
      // configurado", e isso recusaria para sempre uma resposta que nunca saiu.
      const { data: conexao, error } = await supabase
        .from('conexoes_integracao')
        .select('status')
        .eq('organizacao_id', envio.organizacaoId)
        .eq('id', envio.conexaoId)
        .eq('provedor', 'chatwoot')
        .maybeSingle();
      if (error) throw new Error('Conexão indisponível.');
      if (!conexao || conexaoDesligada(conexao.status)) return { _tag: 'NaoConfigurado' };
      const adapter = await ChatwootAdapter.forScope(verificado.scope, envio.conexaoId);
      if (!adapter || adapter.conexaoId !== envio.conexaoId) return { _tag: 'NaoConfigurado' };
      return { _tag: 'Canal', canal: adapter };
    },

    async iniciarDespacho(posse) {
      const { data, error } = await supabase.rpc('iniciar_despacho_outbox', {
        p_evento_id: posse.eventoId,
        p_worker_id: posse.workerId,
        p_fencing_token: posse.fencingToken,
      });
      if (error) throw new Error('Falha ao iniciar o despacho.');
      return data === true;
    },

    async concluir(posse, desfecho, mensagem: MensagemDoRecibo | null) {
      const { data, error } = await supabase.rpc('concluir_envio_chatwoot', {
        p_evento_id: posse.eventoId,
        p_worker_id: posse.workerId,
        p_fencing_token: posse.fencingToken,
        ...parametrosDoDesfecho(desfecho),
        p_mensagem: mensagem && {
          remetente_nome: mensagem.remetenteNome,
          remetente_id: mensagem.remetenteId,
          remetente_tipo: mensagem.remetenteTipo,
          criada_em: mensagem.criadaEm,
        },
      });
      if (error) throw new Error('Falha ao concluir o envio.');
      return ConclusaoSchema.parse(data ?? [])[0]?.status ?? null;
    },
  };
}
