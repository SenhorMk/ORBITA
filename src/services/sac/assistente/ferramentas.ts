import { descreverCatalogo, normalizar, selecionarRelevantes, type ItemDoCatalogo } from './catalogo';
import { descreverPoliticas, type ConhecimentoDaOrganizacao, type LinhaDeProduto } from './conhecimento';

/**
 * Camada de ferramentas do assistente do CLIENTE: somente leitura, escopada
 * pela organização do worker e sem nenhum parâmetro vindo do texto que alcance
 * o banco além de termos de busca. A aplicação decide e executa; o modelo só
 * recebe o resultado. Ferramentas administrativas (vendas, financeiro,
 * preparar_*) não existem neste contexto: ver docs/ai/ASSISTENTE_ORBITA.md §5.
 */
export type NomeDaFerramenta = 'consultar_catalogo' | 'consultar_linhas' | 'consultar_politica_comercial';

export interface ResultadoDaFerramenta {
  readonly ferramenta: NomeDaFerramenta;
  readonly ok: boolean;
  readonly conteudo: string;
}

export interface ResultadoDasConsultas {
  readonly resultados: readonly ResultadoDaFerramenta[];
  /** Itens do ERP enviados ao modelo: a validação só aceita preço destes itens. */
  readonly itensCitaveis: readonly ItemDoCatalogo[];
}

const POLITICA = /\b(?:pag|pix|cart|boleto|parcel|frete|entreg|envi|prazo|postag|troc|devol|cancel|reembols|estorn|garantia)/u;

/** Termos da conversa: a mensagem atual pesa mais, mas o histórico mantém o assunto. */
function contextoDaBusca(mensagens: readonly string[]): string {
  const atual = mensagens.at(-1) ?? '';
  return [...mensagens.slice(-4, -1), atual, atual].join(' ');
}

/** Linhas pertinentes: por palavra-chave; se a conversa é sobre a família, todas. */
export function selecionarLinhas(conhecimento: ConhecimentoDaOrganizacao, mensagens: readonly string[]): LinhaDeProduto[] {
  const texto = normalizar(mensagens.slice(-4).join(' '));
  const sobreAFamilia = conhecimento.termosDaFamilia.some((t) => texto.includes(normalizar(t)));
  const porChave = conhecimento.linhas.filter((l) => l.palavrasChave.some((p) => texto.includes(normalizar(p))));
  if (sobreAFamilia || porChave.length > 0) return [...conhecimento.linhas];
  return [];
}

function descreverLinhas(conhecimento: ConhecimentoDaOrganizacao, linhas: readonly LinhaDeProduto[]): string {
  if (linhas.length === 0) return '';
  return [
    `Linhas de ${linhas[0].categoria.toLowerCase()} descritas pela marca (preço destas linhas: só se aparecer no catálogo do ERP):`,
    ...linhas.map((l) => `- ${l.nome} (${l.codigo}): ${l.sintese}. Aroma ${l.perfilAromatico}. ${l.descricao} Essências: ${l.essencias} (composição provisória).`),
    ...conhecimento.observacoesDasLinhas.map((o) => `Obs.: ${o}`),
  ].join('\n');
}

/**
 * Executa as consultas pertinentes à conversa. Cada ferramenta falha
 * isoladamente: catálogo indisponível não derruba linhas nem políticas.
 */
export async function executarConsultas(
  conhecimento: ConhecimentoDaOrganizacao,
  catalogo: () => Promise<readonly ItemDoCatalogo[]>,
  mensagens: readonly string[],
): Promise<ResultadoDasConsultas> {
  const resultados: ResultadoDaFerramenta[] = [];
  let itensCitaveis: readonly ItemDoCatalogo[] = [];
  const busca = contextoDaBusca(mensagens);
  const linhas = selecionarLinhas(conhecimento, mensagens);

  try {
    const itens = await catalogo();
    const extras = linhas.length ? ' defumador' : '';
    itensCitaveis = selecionarRelevantes(itens, `${busca}${extras}`);
    resultados.push({ ferramenta: 'consultar_catalogo', ok: true, conteudo: descreverCatalogo(itens, itensCitaveis) });
  } catch {
    resultados.push({ ferramenta: 'consultar_catalogo', ok: false,
      conteudo: 'Catálogo do ERP indisponível agora: não cite preços nem disponibilidade; diga que não conseguiu consultar.' });
  }

  if (linhas.length) resultados.push({ ferramenta: 'consultar_linhas', ok: true, conteudo: descreverLinhas(conhecimento, linhas) });

  if (POLITICA.test(normalizar(busca))) {
    resultados.push({ ferramenta: 'consultar_politica_comercial', ok: true, conteudo: `Políticas comerciais:\n${descreverPoliticas(conhecimento)}` });
  }
  return { resultados, itensCitaveis };
}
