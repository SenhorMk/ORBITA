import { descreverCatalogo, normalizar, selecionarRelevantes, termos, type ItemDoCatalogo } from './catalogo';
import type { ConhecimentoDaOrganizacao, LinhaDeProduto } from './conhecimento';
import { descreverPoliticasRecuperadas, recuperarPoliticas, type PoliticaRecuperada } from './politicas';

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
  /** Linhas enviadas ao modelo sem item correspondente no ERP: sem preço nem estoque. */
  readonly nomesSemCadastro: readonly string[];
  /** Temas de política recuperados (até 3), com estado e registros: a validação confere as afirmações contra eles. */
  readonly politicas: readonly PoliticaRecuperada[];
}

const POLITICA = /\b(?:pag|pix|cart|boleto|parcel|frete|entreg|envi|prazo|postag|troc|devol|cancel|reembols|estorn|garantia)/u;

/** A mensagem só continua a anterior ("e quanto tempo...?", "mas isso vale...?"). */
const RETOMA_ANTERIOR = /^(?:e|mas|tambem)\b|\b(?:isso|disso|nesse caso|nessa|nesse|dela|dele)\b/u;

/** A conversa como o modelo a recebe: o histórico é contexto, a solicitação atual é o pedido. */
export interface Conversa {
  readonly historico: readonly string[];
  readonly atual: readonly string[];
}

/** Palavras que só apontam para algo já dito ("e quanto custa?", "qual desses?", "tem disponível?"). */
const REFERENCIAIS = new Set(termos(['desse desses dessa dessas deste destes desta destas esse esses essa essas este estes',
  'esta estas aquele aqueles aquela aquelas dele dela deles delas ele ela eles elas menor maior barato barata caro cara',
  'outro outra outros outras ultimo ultima primeiro primeira segundo segunda diferenca melhor melhores indica indicacao',
  'recomendacao recomendo disponivel disponiveis estoque tamanho tamanhos opcao opcoes sai fica ficaria ainda tambem',
  'entao sim pode fala diz unidade unidades voces vcs gente teria teriam'].join(' ')));

/** Agradecimento ou despedida sem pergunta: nenhuma consulta comercial. */
const ENCERRAMENTO = new Set(['obrigado', 'obrigada', 'obrigadao', 'brigado', 'brigada', 'valeu', 'vlw', 'ok', 'okay', 'beleza',
  'blz', 'tchau', 'ate', 'mais', 'logo', 'perfeito', 'show', 'certo', 'entendi', 'combinado', 'otimo', 'top', 'legal', 'grato',
  'grata', 'agradeco', 'muito', 'ta', 'bom', 'beijo', 'abraco', 'abracos', 'por', 'enquanto', 'so', 'isso']);

const proprias = (texto: string) => termos(texto).filter((t) => !REFERENCIAIS.has(t));

export function ehEncerramento(texto: string): boolean {
  if (texto.includes('?')) return false;
  const palavras = normalizar(texto).split(/[^a-z]+/u).filter(Boolean);
  return palavras.length > 0 && palavras.every((p) => ENCERRAMENTO.has(p));
}

/**
 * O assunto desta resposta. Com termos próprios, a solicitação atual define
 * tudo (inclusive troca de assunto e retomada explícita). Se ela só aponta
 * para trás, entra apenas a mensagem anterior mais recente com assunto: as
 * outras do histórico não alimentam ferramentas. Agradecimento: nada.
 */
export function assuntoDaResposta(conversa: Conversa): { readonly busca: readonly string[]; readonly linhas: readonly string[] } {
  const atual = conversa.atual.join('\n');
  if (ehEncerramento(atual)) return { busca: [], linhas: [] };
  if (proprias(atual).length > 0) return { busca: conversa.atual, linhas: conversa.atual };
  const referencia = [...conversa.historico].reverse().find((m) => !ehEncerramento(m) && proprias(m).length > 0);
  return referencia === undefined ? { busca: conversa.atual, linhas: conversa.atual }
    : { busca: [referencia, ...conversa.atual], linhas: [referencia] };
}

/** Linhas pertinentes: por palavra-chave; se a conversa é sobre a família, todas. */
export function selecionarLinhas(conhecimento: ConhecimentoDaOrganizacao, mensagens: readonly string[]): LinhaDeProduto[] {
  const texto = normalizar(mensagens.slice(-4).join(' '));
  const sobreAFamilia = conhecimento.termosDaFamilia.some((t) => texto.includes(normalizar(t)));
  const porChave = conhecimento.linhas.filter((l) => l.palavrasChave.some((p) => texto.includes(normalizar(p))));
  if (sobreAFamilia || porChave.length > 0) return [...conhecimento.linhas];
  return [];
}

