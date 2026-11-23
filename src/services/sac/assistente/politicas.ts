import { z } from 'zod';
import { normalizar, termos } from './catalogo';

/**
 * Políticas comerciais como registros rastreáveis, recuperados por tema.
 *
 * A fonte de verdade continua sendo o conhecimento versionado de cada
 * organização (`organizacoes/*.ts`): aqui só há o formato, a validação e a
 * recuperação. Só um registro `confirmada`, completo (texto, fonte, aprovação,
 * vigência) e vigente fundamenta afirmação comercial. Pendente, indisponível,
 * fora de vigência, inválido, de outra organização ou em conflito vira
 * "não informada": o assistente não afirma nada sobre o tema.
 */
export type SituacaoDaPolitica = 'confirmada' | 'pendente' | 'indisponivel';

export interface RegistroDePolitica {
  /** Estável entre versões: identifica o tema na organização (ex.: `haux.frete`). */
  readonly id: string;
  readonly organizacaoId: string;
  readonly tema: string;
  readonly situacao: SituacaoDaPolitica;
  /** Texto aprovado; `null` quando não confirmada. */
  readonly texto: string | null;
  /** Perguntas equivalentes, como o cliente escreveria. */
  readonly perguntas: readonly string[];
  /** Termos e radicais que indicam o tema ("parcel" casa parcela e parcelamento). */
  readonly sinonimos: readonly string[];
  readonly fonte: string | null;
  readonly versao: number;
  readonly vigencia: { readonly inicio: string | null; readonly fim: string | null };
  readonly aprovadoPor: string | null;
}

const instante = z.string().datetime({ offset: true });
const Base = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u),
  organizacaoId: z.string().uuid(),
  tema: z.string().min(3),
  perguntas: z.array(z.string().min(3)),
  sinonimos: z.array(z.string().min(2)).min(1),
  versao: z.number().int().positive(),
});
/** Confirmada exige tudo que a torna auditável; as demais não podem carregar texto. */
const RegistroSchema = z.discriminatedUnion('situacao', [
  Base.extend({
    situacao: z.literal('confirmada'), texto: z.string().trim().min(10), fonte: z.string().trim().min(3),
    aprovadoPor: z.string().trim().min(3), vigencia: z.object({ inicio: instante, fim: instante.nullable() }),
  }),
  Base.extend({
    situacao: z.enum(['pendente', 'indisponivel']), texto: z.null(), fonte: z.string().nullable(),
    aprovadoPor: z.null(), vigencia: z.object({ inicio: instante.nullable(), fim: instante.nullable() }),
  }),
]);

export type EstadoDaPolitica = 'fundamentada' | 'nao_informada' | 'vencida' | 'conflito';

export interface PoliticaRecuperada {
  readonly tema: string;
  readonly estado: EstadoDaPolitica;
  /** Só em `fundamentada`: o texto aprovado que pode ser afirmado. */
  readonly texto: string | null;
  readonly fonte: string | null;
  /** Rastreabilidade: os registros considerados para o tema. */
  readonly registros: ReadonlyArray<{ readonly id: string; readonly versao: number }>;
}

