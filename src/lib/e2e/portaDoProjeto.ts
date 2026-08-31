import type { RegistroEncontrado } from './execucaoSeed';

/**
 * Porta do projeto Supabase alvo.
 *
 * Existe para o seed e a limpeza serem exercitados com falhas simuladas sem
 * tocar em ambiente nenhum. Quem implementa de verdade é
 * `e2e/seed/supabasePorta.ts`; quem implementa nos testes é um dublê que sabe
 * falhar na hora exata.
 *
 * **Toda leitura devolve resultado tipado, nunca lista vazia em erro.** Foi
 * essa distinção que faltou antes: um `catch` que devolvia "não achei" fazia
 * uma falha de rede parecer registro já removido, e a limpeza seguia
 * declarando sucesso sobre dados que continuavam lá.
 */

export type LeituraDoProjeto =
  | { readonly _tag: 'Lido'; readonly registros: readonly RegistroEncontrado[] }
  | { readonly _tag: 'FalhaDeLeitura'; readonly recurso: string; readonly causa: string };

export type EscritaNoProjeto =
  | { readonly _tag: 'Escrito'; readonly id: string }
  | { readonly _tag: 'FalhaDeEscrita'; readonly causa: string };

export type ExclusaoNoProjeto =
  | { readonly _tag: 'Excluido' }
  | { readonly _tag: 'FalhaDeExclusao'; readonly causa: string };

/** Papel do membership, no vocabulário da tabela. */
export type PapelDeMembership = 'owner' | 'admin' | 'member';

export interface PortaDoProjeto {
  criarUsuario(email: string, senha: string): Promise<EscritaNoProjeto>;
  criarOrganizacao(slug: string, nome: string): Promise<EscritaNoProjeto>;
  criarMembership(organizacaoId: string, userId: string, papel: PapelDeMembership): Promise<EscritaNoProjeto>;

  /**
   * Lê do projeto tudo o que carrega o `runId`, com o identificador vindo do
   * **dado remoto** — e-mail do usuário, slug da organização — e não do plano.
   *
   * É o que torna a conferência de identidade real: comparar o plano consigo
   * mesmo não prova nada. E é o que permite achar órfão — registro que existe
   * e o diário não conhece.
   */
  lerUsuariosDaExecucao(runId: string): Promise<LeituraDoProjeto>;
  lerOrganizacoesDaExecucao(runId: string): Promise<LeituraDoProjeto>;
  lerMembershipsDaExecucao(runId: string): Promise<LeituraDoProjeto>;

  apagarUsuario(id: string): Promise<ExclusaoNoProjeto>;
  apagarOrganizacao(id: string): Promise<ExclusaoNoProjeto>;
  apagarMembership(id: string): Promise<ExclusaoNoProjeto>;
}

/** Grava o diário em disco. Separado da porta: é I/O local, não do projeto. */
export type PersistirDiario = (conteudo: string) => void;
