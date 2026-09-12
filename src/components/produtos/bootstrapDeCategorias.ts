import type { Categoria } from '@/types';

/**
 * As categorias que o seletor de produto precisa, buscando-as se faltarem.
 *
 * ## O defeito
 *
 * O modal de produto abria chamando `GET /api/categorias/sync` — e o `GET`
 * apenas **lista o catálogo local**. Quem vai ao Bling é o `POST` da mesma
 * rota. Com `categorias` zeradas na organização (medido no staging: 0 linhas),
 * o seletor abria com "Sem categoria" e mais nada, para sempre: nenhuma tela
 * chamava o `POST`, e o job principal de `/api/sync` sincroniza clientes,
 * produtos e pedidos — categorias, não.
 *
 * A correção mínima e segura é aqui, na superfície de produto: se o catálogo
 * local está vazio, tenta popular **uma vez** e relê. O job durável e o schema
 * de progresso dele ficam intocados.
 *
 * ## Por que não pode entrar em laço
 *
 * O caminho é linear por construção: um `GET`, no máximo um `POST`, e um
 * segundo `GET` só depois de um `POST` que deu certo. Catálogo vazio no Bling é
 * um **desfecho**, não uma tentativa a repetir — é a resposta "não há
 * categorias lá", e insistir nela seria bater na porta do ERP a cada abertura
 * de modal.
 *
 * ## Por que os desfechos são nomeados
 *
 * O código anterior terminava em `console.warn` e a tela ficava idêntica ao
 * caso normal: "não tem categoria", "não consegui ler", "não consegui
 * sincronizar" e "você não tem permissão para sincronizar" desenhavam o mesmo
 * seletor vazio. Quatro situações com quatro ações diferentes, e nenhuma
 * visível. Aqui cada uma chega com nome, e a tela diz qual é.
 *
 * Em todas elas o cadastro continua possível: categoria é opcional no produto,
 * e "Sem categoria" é uma resposta legítima — falha de sincronização não pode
 * travar quem só quer cadastrar um item.
 */

export type ResultadoDoBootstrap =
  /** Há categorias para escolher. `sincronizou` diz se foi preciso buscá-las. */
  | { readonly _tag: 'Carregadas'; readonly categorias: Categoria[]; readonly sincronizou: boolean }
  /** O Bling respondeu, e realmente não há categoria nenhuma lá. */
  | { readonly _tag: 'CatalogoVazioNoBling' }
  /** Não foi possível ler o catálogo local. */
  | { readonly _tag: 'FalhaAoCarregar'; readonly aviso: string }
  /** O catálogo local está vazio e a busca no Bling não aconteceu. */
  | { readonly _tag: 'FalhaAoSincronizar'; readonly aviso: string };

/**
 * A busca autenticada, na forma que o projeto já usa.
 *
 * Não é um tipo exportado novo de propósito: `BuscaAutenticada` já existe em
 * `useLeituraFinanceira`, e declarar a mesma assinatura com o mesmo nome num
 * segundo arquivo é como dois tipos iguais começam a divergir.
 */
type BuscaAutenticada = (url: string, options?: RequestInit) => Promise<Response>;

const ROTA = '/api/categorias/sync';

const AVISO_LEITURA = 'Não foi possível carregar as categorias. Você pode cadastrar sem categoria e ajustar depois.';
const AVISO_SINCRONIZACAO = 'Não foi possível buscar as categorias no Bling. Você pode cadastrar sem categoria e ajustar depois.';
const AVISO_SEM_PERMISSAO = 'As categorias ainda não foram importadas do Bling, e importá-las exige permissão de administrador da organização.';

/** Lista o catálogo local. `null` quando a leitura não deu certo. */
async function lerCatalogoLocal(fetchWithAuth: BuscaAutenticada): Promise<Categoria[] | null> {
  try {
    const res = await fetchWithAuth(ROTA);
    if (!res.ok) return null;
    const corpo = (await res.json()) as { success?: boolean; data?: Categoria[] };
    if (corpo.success !== true || !Array.isArray(corpo.data)) return null;
    return corpo.data;
  } catch {
    return null;
  }
}

/**
 * Pede ao servidor que importe as categorias do Bling.
 *
 * O `POST` continua exigindo `organization:manage` — esta função não contorna
 * nada, só distingue "não tenho permissão" (403) de "a importação falhou", que
 * pedem coisas diferentes de quem está na frente da tela.
 */
async function importarDoBling(
  fetchWithAuth: BuscaAutenticada,
): Promise<{ readonly _tag: 'Importou'; readonly count: number } | { readonly _tag: 'NaoImportou'; readonly aviso: string }> {
  try {
    const res = await fetchWithAuth(ROTA, { method: 'POST' });
    if (res.status === 403) return { _tag: 'NaoImportou', aviso: AVISO_SEM_PERMISSAO };
    if (!res.ok) return { _tag: 'NaoImportou', aviso: AVISO_SINCRONIZACAO };
    const corpo = (await res.json()) as { success?: boolean; count?: unknown };
    if (corpo.success !== true) return { _tag: 'NaoImportou', aviso: AVISO_SINCRONIZACAO };
    return { _tag: 'Importou', count: typeof corpo.count === 'number' ? corpo.count : 0 };
  } catch {
    return { _tag: 'NaoImportou', aviso: AVISO_SINCRONIZACAO };
  }
}

export async function carregarCategoriasDoProduto(
  fetchWithAuth: BuscaAutenticada,
): Promise<ResultadoDoBootstrap> {
  const locais = await lerCatalogoLocal(fetchWithAuth);
  if (locais === null) return { _tag: 'FalhaAoCarregar', aviso: AVISO_LEITURA };

  // Catálogo já populado: nada de ir ao ERP. Abrir o modal não é motivo para
  // uma importação, e este é o caminho de todos os dias.
  if (locais.length > 0) return { _tag: 'Carregadas', categorias: locais, sincronizou: false };

  const importacao = await importarDoBling(fetchWithAuth);
  if (importacao._tag === 'NaoImportou') {
    return { _tag: 'FalhaAoSincronizar', aviso: importacao.aviso };
  }

  // O Bling respondeu que não tem categoria. É desfecho, não tentativa: sem
  // isto, cada abertura do modal bateria no ERP de novo para ouvir o mesmo.
  if (importacao.count === 0) return { _tag: 'CatalogoVazioNoBling' };

  const depois = await lerCatalogoLocal(fetchWithAuth);
  if (depois === null) return { _tag: 'FalhaAoCarregar', aviso: AVISO_LEITURA };

  return { _tag: 'Carregadas', categorias: depois, sincronizou: true };
}

/** O aviso a mostrar na tela, ou `null` quando não há nada a avisar. */
export function avisoDoBootstrap(resultado: ResultadoDoBootstrap): string | null {
  switch (resultado._tag) {
    case 'Carregadas':
      return null;
    case 'CatalogoVazioNoBling':
      return 'Nenhuma categoria cadastrada no Bling. O produto pode ser salvo sem categoria.';
    case 'FalhaAoCarregar':
    case 'FalhaAoSincronizar':
      return resultado.aviso;
  }
}
