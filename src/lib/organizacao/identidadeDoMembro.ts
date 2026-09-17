/**
 * Como um membro é **chamado** na interface, e de onde esse nome veio.
 *
 * ---------------------------------------------------------------------------
 * POR QUE O NOME
 * ---------------------------------------------------------------------------
 * A lista de membros é uma lista de autoridade — quem participa, e com qual
 * poder. Identificada só por UUID, ninguém consegue conferir se está removendo
 * a pessoa certa. O nome vem do cadastro ("Como devemos te chamar" grava
 * `user_metadata.full_name`, ver `src/app/api/auth/register/route.ts`).
 *
 * ---------------------------------------------------------------------------
 * O E-MAIL NÃO ENTRA NESTA TELA
 * ---------------------------------------------------------------------------
 * Mesmo que outro lugar já exponha e-mails a quem administra (a lista de
 * convites), "já é visível em outro lugar" não é motivo para publicar dado
 * pessoal em mais um. A ausência de nome é dizível sem e-mail nenhum.
 *
 * Então a regra é uma só, igual para owner, admin e member: **nome do cadastro,
 * ou a ausência dele dita em voz alta**. Nenhum papel recebe e-mail por aqui, e
 * a rota não tem mais política de exposição para acertar ou errar.
 *
 * ---------------------------------------------------------------------------
 * TRÊS DESFECHOS, E NENHUM DELES SE CONFUNDE COM OUTRO
 * ---------------------------------------------------------------------------
 * `origem_do_nome` existe porque "esta pessoa não cadastrou nome" e "não
 * consegui ler a identidade desta pessoa" são coisas diferentes, e a tela de
 * membros é o último lugar do produto onde vale juntá-las — é a mesma confusão
 * entre zero e "não sei" que a lista já evita ao não transformar falha de
 * leitura em "nenhum membro".
 */

/** De onde saiu o texto que a interface vai mostrar. */
export type OrigemDoNome =
  /** `user_metadata.full_name`, informado no cadastro. */
  | 'cadastro'
  /** A identidade foi lida e não há nome cadastrado. */
  | 'ausente'
  /** A identidade não pôde ser lida. Não é o mesmo que não ter nome. */
  | 'indisponivel';

export interface IdentidadeDeExibicao {
  readonly nome_exibicao: string | null;
  readonly origem_do_nome: OrigemDoNome;
}

/**
 * O usuário do Auth reduzido ao **único** campo que a interface pode mostrar.
 *
 * O tipo é estreito de propósito, e ficou mais estreito ainda quando o e-mail
 * saiu: a metadata do Auth é um saco aberto onde qualquer integração pode ter
 * escrito qualquer coisa, e devolvê-la inteira publicaria campos que ninguém
 * revisou. O que não está aqui não tem como vazar daqui.
 */
export interface UsuarioDoAuth {
  readonly user_metadata?: unknown;
}

/**
 * As chaves onde um nome pode estar, em ordem de preferência.
 *
 * `full_name` é o que o cadastro do ORBITA grava. `name` entra porque é o que
 * provedores de identidade costumam gravar, e um usuário legado que tenha vindo
 * por outro caminho tem nome de verdade ali — ler uma segunda chave conhecida
 * não é inventar nome, é procurar onde ele estaria.
 */
const CHAVES_DE_NOME = ['full_name', 'name'] as const;

/** Texto não vazio, ou `null`. Espaço em branco não é nome. */
function textoUtil(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : null;
}

function nomeCadastrado(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const registro = metadata as Record<string, unknown>;
  for (const chave of CHAVES_DE_NOME) {
    const nome = textoUtil(registro[chave]);
    if (nome !== null) return nome;
  }
  return null;
}

/**
 * Decide como um membro aparece, dado o que se conseguiu ler dele.
 *
 * @param usuario - O usuário do Auth, ou `null` quando a leitura não deu certo.
 *   `null` **não** significa "sem nome": significa que não se sabe.
 */
export function identidadeDeExibicao(usuario: UsuarioDoAuth | null): IdentidadeDeExibicao {
  if (usuario === null) {
    return { nome_exibicao: null, origem_do_nome: 'indisponivel' };
  }

  const nome = nomeCadastrado(usuario.user_metadata);
  return nome !== null
    ? { nome_exibicao: nome, origem_do_nome: 'cadastro' }
    : { nome_exibicao: null, origem_do_nome: 'ausente' };
}

/**
 * O que a interface escreve quando não há nome para escrever.
 *
 * Mora aqui, junto da política, para a tela e a rota nunca discordarem sobre o
 * que cada desfecho quer dizer.
 */
export function rotuloSemNome(origem: OrigemDoNome): string {
  return origem === 'indisponivel' ? 'Identidade indisponível' : 'Sem nome cadastrado';
}

/** O texto que identifica o membro na interface. */
export function rotuloDoMembro(identidade: IdentidadeDeExibicao): string {
  return identidade.nome_exibicao ?? rotuloSemNome(identidade.origem_do_nome);
}
