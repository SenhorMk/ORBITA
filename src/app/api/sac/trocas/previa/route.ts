import { z } from 'zod';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { lerRetratoDoPedido } from '@/services/sac/retratoDoPedido';
import { criarRotaDaPrevia } from './handler';

export const POST = criarRotaDaPrevia(resolveVerifiedOrganizationScope, {
  async casoAberto(escopo, conversaId) {
    const { data, error } = await supabaseServer.from('sac_cases').select('id')
      .eq('organizacao_id', escopo.organizationId).eq('conversa_id_local', conversaId)
      .not('phase', 'in', '(RESOLVED,CLOSED,CANCELLED)').maybeSingle();
    if (error) throw new Error('Caso de SAC indisponível.');
    return data === null ? null : z.object({ id: z.string().uuid() }).parse(data).id;
  },
  retrato: (escopo, conversaId, pedidoId) => lerRetratoDoPedido(supabaseServer, escopo, conversaId, pedidoId),
});
