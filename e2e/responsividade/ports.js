import { fetchWithAuth as base, forbidden, reads, writes } from '../helpinfo/ports';
import { id, titulos } from './data';
export { forbidden, reads, writes };
export async function fetchWithAuth(url, options = {}) {
  if (options.method && options.method !== 'GET') return forbidden();
  if (url === '/api/integracoes/outbox') return Response.json({ success: true, versao: 1, eventos: [] });
  if (url === '/api/sac/casos') return Response.json({ success: true, versao: 1, eventos: [{ id, tipo: 'message_created', estado: 'processada', disposicao: 'caso_aberto', motivo: null, tentativas: 1, casoId: null, recebidaEm: '2026-11-22T12:00:00Z', processadaEm: '2026-11-22T12:00:01Z' }], casos: [] });
  if (url === '/api/integracoes/saude') return Response.json({ success: true, conexoes: ['bling', 'chatwoot'].map(provedor => ({ id: `${id}-${provedor}`, provedor, nome: 'Inspeção', status: 'conectado', credenciais_configuradas: true, health_status: 'healthy', last_health_check_at: '2026-11-22T12:00:00Z', last_health_error: null })), bling_callback_url: 'https://example.invalid/callback', chatwoot_webhook_url: null });
  if (url === '/api/financeiro' || url.startsWith('/api/financeiro?')) return Response.json({ success: true, data: { titulos, categorias: [], resumo: { receitas: 753, despesas: 753, saldo: 0 } } });
  if (url.includes('/membros')) return Response.json({ membros: [{ user_id: id, papel: 'owner', created_at: '2026-11-20', nome_exibicao: 'Pessoa de inspeção', origem_do_nome: 'perfil' }] });
  if (url.includes('/convites')) return Response.json({ convites: [{ id, email: 'convite@example.invalid', papel: 'member', status: 'pending' }] });
  return base(url, options);
}
