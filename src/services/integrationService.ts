import { supabaseServer } from '../lib/supabaseServer';
import type { Cliente } from '../types';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';

export class IntegrationService {
  /**
   * Vincula os contatos do Chatwoot aos Clientes do ERP (Bling/Supabase).
   * Caso o cliente não exista, ele será criado automaticamente para ser enviado ao Bling no próximo sync.
   */
  async linkSacToErp(scope: VerifiedOrganizationScope) {
    let novosClientes = 0;

    try {
      // 1. Buscar todos os contatos do Chatwoot que tenham telefone normalizado
      const { data: chatwootContacts, error: cwError } = await supabaseServer
        .from('chatwoot_contacts')
        .select('*')
        .eq('organizacao_id', scope.organizationId)
        .not('phone_normalizado', 'is', null);

      if (cwError) throw cwError;

      // 2. Buscar todos os clientes existentes que tenham telefone normalizado
      const { data: clientes, error: clError } = await supabaseServer
        .from('clientes')
        .select('id, telefone_normalizado')
        .eq('organizacao_id', scope.organizationId);

      if (clError) throw clError;

      // Criar um Set rápido de telefones já registrados no ERP
      const telefonesERP = new Set(
        clientes.map(c => c.telefone_normalizado).filter(Boolean)
      );

      // 3. Identificar os contatos do Chatwoot que NÃO existem nos Clientes
      for (const contact of chatwootContacts) {
        if (!contact.phone_normalizado) continue;

        // Regra 1: O telefone já existe na base?
        const telefoneExiste = telefonesERP.has(contact.phone_normalizado);

        if (!telefoneExiste) {

          const novoCliente: Cliente = {
            bling_id: `temp_${crypto.randomUUID().split('-')[0]}`, // Temporário, será substituído pelo SyncPush
            nome: contact.name || 'Cliente Chatwoot',
            email: contact.email || undefined,
            telefone: contact.phone_number || contact.phone_normalizado,
            telefone_normalizado: contact.phone_normalizado
          };

          const { error: insertError } = await supabaseServer
            .from('clientes')
            .insert([{
              ...novoCliente,
              user_id: scope.actorId,
              organizacao_id: scope.organizationId,
            }]);

          if (insertError) {
            console.error(`❌ Erro ao criar cliente auto-registrado (${contact.name}):`, insertError);
          } else {
            telefonesERP.add(contact.phone_normalizado); // Adiciona ao Set para evitar duplicidade na mesma rodada
            novosClientes++;
          }
        }
      }

      return { success: true, novosClientes };
    } catch (error: unknown) {
      console.error('❌ Erro na integração SAC-ERP:', error);
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errMsg };
    }
  }
}

export const integrationService = new IntegrationService();
