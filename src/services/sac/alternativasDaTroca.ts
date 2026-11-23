import { z } from 'zod';

import { escopoTemCapacidade, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { IDADE_MAXIMA_DO_ESPELHO_MS } from './retratoDoPedido';

const id = z.string().uuid();
const moeda = z.string().regex(/^[A-Z]{3}$/u);
const centavos = z.number().int().min(0).max(1_000_000_000);
const instante = z.iso.datetime({ offset: true });
const compatibilidade = z.strictObject({
  familia: z.string().min(1).max(80),
  variante: z.string().min(1).max(80),
  versao: z.string().min(1).max(80),
});

export const PedidoDeAlternativasSchema = z.strictObject({
  conversaId: id,
  pedidoId: id,
  itemId: id,
  quantidade: z.number().int().min(1).max(10_000),
  preferidoId: id.optional(),
});
export type PedidoDeAlternativas = z.infer<typeof PedidoDeAlternativasSchema>;

const candidato = z.strictObject({
  organizacaoId: id,
  produtoId: id,
  nome: z.string().min(1).max(180),
  situacao: z.enum(['ativo', 'inativo', 'arquivado']),
  disponivel: z.number().int().nonnegative().nullable(),
  precoCentavos: centavos.nullable(),
  moeda,
  precoSincronizadoEm: instante.nullable(),
  estoqueSincronizadoEm: instante.nullable(),
  compatibilidade: compatibilidade.nullable(),
});

export const FatosDasAlternativasSchema = z.strictObject({
  organizacaoId: id,
  conversaId: id,
  pedidoId: id,
  itemId: id,
  provaValidaAte: instante.nullable(),
  original: z.strictObject({
    produtoId: id,
    quantidade: z.number().int().min(1),
    precoCentavos: centavos,
    moeda,
    pedidoSincronizadoEm: instante.nullable(),
    compatibilidade: compatibilidade.nullable(),
  }),
  candidatos: z.array(candidato).max(500),
});

const alternativa = z.strictObject({
  produtoId: id,
  nome: z.string().min(1).max(180),
  quantidade: z.number().int().positive(),
  moeda,
  precoUnitarioCentavos: centavos,
  deltaTotalCentavos: z.number().int(),
  pontuacao: z.number().int().nonnegative(),
  razoes: z.array(z.enum(['compatibilidade_confirmada', 'delta_calculado', 'preferencia_informada'])).min(2).max(3),
  precoSincronizadoEm: instante,
  estoqueSincronizadoEm: instante,
});
export const AlternativasDaTrocaSchema = z.strictObject({ versao: z.literal(1), alternativas: z.array(alternativa).max(3) });
type Alternativa = z.infer<typeof alternativa>;
type Fatos = z.infer<typeof FatosDasAlternativasSchema>;
type Candidato = z.infer<typeof candidato>;

export interface LeitorDeFatosDasAlternativas {
  /** Fonte autorizada. Só devolve o item preso ao cliente de uma prova vigente e à conversa do escopo. */
  ler(escopo: VerifiedOrganizationScope, pedido: PedidoDeAlternativas): Promise<unknown>;
}

export type ResultadoDasAlternativas =
  | { readonly estado: 'ok'; readonly valor: z.infer<typeof AlternativasDaTrocaSchema> }
  | { readonly estado: 'sem_permissao' | 'entrada_invalida' | 'sem_prova' | 'dados_invalidos' | 'indisponivel' };

function atual(valor: string | null, agora: number): valor is string {
  if (valor === null) return false;
  const idade = agora - Date.parse(valor);
  return idade >= 0 && idade <= IDADE_MAXIMA_DO_ESPELHO_MS;
}

function avaliar(c: Candidato, original: Fatos['original'], pedido: PedidoDeAlternativas, agora: number): Alternativa | null {
  const perfil = c.compatibilidade;
  const referencia = original.compatibilidade;
  if (!perfil || !referencia || perfil.familia !== referencia.familia ||
      perfil.variante !== referencia.variante || perfil.versao !== referencia.versao) return null;
  if (c.produtoId === original.produtoId || c.situacao !== 'ativo' || c.disponivel === null ||
      c.disponivel < pedido.quantidade || c.precoCentavos === null || c.moeda !== original.moeda ||
      !atual(c.precoSincronizadoEm, agora) || !atual(c.estoqueSincronizadoEm, agora)) return null;

  const delta = (c.precoCentavos - original.precoCentavos) * pedido.quantidade;
  const preferido = c.produtoId === pedido.preferidoId;
  return {
    produtoId: c.produtoId, nome: c.nome, quantidade: pedido.quantidade, moeda: c.moeda,
    precoUnitarioCentavos: c.precoCentavos, deltaTotalCentavos: delta,
    pontuacao: Math.max(0, 1_000 - Math.abs(delta)) + (preferido ? 1_001 : 0),
    razoes: ['compatibilidade_confirmada', 'delta_calculado', ...(preferido ? ['preferencia_informada' as const] : [])],
    precoSincronizadoEm: c.precoSincronizadoEm, estoqueSincronizadoEm: c.estoqueSincronizadoEm,
  };
}

export async function recomendarAlternativasDaTroca(
  escopo: VerifiedOrganizationScope, entrada: unknown, fonte: LeitorDeFatosDasAlternativas, agora: Date,
): Promise<ResultadoDasAlternativas> {
  if (!escopoTemCapacidade(escopo, 'organization:access')) return { estado: 'sem_permissao' };
  const pedido = PedidoDeAlternativasSchema.safeParse(entrada);
  if (!pedido.success) return { estado: 'entrada_invalida' };

  let bruto: unknown;
  try { bruto = await fonte.ler(escopo, pedido.data); } catch { return { estado: 'indisponivel' }; }
  if (bruto === null) return { estado: 'sem_prova' };
  const resultado = FatosDasAlternativasSchema.safeParse(bruto);
  if (!resultado.success) return { estado: 'dados_invalidos' };
  const fatos = resultado.data;
  if (fatos.organizacaoId !== escopo.organizationId || fatos.conversaId !== pedido.data.conversaId ||
      fatos.pedidoId !== pedido.data.pedidoId || fatos.itemId !== pedido.data.itemId ||
      fatos.provaValidaAte === null || !(Date.parse(fatos.provaValidaAte) > agora.getTime())) return { estado: 'sem_prova' };
  if (pedido.data.quantidade > fatos.original.quantidade || !atual(fatos.original.pedidoSincronizadoEm, agora.getTime())) {
    return { estado: 'dados_invalidos' };
  }

  const ids = new Set<string>();
  const duplicados = new Set<string>();
  const candidatos = fatos.candidatos.filter(c => c.organizacaoId === escopo.organizationId);
  for (const c of candidatos) {
    if (ids.has(c.produtoId)) duplicados.add(c.produtoId);
    ids.add(c.produtoId);
  }
  const alternativas = candidatos
    .filter(c => !duplicados.has(c.produtoId))
    .map(c => avaliar(c, fatos.original, pedido.data, agora.getTime()))
    .filter(c => c !== null)
    .sort((a, b) => b.pontuacao - a.pontuacao ||
      Math.abs(a.deltaTotalCentavos) - Math.abs(b.deltaTotalCentavos) ||
      (a.produtoId < b.produtoId ? -1 : 1))
    .slice(0, 3);
  return { estado: 'ok', valor: AlternativasDaTrocaSchema.parse({ versao: 1, alternativas }) };
}
