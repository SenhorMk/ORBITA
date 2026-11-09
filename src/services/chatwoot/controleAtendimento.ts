/**
 * Quem responde a conversa (MSG-009), do lado da requisição.
 *
 * `AI` (a automação pode responder), `HUMAN_REQUIRED` (ninguém responde até
 * um atendente assumir) e `HUMAN` (um atendente responde). Cada mudança passa
 * por `alterar_controle_atendimento_chatwoot`, com compare-and-set na versão:
 * duas abas ou duas pessoas não mudam o mesmo estado, e cada mudança invalida
 * no banco os envios ainda na fila. Organização e ator vêm do escopo
 * verificado; a regra é do banco.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { VerifiedOrganizationScope } from '../../lib/verifiedOrganizationScope';

export const MODOS_DE_ATENDIMENTO = ['AI', 'HUMAN_REQUIRED', 'HUMAN'] as const;
export type ModoDeAtendimento = (typeof MODOS_DE_ATENDIMENTO)[number];
export type AcaoDeControle = 'assumir' | 'devolver' | 'exigir_humano';

export interface ControleDaConversa {
  readonly modo: ModoDeAtendimento;
  readonly responsavelId: string | null;
  readonly souResponsavel: boolean;
  readonly versao: number;
}

export type ResultadoDoControle =
  | {
      readonly _tag: 'Aplicado';
      readonly duplicado: boolean;
      readonly controle: ControleDaConversa;
      readonly invalidados: number;
      readonly emVoo: number;
      readonly notaRegistrada: boolean;
    }
  | { readonly _tag: 'ConflitoDeVersao'; readonly controle: ControleDaConversa }
  | { readonly _tag: 'TransicaoInvalida'; readonly controle: ControleDaConversa }
  | { readonly _tag: 'ConflitoDeComando' }
  | { readonly _tag: 'ConversaNaoEncontrada' }
  | { readonly _tag: 'SemVinculo' }
  | { readonly _tag: 'SemCapacidade' };

export class ControleIndisponivel extends Error {
  constructor() {
    super('Não foi possível ler ou alterar o controle do atendimento.');
    this.name = 'ControleIndisponivel';
  }
}

const versao = z.coerce.number().int().nonnegative();

const LinhaDoControleSchema = z.object({
  resultado: z.enum([
    'aplicado', 'existente', 'conflito_versao', 'conflito_comando', 'transicao_invalida',
    'sem_vinculo', 'sem_capacidade', 'conversa_inexistente',
  ]),
  ownership_mode: z.enum(MODOS_DE_ATENDIMENTO).nullable(),
  responsavel_id: z.string().uuid().nullable(),
  control_version: versao.nullable(),
  invalidados: z.coerce.number().int().nonnegative(),
  em_voo: z.coerce.number().int().nonnegative(),
  nota_envio_id: z.string().uuid().nullable(),
});

function controle(scope: VerifiedOrganizationScope, modo: ModoDeAtendimento, responsavelId: string | null, v: number): ControleDaConversa {
  return { modo, responsavelId, souResponsavel: responsavelId !== null && responsavelId === scope.actorId, versao: v };
}

export async function alterarControle(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  comando: {
    readonly conversaId: string;
    readonly commandId: string;
    readonly acao: AcaoDeControle;
    readonly versaoEsperada: number;
    readonly nota: string | null;
  },
): Promise<ResultadoDoControle> {
  const { data, error } = await supabase.rpc('alterar_controle_atendimento_chatwoot', {
    p_organizacao_id: scope.organizationId,
    p_ator_id: scope.actorId,
    p_conversa_id_local: comando.conversaId,
    p_command_id: comando.commandId,
    p_acao: comando.acao,
    p_versao_esperada: comando.versaoEsperada,
    p_nota: comando.nota,
  });
  if (error) throw new ControleIndisponivel();
  const lido = LinhaDoControleSchema.safeParse(Array.isArray(data) ? data[0] : data);
  if (!lido.success) throw new ControleIndisponivel();
  const linha = lido.data;

  const atual = () => {
    if (linha.ownership_mode === null || linha.control_version === null) throw new ControleIndisponivel();
    return controle(scope, linha.ownership_mode, linha.responsavel_id, linha.control_version);
  };

  switch (linha.resultado) {
    case 'aplicado':
    case 'existente':
      return {
        _tag: 'Aplicado',
        duplicado: linha.resultado === 'existente',
        controle: atual(),
        invalidados: linha.invalidados,
        emVoo: linha.em_voo,
        notaRegistrada: linha.nota_envio_id !== null,
      };
    case 'conflito_versao': return { _tag: 'ConflitoDeVersao', controle: atual() };
    case 'transicao_invalida': return { _tag: 'TransicaoInvalida', controle: atual() };
    case 'conflito_comando': return { _tag: 'ConflitoDeComando' };
    case 'conversa_inexistente': return { _tag: 'ConversaNaoEncontrada' };
    case 'sem_vinculo': return { _tag: 'SemVinculo' };
    case 'sem_capacidade': return { _tag: 'SemCapacidade' };
  }
}

const LinhaLidaSchema = z.object({
  ownership_mode: z.enum(MODOS_DE_ATENDIMENTO),
  responsavel_id: z.string().uuid().nullable(),
  control_version: versao,
});

/**
 * O controle vigente. Sem linha, a conversa nunca mudou de controle: aguarda
 * humano, versão 0. O `service_role` ignora RLS: o filtro por organização é
 * que isola.
 */
export async function lerControle(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): Promise<ControleDaConversa> {
  const { data, error } = await supabase
    .from('chatwoot_conversa_controle')
    .select('ownership_mode, responsavel_id, control_version')
    .eq('organizacao_id', scope.organizationId)
    .eq('conversa_id_local', conversaId)
    .maybeSingle();
  if (error) throw new ControleIndisponivel();
  if (data === null) return controle(scope, 'HUMAN_REQUIRED', null, 0);
  const linha = LinhaLidaSchema.safeParse(data);
  if (!linha.success) throw new ControleIndisponivel();
  return controle(scope, linha.data.ownership_mode, linha.data.responsavel_id, linha.data.control_version);
}