function descreverLinhas(conhecimento: ConhecimentoDaOrganizacao, linhas: readonly LinhaDeProduto[], semCadastro: readonly string[]): string {
  if (linhas.length === 0) return '';
  const aviso = semCadastro.length
    ? `ATENÇÃO: ${semCadastro.join(', ')} NÃO estão cadastradas no ERP: o preço e a disponibilidade delas são DESCONHECIDOS. Os produtos do catálogo são outros itens; nunca atribua o preço ou o estoque deles a estas linhas.`
    : '';
  return [
    `Linhas de ${linhas[0].categoria.toLowerCase()} descritas pela marca:`,
    ...(aviso ? [aviso] : []),
    ...linhas.map((l) => `- ${l.nome} (${l.codigo}): ${l.sintese}. Aroma ${l.perfilAromatico}. ${l.descricao} Essências: ${l.essencias} (composição provisória).`),
    ...conhecimento.observacoesDasLinhas.map((o) => `Obs.: ${o}`),
  ].join('\n');
}

/**
 * Executa as consultas pertinentes ao assunto desta resposta (nunca ao
 * histórico inteiro). Cada ferramenta falha isoladamente: catálogo
 * indisponível não derruba linhas nem políticas.
 */
export async function executarConsultas(
  conhecimento: ConhecimentoDaOrganizacao,
  catalogo: () => Promise<readonly ItemDoCatalogo[]>,
  conversa: Conversa,
  agora: Date = new Date(),
): Promise<ResultadoDasConsultas> {
  const resultados: ResultadoDaFerramenta[] = [];
  let itensCitaveis: readonly ItemDoCatalogo[] = [];
  let todos: readonly ItemDoCatalogo[] = [];
  const assunto = assuntoDaResposta(conversa);
  if (assunto.busca.length === 0) return { resultados, itensCitaveis, nomesSemCadastro: [], politicas: [] };
  const busca = assunto.busca.join(' ');
  const linhas = selecionarLinhas(conhecimento, assunto.linhas);

  try {
    const itens = await catalogo();
    todos = itens;
    itensCitaveis = selecionarRelevantes(itens, `${busca}${linhas.length ? ' defumador' : ''}`);
    resultados.push({ ferramenta: 'consultar_catalogo', ok: true, conteudo: descreverCatalogo(itens, itensCitaveis) });
  } catch {
    resultados.push({ ferramenta: 'consultar_catalogo', ok: false,
      conteudo: 'Catálogo do ERP indisponível agora: não cite preços nem disponibilidade; diga que não conseguiu consultar.' });
  }

  const cadastrados = todos.map((i) => normalizar(i.nome));
  // "Portal de Harmonia" (marca) × "Defumador Líquido - Portal da Harmonia" (ERP): casa por "portal" + a palavra própria.
  const propria = (nome: string) => normalizar(nome).split(/\s+/u).at(-1) ?? '';
  const nomesSemCadastro = linhas.map((l) => l.nome)
    .filter((n) => !cadastrados.some((c) => c.includes('portal') && c.includes(propria(n))));
  if (linhas.length) resultados.push({ ferramenta: 'consultar_linhas', ok: true, conteudo: descreverLinhas(conhecimento, linhas, nomesSemCadastro) });

  // Só os temas do assunto desta resposta, nunca a lista inteira de políticas.
  let politicas = recuperarPoliticas(conhecimento.organizacaoId, conhecimento.politicas, assunto.busca, agora);
  // "e quanto tempo eu tenho?" depois de "como funciona a troca?": sem assunto próprio, retoma só a mensagem anterior.
  const anterior = conversa.historico.at(-1);
  if (politicas.length === 0 && itensCitaveis.length === 0 && linhas.length === 0 && anterior !== undefined
    && RETOMA_ANTERIOR.test(normalizar(conversa.atual.join(' ')).trim())) {
    politicas = recuperarPoliticas(conhecimento.organizacaoId, conhecimento.politicas, [anterior, ...conversa.atual], agora);
  }
  if (politicas.length > 0 || POLITICA.test(normalizar(busca))) {
    resultados.push({ ferramenta: 'consultar_politica_comercial', ok: true, conteudo: `Políticas comerciais:\n${descreverPoliticasRecuperadas(politicas)}` });
  }
  return { resultados, itensCitaveis, nomesSemCadastro, politicas };
}
