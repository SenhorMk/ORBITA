import { z } from 'zod';

import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import {
  CategoryCatalog,
  type CategorySource,
  type CategoryStore,
} from '@/services/categoryCatalog';

import { createCategoryHandlers } from './handlers';

const categoryRowsSchema = z.array(z.object({
  id: z.uuid(),
  bling_id: z.string().min(1),
  descricao: z.string(),
  categoria_pai_id: z.string().nullable(),
}));

const categorySource: CategorySource = {
  async fetchPage(scope, page, pageSize) {
    const categories = await bling.forVerifiedOrganization(scope).getCategoriasProdutos(page, pageSize);
    return categories.map((category) => ({
      blingId: String(category.id),
      description: category.descricao,
      parentBlingId: category.categoriaPai?.id
        ? String(category.categoriaPai.id)
        : null,
    }));
  },
};

const categoryStore: CategoryStore = {
  async list(scope) {
    const { data, error } = await supabaseServer
      .from('categorias')
      .select('id, bling_id, descricao, categoria_pai_id')
      .eq('organizacao_id', scope.organizationId)
      .order('descricao', { ascending: true });

    if (error) throw error;

    return categoryRowsSchema.parse(data ?? []).map((category) => ({
      id: category.id,
      blingId: category.bling_id,
      description: category.descricao,
      parentBlingId: category.categoria_pai_id,
    }));
  },

  async upsertAll(scope, categories) {
    // Ticket 22 — era `user_id: tenant.id` com `onConflict: 'user_id, bling_id'`:
    // o modelo de tenancy por usuário, vivo num caminho de **escrita**. A chave
    // passa a ser a organização, que é o que `uq_categorias_org_bling` indexa —
    // e a guarda `upsert-conflito-inferivel` confere os dois lados.
    //
    // O `user_id` voltou ao PAYLOAD, e só a ele. A coluna continua
    // `NOT NULL` sem default em `public.categorias`, então omiti-la fazia todo
    // upsert morrer com `23502` — e a importação de categorias estava quebrada
    // para **qualquer** organização desde então: `categorias` com zero linhas no
    // staging, seletor de categoria do produto permanentemente vazio, e a causa
    // engolida por um `catch {}` sem parâmetro. Aqui ele é "quem gravou", o
    // mesmo papel que tem em `ClienteRepository.upsert`; a tenancy segue sendo
    // `organizacao_id`, e o conflito segue sendo `(organizacao_id, bling_id)`.
    //
    // Preenchê-lo não exige migration, e é por isso que não há uma nesta PR.
    const payload = categories.map((category) => ({
      organizacao_id: scope.organizationId,
      user_id: scope.actorId,
      bling_id: category.blingId,
      descricao: category.description,
      categoria_pai_id: category.parentBlingId,
    }));
    const { error } = await supabaseServer
      .from('categorias')
      .upsert(payload, { onConflict: 'organizacao_id, bling_id' });

    if (error) throw error;
  },
};

const handlers = createCategoryHandlers({
  resolveScope: resolveVerifiedOrganizationScope,
  catalog: new CategoryCatalog(categorySource, categoryStore),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
