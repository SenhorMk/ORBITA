import { z } from 'zod';

import { resolveActorContext } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabaseServer';
import { bling } from '@/services/bling';
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
  async fetchPage(tenant, page, pageSize) {
    const categories = await bling.forUser(tenant).getCategoriasProdutos(page, pageSize);
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
  async list(tenant) {
    const { data, error } = await supabaseServer
      .from('categorias')
      .select('id, bling_id, descricao, categoria_pai_id')
      .eq('user_id', tenant.id)
      .order('descricao', { ascending: true });

    if (error) throw error;

    return categoryRowsSchema.parse(data ?? []).map((category) => ({
      id: category.id,
      blingId: category.bling_id,
      description: category.descricao,
      parentBlingId: category.categoria_pai_id,
    }));
  },

  async upsertAll(tenant, categories) {
    const payload = categories.map((category) => ({
      user_id: tenant.id,
      bling_id: category.blingId,
      descricao: category.description,
      categoria_pai_id: category.parentBlingId,
    }));
    const { error } = await supabaseServer
      .from('categorias')
      .upsert(payload, { onConflict: 'user_id, bling_id' });

    if (error) throw error;
  },
};

const handlers = createCategoryHandlers({
  resolveActor: resolveActorContext,
  catalog: new CategoryCatalog(categorySource, categoryStore),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
