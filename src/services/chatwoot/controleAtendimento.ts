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
  | { readonly _tag: 'AutomacaoInativa' }
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
    'sem_vinculo', 'sem_capacidade', 'conversa_inexistente', 'automacao_inativa',
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
    case 'automacao_inativa': return { _tag: 'AutomacaoInativa' };
  }
}

const LinhaLidaSchema = z.discriminatedUnion('resultado', [
  z.object({
    resultado: z.literal('encontrada'),
    ownership_mode: z.enum(MODOS_DE_ATENDIMENTO),
    responsavel_id: z.string().uuid().nullable(),
    control_version: versao,
  }),
  z.object({ resultado: z.literal('conversa_inexistente') }),
]);

export type LeituraDoControle =
  | { readonly _tag: 'Encontrado'; readonly controle: ControleDaConversa }
  | { readonly _tag: 'ConversaNaoEncontrada' };

/**
 * O controle vigente, lido pelo banco com a regra das escritas: conversa de
 * outra organização (ou inexistente) não tem estado; sem linha, aguarda
 * humano, versão 0; dono que saiu da organização não aparece como dono.
 */
export async function lerControle(
  supabase: SupabaseClient,
  scope: VerifiedOrganizationScope,
  conversaId: string,
): Promise<LeituraDoControle> {
  const { data, error } = await supabase.rpc('ler_controle_atendimento_chatwoot', {
    p_organizacao_id: scope.organizationId,
    p_conversa_id_local: conversaId,
  });
  if (error) throw new ControleIndisponivel();
  const lido = LinhaLidaSchema.safeParse(Array.isArray(data) ? data[0] : data);
  if (!lido.success) throw new ControleIndisponivel();
  if (lido.data.resultado === 'conversa_inexistente') return { _tag: 'ConversaNaoEncontrada' };
  return {
    _tag: 'Encontrado',
    controle: controle(scope, lido.data.ownership_mode, lido.data.responsavel_id, lido.data.control_version),
  };
}

/** Por que a pessoa não pode devolver esta conversa agora (null: pode). */
export type MotivoSemDevolver = 'nao_e_responsavel' | 'sem_capacidade' | 'automacao_inativa';

export interface PermissoesDoControle {
  readonly devolver: boolean;
  readonly motivoSemDevolver: MotivoSemDevolver | null;
  readonly automacaoAtiva: boolean;
}

/**
 * O que a tela pode oferecer, derivado do escopo verificado: ser responsável
 * não é poder gerenciar, e devolver à automação não vale sem automação ativa.
 * A rota e a RPC conferem tudo de novo; isto só evita oferecer o que seria
 * recusado.
 */
export function permissoesDoControle(
  conversa: ControleDaConversa,
  podeGerenciar: boolean,
  automacaoAtiva: boolean,
): PermissoesDoControle {
  const motivo = motivoSemDevolver(conversa, podeGerenciar, automacaoAtiva);
  return { devolver: motivo === null, motivoSemDevolver: motivo, automacaoAtiva };
}

function motivoSemDevolver(conversa: ControleDaConversa, podeGerenciar: boolean, automacaoAtiva: boolean): MotivoSemDevolver | null {
  if (!(conversa.modo === 'HUMAN' && conversa.souResponsavel)) return 'nao_e_responsavel';
  if (!podeGerenciar) return 'sem_capacidade';
  if (!automacaoAtiva) return 'automacao_inativa';
  return null;
}

const DevolucaoSchema = z.array(z.object({ created_at: z.string().datetime({ offset: true }) })).max(1);

/**
 * Instante da última devolução à automação (handback) na conversa, ou `null`.
 * O atendente resolveu o que veio antes e deixou o resumo; a IA retoma só a
 * partir daí (a mesma regra de `ai_contexto_worker`). `iniciar_ia` não conta:
 * ali ninguém atendeu, e as mensagens pendentes continuam sendo pedido.
 * Leitura com service role: organização e conversa explícitas no filtro.
 */
export async function lerUltimaDevolucaoDaConversa(
  supabase: SupabaseClient,
  organizacaoId: string,
  conversaId: string,
): Promise<string | null> {
  const uuid = z.string().uuid();
  if (!uuid.safeParse(organizacaoId).success || !uuid.safeParse(conversaId).success) throw new ControleIndisponivel();
  const { data, error } = await supabase
    .from('chatwoot_controle_historico')
    .select('created_at')
    .eq('organizacao_id', organizacaoId)
    .eq('conversa_id_local', conversaId)
    .eq('acao', 'devolver')
    .order('created_at', { ascending: false })
    .limit(1);
  const linhas = DevolucaoSchema.safeParse(data ?? []);
  if (error || !linhas.success) throw new ControleIndisponivel();
  return linhas.data[0]?.created_at ?? null;
}

const ModoSchema = z.object({ ownership_mode: z.enum(MODOS_DE_ATENDIMENTO) }).nullable();

/**
 * Modo persistido da conversa, para o worker confirmar uma transferência
 * cujo resultado foi ambíguo (ACK perdido, geração obsoleta). Só leitura, com
 * service role: organização e conversa explícitas no filtro.
 */
export async function lerModoDoAtendimento(
  supabase: SupabaseClient,
  organizacaoId: string,
  conversaId: string,
): Promise<ModoDeAtendimento | null> {
  const uuid = z.string().uuid();
  if (!uuid.safeParse(organizacaoId).success || !uuid.safeParse(conversaId).success) throw new ControleIndisponivel();
  const { data, error } = await supabase
    .from('chatwoot_conversa_controle')
    .select('ownership_mode')
    .eq('organizacao_id', organizacaoId)
    .eq('conversa_id_local', conversaId)
    .maybeSingle();
  const linha = ModoSchema.safeParse(data ?? null);
  if (error || !linha.success) throw new ControleIndisponivel();
  return linha.data?.ownership_mode ?? null;
}