/** Os registros válidos e desta organização; o resto não fundamenta nada. */
export function registrosValidos(organizacaoId: string, registros: readonly RegistroDePolitica[]): RegistroDePolitica[] {
  return registros.filter((r) => r.organizacaoId === organizacaoId && RegistroSchema.safeParse(r).success);
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/**
 * Termo ou radical no início de palavra ("parcel" casa "parcelam"). Termo de
 * até três letras só casa a palavra inteira ("pac" não casa "pacote").
 */
function contem(texto: string, termo: string): boolean {
  const t = normalizar(termo);
  return new RegExp(`(?:^|[^a-z0-9])${escapar(t)}${t.length <= 3 ? '(?:[^a-z0-9]|$)' : ''}`, 'u').test(texto);
}

function pontuar(registro: RegistroDePolitica, texto: string): number {
  const palavras = new Set(termos(texto));
  const porSinonimo = registro.sinonimos.filter((s) => contem(texto, s)).length;
  const porPergunta = registro.perguntas.some((p) => {
    const daPergunta = termos(p);
    return daPergunta.length >= 2 && daPergunta.filter((t) => palavras.has(t)).length / daPergunta.length >= 0.6;
  }) ? 2 : 0;
  return porSinonimo + porPergunta;
}

function vigente(r: RegistroDePolitica, agora: Date): boolean {
  const inicio = r.vigencia.inicio ? Date.parse(r.vigencia.inicio) : NaN;
  const fim = r.vigencia.fim ? Date.parse(r.vigencia.fim) : Infinity;
  return inicio <= agora.getTime() && agora.getTime() < fim;
}

function estadoDoTema(doTema: readonly RegistroDePolitica[], validos: ReadonlySet<RegistroDePolitica>, agora: Date): Omit<PoliticaRecuperada, 'tema' | 'registros'> {
  const confirmados = doTema.filter((r) => r.situacao === 'confirmada' && validos.has(r));
  const vigentes = confirmados.filter((r) => vigente(r, agora));
  if (vigentes.length === 0) return { estado: confirmados.length ? 'vencida' : 'nao_informada', texto: null, fonte: null };
  const textos = new Set(vigentes.map((r) => normalizar(r.texto ?? '').replace(/\s+/gu, ' ').trim()));
  if (textos.size > 1) return { estado: 'conflito', texto: null, fonte: null };
  const atual = [...vigentes].sort((a, b) => b.versao - a.versao)[0];
  return { estado: 'fundamentada', texto: atual.texto, fonte: atual.fonte };
}

/**
 * Até `limite` temas pertinentes ao assunto desta resposta (a solicitação
 * atual, ou a referência anterior que ela retoma), do mais ao menos
 * pertinente. Registros de outra organização nem entram na disputa.
 */
export function recuperarPoliticas(organizacaoId: string, registros: readonly RegistroDePolitica[], busca: readonly string[],
  agora: Date = new Date(), limite = 3): PoliticaRecuperada[] {
  const texto = normalizar(busca.join(' '));
  if (!texto.trim()) return [];
  const daOrganizacao = registros.filter((r) => r.organizacaoId === organizacaoId);
  const validos = new Set(registrosValidos(organizacaoId, daOrganizacao));
  const porTema = new Map<string, RegistroDePolitica[]>();
  for (const r of daOrganizacao) porTema.set(r.tema, [...(porTema.get(r.tema) ?? []), r]);
  return [...porTema].map(([tema, doTema]) => ({ tema, doTema, pontos: Math.max(...doTema.map((r) => pontuar(r, texto))) }))
    .filter((t) => t.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || a.tema.localeCompare(b.tema))
    .slice(0, limite)
    .map(({ tema, doTema }) => ({ tema, ...estadoDoTema(doTema, validos, agora),
      registros: doTema.map((r) => ({ id: r.id, versao: r.versao })) }));
}

/** O bloco que o modelo recebe: só os temas recuperados, nunca a lista inteira. */
export function descreverPoliticasRecuperadas(politicas: readonly PoliticaRecuperada[]): string {
  if (politicas.length === 0) return 'Nenhuma política aprovada corresponde à pergunta: não afirme nenhuma condição comercial (pagamento, frete, prazo, troca, desconto).';
  return politicas.map((p) => {
    if (p.estado === 'fundamentada') return `- ${p.tema} [${p.registros.map((r) => `${r.id} v${r.versao}`).join(', ')}]: ${p.texto} (fonte: ${p.fonte})`;
    const motivo = p.estado === 'conflito' ? 'EM REVISÃO (fontes divergentes)' : 'NÃO INFORMADA';
    return `- ${p.tema}: ${motivo}. Não afirme nada sobre isso; diga que ainda não tem essa informação confirmada.`;
  }).join('\n');
}

/** Rastreio para o log: `id@versao:estado`, sem texto. */
export const rastrearPoliticas = (politicas: readonly PoliticaRecuperada[]) =>
  politicas.flatMap((p) => p.registros.map((r) => `${r.id}@${r.versao}:${p.estado}`)).join(',');

/** A frase recusa ou adia a afirmação ("ainda não tenho", "não está confirmada"). */
const NEGA_POLITICA = /\b(?:nao (?:tenho|temos|ha|sei|consigo|posso|esta|estao|foi|foram|e)|ainda nao|sem (?:essa |a |esta )?informac|nao (?:esta |estao )?confirmad|nao informad|indisponive|em revisao|desconhec|confirmad[oa]s? (?:pela|com a) equipe)/u;
/** Fatos que só podem ser afirmados se estiverem no texto aprovado do tema. */
const FATOS = [/\bpix\b/u, /\bboleto/u, /\bcart(?:ao|oes)\b/u, /\bcredito\b/u, /\bdebito\b/u, /\bgratu?i/u, /\bgratis\b/u,
  /\bjuros\b/u, /\bcorreios\b/u, /\bsedex\b/u, /\bpac\b/u, /\btransportadora/u, /\bretirada\b/u, /\breembols/u,
  /\bestorn/u, /\bcupo/u, /\bdesconto/u, /\ba vista\b/u, /\bparcel/u];
const NUMERO = /\d+(?:[.,]\d+)?/gu;

/**
 * Afirmação comercial sem fundamento: uma frase afirmativa (não pergunta nem
 * recusa) que trata de um tema da organização precisa de um tema
 * `fundamentada` entre os recuperados, e cada número e fato citado (pix,
 * grátis, 7 dias) precisa estar no texto aprovado. Recuperar um documento não
 * aprova o que o modelo escreveu: a frase é conferida contra o texto.
 */
export function politicaSemFundamento(texto: string, organizacaoId: string, registros: readonly RegistroDePolitica[],
  recuperadas: readonly PoliticaRecuperada[]): readonly string[] {
  const daOrganizacao = registros.filter((r) => r.organizacaoId === organizacaoId);
  const fundamentadas = new Map(recuperadas.filter((p) => p.estado === 'fundamentada').map((p) => [p.tema, normalizar(p.texto ?? '')]));
  const sem = new Set<string>();
  for (const bruta of texto.split(/(?<=[.!?;\n])\s*/u)) {
    const frase = normalizar(bruta).trim();
    if (!frase || frase.endsWith('?') || NEGA_POLITICA.test(frase)) continue;
    const temas = [...new Set(daOrganizacao.filter((r) => r.sinonimos.some((s) => contem(frase, s))).map((r) => r.tema))];
    if (temas.length === 0) continue;
    const aprovados = temas.map((t) => fundamentadas.get(t));
    if (aprovados.some((a) => a === undefined)) { temas.forEach((t) => { if (!fundamentadas.has(t)) sem.add(t); }); continue; }
    const base = aprovados.join(' ');
    // Preço já é conferido contra o ERP pela validação do catálogo; aqui só os números da política.
    const numeros = [...frase.replace(/r\$\s?[\d.,]+/gu, ' ').matchAll(NUMERO)].map((m) => m[0]);
    const foraDoTexto = numeros.some((n) => !new RegExp(`(?:^|[^0-9])${escapar(n)}(?:[^0-9]|$)`, 'u').test(base))
      || FATOS.some((f) => f.test(frase) && !f.test(base));
    if (foraDoTexto) temas.forEach((t) => sem.add(t));
  }
  return [...sem];
}
