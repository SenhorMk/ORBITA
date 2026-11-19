import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import {
  TABELA_DO_RECURSO,
  type CandidatoDeIdentidade,
  type EscopoDaConexaoChatwoot,
  type EspelhoChatwootStore,
  type ResultadoDoStore,
} from '@/services/chatwoot/identidadeChatwoot';

/**
 * Store dos espelhos do Chatwoot sobre o cliente `service_role`. A RLS não
 * protege aqui: toda consulta e toda escrita filtram a organização e a
 * conexão do escopo verificado. Os UUIDs do escopo entram num filtro `or`,
 * então são validados antes de chegar à query.
 */

const uuid = z.string().uuid();
const CandidatoSchema = z.object({ id_local: z.string().uuid(), conexao_id: z.string().uuid().nullable() });
const IdLocalSchema = z.object({ id_local: z.string().uuid() });
const IdExternoSchema = z.object({ id_externo: z.string().regex(/^\d+$/u) });
const ConexaoSchema = z.object({ conexao_id: z.string().uuid().nullable() });
const MensagensDoContatoSchema = z.array(z.object({
  id_local: z.string().uuid(), content: z.string().nullable(), created_at: z.string(),
  conteudo_revisao_em: z.string().nullable(),
}));

export async function lerMensagensRecentesDoContato(
  supabase: SupabaseClient, escopo: VerifiedOrganizationScope, conversaId: string,
) {
  const conexao = await criarEspelhoChatwootSupabase(supabase)
    .buscarConexaoPorIdLocal('conversa', escopo.organizationId, conversaId);
  if (conexao._tag === 'StoreFalhou') throw new Error('Conversa indisponível.');
  if (!conexao.valor?.conexaoId) return [];
  const { data, error } = await supabase.from(TABELA_DO_RECURSO.mensagem)
    .select('id_local,content,created_at,conteudo_revisao_em')
    .eq('organizacao_id', escopo.organizationId).eq('conexao_id', conexao.valor.conexaoId)
    .eq('conversa_id_local', conversaId).eq('message_type', 'incoming').eq('sender_type', 'contact')
    .order('created_at', { ascending: false }).order('id_local', { ascending: false }).limit(5);
  if (error) throw new Error('Histórico indisponível.');
  return MensagensDoContatoSchema.parse(data).reverse();
}

function falhou<T>(codigo: string | undefined): ResultadoDoStore<T> {
  return { _tag: 'StoreFalhou', codigo };
}

function escopoValido(escopo: EscopoDaConexaoChatwoot): boolean {
  return uuid.safeParse(escopo.organizacaoId).success && uuid.safeParse(escopo.conexaoId).success;
}

/** A conexão do escopo, ou linha legada ainda sem conexão provada. */
function daConexaoOuLegado(escopo: EscopoDaConexaoChatwoot): string {
  return `conexao_id.eq.${escopo.conexaoId},conexao_id.is.null`;
}

export function criarEspelhoChatwootSupabase(supabase: SupabaseClient): EspelhoChatwootStore {
  return {
    async buscarPorIdExterno(recurso, escopo, idExterno) {
      if (!escopoValido(escopo)) return falhou('escopo_invalido');
      const { data, error } = await supabase
        .from(TABELA_DO_RECURSO[recurso])
        .select('id_local, conexao_id')
        .eq('organizacao_id', escopo.organizacaoId)
        .eq('id_externo', idExterno)
        .or(daConexaoOuLegado(escopo));
      if (error) return falhou(error.code);
      const linhas = z.array(CandidatoSchema).safeParse(data ?? []);
      if (!linhas.success) return falhou('resposta_invalida');
      const candidatos: CandidatoDeIdentidade[] = linhas.data.map((l) => ({ idLocal: l.id_local, conexaoId: l.conexao_id }));
      return { _tag: 'StoreOk', valor: candidatos };
    },

    async buscarConexaoPorIdLocal(recurso, organizacaoId, idLocal) {
      if (!uuid.safeParse(organizacaoId).success || !uuid.safeParse(idLocal).success) return falhou('escopo_invalido');
      const { data, error } = await supabase
        .from(TABELA_DO_RECURSO[recurso])
        .select('conexao_id')
        .eq('organizacao_id', organizacaoId)
        .eq('id_local', idLocal)
        .maybeSingle();
      if (error) return falhou(error.code);
      if (data === null) return { _tag: 'StoreOk', valor: null };
      const linha = ConexaoSchema.safeParse(data);
      return linha.success ? { _tag: 'StoreOk', valor: { conexaoId: linha.data.conexao_id } } : falhou('resposta_invalida');
    },

    async buscarPorIdLocal(recurso, escopo, idLocal) {
      if (!escopoValido(escopo) || !uuid.safeParse(idLocal).success) return falhou('escopo_invalido');
      // Sem o caso legado: traduzir para o id remoto exige a conexão provada.
      const { data, error } = await supabase
        .from(TABELA_DO_RECURSO[recurso])
        .select('id_externo')
        .eq('organizacao_id', escopo.organizacaoId)
        .eq('conexao_id', escopo.conexaoId)
        .eq('id_local', idLocal)
        .maybeSingle();
      if (error) return falhou(error.code);
      if (data === null) return { _tag: 'StoreOk', valor: null };
      const linha = IdExternoSchema.safeParse(data);
      return linha.success ? { _tag: 'StoreOk', valor: linha.data.id_externo } : falhou('resposta_invalida');
    },

    async inserir(recurso, linha) {
      const { data, error } = await supabase.from(TABELA_DO_RECURSO[recurso]).insert(linha).select('id_local').single();
      if (error) return falhou(error.code);
      const inserida = IdLocalSchema.safeParse(data);
      return inserida.success ? { _tag: 'StoreOk', valor: inserida.data.id_local } : falhou('resposta_invalida');
    },

    async atualizar(recurso, escopo, idLocal, campos) {
      if (!escopoValido(escopo) || !uuid.safeParse(idLocal).success) return falhou('escopo_invalido');
      const { data, error } = await supabase
        .from(TABELA_DO_RECURSO[recurso])
        .update(campos)
        .eq('organizacao_id', escopo.organizacaoId)
        .eq('id_local', idLocal)
        .or(daConexaoOuLegado(escopo))
        .select('id_local');
      if (error) return falhou(error.code);
      return { _tag: 'StoreOk', valor: Array.isArray(data) ? data.length : 0 };
    },
  };
}
