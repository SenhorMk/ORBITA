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
    // A chave de conflito é a organização — `(organizacao_id, bling_id)`, o que
    // `uq_categorias_org_bling` indexa, conferido pela guarda
    // `upsert-conflito-inferivel`.
    //
    // `user_id` entra só no PAYLOAD, como "quem gravou" (o mesmo papel que tem
    // em `ClienteRepository.upsert`): a coluna é `NOT NULL` sem default em
    // `public.categorias`, e omiti-la faria todo upsert falhar com `23502`. A
    // tenancy é `organizacao_id`, não `user_id`.
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
