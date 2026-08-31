import type { SupabaseClient } from '@supabase/supabase-js';

import type { RegistroEncontrado } from '../../src/lib/e2e/execucaoSeed';
import type {
  EscritaNoProjeto,
  ExclusaoNoProjeto,
  LeituraDoProjeto,
  PapelDeMembership,
  PortaDoProjeto,
} from '../../src/lib/e2e/portaDoProjeto';

/**
 * Porta real do projeto Supabase.
 *
 * A regra deste arquivo: **erro nunca vira lista vazia**. Toda leitura devolve
 * `FalhaDeLeitura` com a causa, e quem decide o que fazer é a orquestração. Um
 * `catch` que devolvesse `[]` faria falha de rede parecer registro já removido,
 * e a limpeza declararia sucesso deixando dado no projeto.
 *
 * O identificador de cada registro vem do **dado remoto** — e-mail, slug —, e
 * não do plano. Comparar o plano consigo mesmo não prova identidade nenhuma.
 */

/** Páginas de `listUsers`; o Supabase não filtra e-mail por substring. */
const USUARIOS_POR_PAGINA = 200;
const MAX_PAGINAS_DE_USUARIOS = 50;

export function criarPortaSupabase(supabase: SupabaseClient): PortaDoProjeto {
  async function lerUsuariosDaExecucao(runId: string): Promise<LeituraDoProjeto> {
    const registros: RegistroEncontrado[] = [];

    for (let pagina = 1; pagina <= MAX_PAGINAS_DE_USUARIOS; pagina++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page: pagina, perPage: USUARIOS_POR_PAGINA });
      if (error) {
        return { _tag: 'FalhaDeLeitura', recurso: 'usuarios', causa: error.message };
      }
      const usuarios = data?.users ?? [];
      for (const usuario of usuarios) {
        const email = usuario.email ?? '';
        if (email.includes(runId)) registros.push({ identificador: email, id: usuario.id });
      }
      if (usuarios.length < USUARIOS_POR_PAGINA) {
        return { _tag: 'Lido', registros };
      }
    }

    // Chegou ao teto com a última página cheia: há mais usuários adiante.
    // Devolver `Lido` aqui seria dizer "li tudo" tendo lido parte — e a
    // limpeza trataria o que não foi lido como já removido.
    return {
      _tag: 'FalhaDeLeitura',
      recurso: 'usuarios',
      causa: `a listagem passou de ${MAX_PAGINAS_DE_USUARIOS} páginas de ${USUARIOS_POR_PAGINA} e não terminou; `
        + 'a leitura está incompleta',
    };
  }

  async function lerOrganizacoesDaExecucao(runId: string): Promise<LeituraDoProjeto> {
    const { data, error } = await supabase.from('organizacoes').select('id, slug').ilike('slug', `%${runId}%`);
    if (error) {
      return { _tag: 'FalhaDeLeitura', recurso: 'organizacoes', causa: error.message };
    }
    return {
      _tag: 'Lido',
      registros: ((data ?? []) as Array<{ id: string; slug: string }>).map((l) => ({ identificador: l.slug, id: l.id })),
    };
  }

  /**
   * Memberships da execução, com o identificador reconstruído do dado remoto:
   * `<email do usuário>@<slug da organização>`, os dois lidos do projeto.
   */
  async function lerMembershipsDaExecucao(runId: string): Promise<LeituraDoProjeto> {
    const organizacoes = await lerOrganizacoesDaExecucao(runId);
    if (organizacoes._tag === 'FalhaDeLeitura') return organizacoes;
    if (organizacoes.registros.length === 0) return { _tag: 'Lido', registros: [] };

    const usuarios = await lerUsuariosDaExecucao(runId);
    if (usuarios._tag === 'FalhaDeLeitura') return usuarios;

    const slugPorId = new Map(organizacoes.registros.map((o) => [o.id, o.identificador]));
    const emailPorId = new Map(usuarios.registros.map((u) => [u.id, u.identificador]));

    const { data, error } = await supabase
      .from('membros_organizacao')
      .select('id, organizacao_id, user_id')
      .in('organizacao_id', [...slugPorId.keys()]);
    if (error) {
      return { _tag: 'FalhaDeLeitura', recurso: 'memberships', causa: error.message };
    }

    const registros: RegistroEncontrado[] = [];
    for (const linha of (data ?? []) as Array<{ id: string | number; organizacao_id: string; user_id: string }>) {
      const slug = slugPorId.get(linha.organizacao_id);
      const email = emailPorId.get(linha.user_id);
      // Membership cujo usuário não é da execução não é nosso; deixá-lo de fora
      // é o que impede a limpeza de alcançar dado alheio.
      if (!slug || !email) continue;
      registros.push({ identificador: `${email}@${slug}`, id: String(linha.id) });
    }

    return { _tag: 'Lido', registros };
  }

  return {
    async criarUsuario(email: string, senha: string): Promise<EscritaNoProjeto> {
      const { data, error } = await supabase.auth.admin.createUser({ email, password: senha, email_confirm: true });
      if (error || !data.user) {
        return { _tag: 'FalhaDeEscrita', causa: error?.message ?? 'o Supabase não devolveu o usuário criado' };
      }
      return { _tag: 'Escrito', id: data.user.id };
    },

    async criarOrganizacao(slug: string, nome: string): Promise<EscritaNoProjeto> {
      const { data, error } = await supabase
        .from('organizacoes')
        .insert({ slug, nome, status: 'active' })
        .select('id')
        .single();
      if (error || !data) {
        return { _tag: 'FalhaDeEscrita', causa: error?.message ?? 'o Supabase não devolveu o id da organização' };
      }
      return { _tag: 'Escrito', id: String((data as { id: string }).id) };
    },

    async criarMembership(organizacaoId: string, userId: string, papel: PapelDeMembership): Promise<EscritaNoProjeto> {
      const { data, error } = await supabase
        .from('membros_organizacao')
        .insert({ organizacao_id: organizacaoId, user_id: userId, papel })
        .select('id')
        .single();
      if (error || !data) {
        return { _tag: 'FalhaDeEscrita', causa: error?.message ?? 'o Supabase não devolveu o id do membership' };
      }
      return { _tag: 'Escrito', id: String((data as { id: string | number }).id) };
    },

    lerUsuariosDaExecucao,
    lerOrganizacoesDaExecucao,
    lerMembershipsDaExecucao,

    async apagarUsuario(id: string): Promise<ExclusaoNoProjeto> {
      const { error } = await supabase.auth.admin.deleteUser(id);
      return error ? { _tag: 'FalhaDeExclusao', causa: error.message } : { _tag: 'Excluido' };
    },

    async apagarOrganizacao(id: string): Promise<ExclusaoNoProjeto> {
      const { error } = await supabase.from('organizacoes').delete().eq('id', id);
      return error ? { _tag: 'FalhaDeExclusao', causa: error.message } : { _tag: 'Excluido' };
    },

    async apagarMembership(id: string): Promise<ExclusaoNoProjeto> {
      const { error } = await supabase.from('membros_organizacao').delete().eq('id', id);
      return error ? { _tag: 'FalhaDeExclusao', causa: error.message } : { _tag: 'Excluido' };
    },
  };
}
