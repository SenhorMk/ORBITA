/**
 * Como um membro é **chamado** na interface, e de onde esse nome veio.
 *
 * ---------------------------------------------------------------------------
 * A LACUNA
 * ---------------------------------------------------------------------------
 * `GET /api/organizacoes/[id]/membros` devolvia `user_id`, `papel` e
 * `created_at`, e a tela imprimia o `user_id` como identidade principal. Uma
 * lista de autoridade — quem participa, e com qual poder — identificada por
 * UUID não é apenas feia: ninguém consegue conferir se está removendo a pessoa
 * certa. O nome existe desde o cadastro ("Como devemos te chamar" grava
 * `user_metadata.full_name`, ver `src/app/api/auth/register/route.ts`); só não
 * chegava até aqui.
 *
 * ---------------------------------------------------------------------------
 * O E-MAIL NÃO É PARA TODO MUNDO
 * ---------------------------------------------------------------------------
 * A lista de membros exige `organization:access` — **qualquer** membro a lê. A
 * lista de convites, que carrega e-mails, exige `organization:manage`. Devolver
 * o e-mail de todos os colegas a um `member` alargaria a exposição que o
 * produto hoje reserva a quem administra, e alargar exposição não é ajuste de
 * apresentação.
 *
 * Então o e-mail entra apenas como **recurso**, e só para quem já o veria de
 * outro jeito nesta organização: quem administra, e a própria pessoa olhando a
 * si mesma. Para os demais, sem nome cadastrado, a tela diz que não há nome —
 * e não inventa um.
 *
 * Nada aqui muda autorização: a decisão continua vindo de
 * `organizationCapabilitiesForRole`, a mesma tabela que a rota já usa. Esta
 * política só escolhe o que **mostrar** dentro do que já foi autorizado.
 *
 * ---------------------------------------------------------------------------
 * QUATRO DESFECHOS, E NENHUM DELES SE CONFUNDE COM OUTRO
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
  /** Recurso ao e-mail, permitido para este leitor. */
  | 'email'
  /** A identidade foi lida e não há nome — nem e-mail que este leitor possa ver. */
  | 'ausente'
  /** A identidade não pôde ser lida. Não é o mesmo que não ter nome. */
  | 'indisponivel';

export interface IdentidadeDeExibicao {
  readonly nome_exibicao: string | null;
  readonly origem_do_nome: OrigemDoNome;
}

/**
 * O usuário do Auth reduzido aos dois campos que a interface pode mostrar.
 *
 * O tipo é estreito de propósito: a metadata do Auth é um saco aberto onde
 * qualquer integração pode ter escrito qualquer coisa, e devolvê-la inteira
 * publicaria campos que ninguém revisou.
 */
export interface UsuarioDoAuth {
  readonly email?: string | null;
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
 * @param opcoes.podeVerEmail - Se este leitor já pode ver o e-mail deste membro
 *   nesta organização. Ver o cabeçalho deste arquivo.
 */
export function identidadeDeExibicao(
  usuario: UsuarioDoAuth | null,
  opcoes: { readonly podeVerEmail: boolean },
): IdentidadeDeExibicao {
  if (usuario === null) {
    return { nome_exibicao: null, origem_do_nome: 'indisponivel' };
  }

  const nome = nomeCadastrado(usuario.user_metadata);
  if (nome !== null) {
    return { nome_exibicao: nome, origem_do_nome: 'cadastro' };
  }

  const email = opcoes.podeVerEmail ? textoUtil(usuario.email) : null;
  if (email !== null) {
    return { nome_exibicao: email, origem_do_nome: 'email' };
  }

  return { nome_exibicao: null, origem_do_nome: 'ausente' };
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

/** O texto que identifica o membro na interface, com o recurso já aplicado. */
export function rotuloDoMembro(identidade: IdentidadeDeExibicao): string {
  return identidade.nome_exibicao ?? rotuloSemNome(identidade.origem_do_nome);
}
