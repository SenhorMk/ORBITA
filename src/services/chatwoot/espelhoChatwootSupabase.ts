import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
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

    async atualizar(recurso, escopo, idLocal, campos, opcoes) {
      if (!escopoValido(escopo) || !uuid.safeParse(idLocal).success) return falhou('escopo_invalido');
      const filtro = supabase
        .from(TABELA_DO_RECURSO[recurso])
        .update(campos)
        .eq('organizacao_id', escopo.organizacaoId)
        .eq('id_local', idLocal);
      const { data, error } = await (opcoes?.somenteConexaoProvada
        ? filtro.eq('conexao_id', escopo.conexaoId)
        : filtro.or(daConexaoOuLegado(escopo))
      ).select('id_local');
      if (error) return falhou(error.code);
      return { _tag: 'StoreOk', valor: Array.isArray(data) ? data.length : 0 };
    },
  };
}
