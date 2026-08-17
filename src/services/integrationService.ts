import { supabaseServer } from '@/lib/supabaseServer';
import { normalizeToE164 } from '@/lib/utils';
import type { Cliente } from '@/types';
import type { VerifiedTenant } from '@/lib/auth';

export class IntegrationService {
  /**
   * Vincula os contatos do Chatwoot aos Clientes do ERP (Bling/Supabase).
   * Caso o cliente não exista, ele será criado automaticamente para ser enviado ao Bling no próximo sync.
   */
  async linkSacToErp(tenant: VerifiedTenant) {
    console.log('🔄 Iniciando verificação de auto-registro e vínculo SAC-ERP...');
    let novosClientes = 0;

    try {
      // 1. Buscar todos os contatos do Chatwoot que tenham telefone normalizado
      const { data: chatwootContacts, error: cwError } = await supabaseServer
        .from('chatwoot_contacts')
        .select('*')
        .eq('user_id', tenant.id)
        .not('phone_normalizado', 'is', null);

      if (cwError) throw cwError;

      // 2. Buscar todos os clientes existentes que tenham telefone normalizado
      const { data: clientes, error: clError } = await supabaseServer
        .from('clientes')
        .select('id, telefone_normalizado')
        .eq('user_id', tenant.id);

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
          console.log(`🆕 Novo contato no SAC encontrado: ${contact.name}. Criando cliente no ERP...`);
          
          const novoCliente: Cliente = {
            bling_id: `temp_${crypto.randomUUID().split('-')[0]}`, // Temporário, será substituído pelo SyncPush
            nome: contact.name || 'Cliente Chatwoot',
            email: contact.email || undefined,
            telefone: contact.phone_number || contact.phone_normalizado,
            telefone_normalizado: contact.phone_normalizado
          };

          const { error: insertError } = await supabaseServer
            .from('clientes')
            .insert([{ ...novoCliente, user_id: tenant.id }]);

          if (insertError) {
            console.error(`❌ Erro ao criar cliente auto-registrado (${contact.name}):`, insertError);
          } else {
            telefonesERP.add(contact.phone_normalizado); // Adiciona ao Set para evitar duplicidade na mesma rodada
            novosClientes++;
          }
        }
      }

      console.log(`✅ Verificação SAC-ERP concluída. +${novosClientes} clientes auto-registrados.`);
      return { success: true, novosClientes };
    } catch (error: any) {
      console.error('❌ Erro na integração SAC-ERP:', error);
      return { success: false, error: error.message };
    }
  }
}

export const integrationService = new IntegrationService();
