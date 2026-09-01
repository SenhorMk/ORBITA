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
    const payload = categories.map((category) => ({
      organizacao_id: scope.organizationId,
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
