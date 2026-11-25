import type { Atividade, AutorDaAtividade } from './historicoDeAtividades';

/** Como o histórico é lido na tela: título curto, dia e hora no fuso da loja. */

const FUSO = 'America/Sao_Paulo';
const CHAVE_DO_DIA = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
const DIA_NESTE_ANO = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'long', day: 'numeric', month: 'long' });
const DIA_DE_OUTRO_ANO = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: 'numeric', month: 'long', year: 'numeric' });
const HORA = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
const DATA_E_HORA = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, dateStyle: 'short', timeStyle: 'medium' });

function data(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function horaDaAtividade(iso: string): string {
  const d = data(iso);
  return d ? HORA.format(d) : '';
}

export function dataEHoraDaAtividade(iso: string): string {
  const d = data(iso);
  return d ? DATA_E_HORA.format(d) : iso;
}

/** "Hoje", "Ontem", "Terça-feira, 18 de novembro" ou, de outro ano, "3 de março de 2025". */
export function rotuloDoDia(iso: string, agora: Date): string {
  const d = data(iso);
  if (!d) return 'Data desconhecida';
  const dia = CHAVE_DO_DIA.format(d);
  const hoje = CHAVE_DO_DIA.format(agora);
  if (dia === hoje) return 'Hoje';
  if (dia === CHAVE_DO_DIA.format(new Date(agora.getTime() - 86_400_000))) return 'Ontem';
  const texto = (dia.slice(0, 4) === hoje.slice(0, 4) ? DIA_NESTE_ANO : DIA_DE_OUTRO_ANO).format(d);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export interface GrupoDoDia {
  readonly rotulo: string;
  readonly atividades: readonly Atividade[];
}

/** Agrupa a lista (já em ordem decrescente) por dia, sem reordenar nada. */
export function agruparPorDia(atividades: readonly Atividade[], agora: Date): GrupoDoDia[] {
  const grupos: { rotulo: string; atividades: Atividade[] }[] = [];
  for (const atividade of atividades) {
    const rotulo = rotuloDoDia(atividade.createdAt, agora);
    const ultimo = grupos.at(-1);
    if (ultimo?.rotulo === rotulo) ultimo.atividades.push(atividade);
    else grupos.push({ rotulo, atividades: [atividade] });
  }
  return grupos;
}

/** Duas letras do nome ("Maria Silva" → "MS"), ou "?" sem nome. */
export function iniciais(nome: string | null): string {
  const partes = (nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  const letras = partes.length === 1 ? partes[0].slice(0, 2) : partes[0][0] + partes[partes.length - 1][0];
  return letras.toUpperCase();
}

/**
 * O título curto de cada ação, na voz de quem a fez ("Salvou um produto").
 *
 * A descrição do catálogo de auditoria é escrita para quem audita e continua
 * nos detalhes; o título é o que uma pessoa lê de relance. Ação sem título
 * aqui cai na descrição do catálogo, então um evento novo nunca some da lista.
 */
const TITULO: Readonly<Record<string, string>> = {
  'auth.login_success': 'Entrou no sistema',
  'auth.login_failed': 'Tentou entrar com senha errada',
  'auth.password_reset_requested': 'Pediu para redefinir a senha',
  'membership.member_invited': 'Convidou um membro',
  'membership.member_removed': 'Removeu um membro',
  'membership.role_changed': 'Mudou o papel de um membro',
  'org.privileged_change': 'Alterou uma configuração da organização',
  'integration.connection_configured': 'Configurou uma integração',
  'integration.connection_authorized': 'Autorizou uma integração',
  'catalog.assistant_product_edit': 'Editou produtos pelo assistente',
  'catalog.product_saved': 'Salvou um produto',
  'catalog.product_save_rejected': 'Teve o cadastro de produto recusado pelo Bling',
  'catalog.product_reconcile_required': 'Deixou um produto para conferência',
  'catalog.product_image_uploaded': 'Enviou a foto de um produto',
  'catalog.product_image_removed': 'Removeu a foto de um produto',
  'catalog.product_image_bling_synced': 'Sincronizou a foto com o Bling',
  'catalog.product_image_bling_sync_pending': 'Deixou a foto aguardando o Bling',
  'catalog.product_image_bling_sync_failed': 'Não conseguiu sincronizar a foto com o Bling',
  'catalog.categories_synced': 'Sincronizou as categorias',
  'catalog.categories_sync_failed': 'Não concluiu a sincronização de categorias',
  'inventory.demo_debit_applied': 'Deu baixa no estoque',
  'customer.contact_saved': 'Salvou um contato',
  'customer.contact_deleted': 'Excluiu um contato',
  'customer.contact_save_rejected': 'Teve o cadastro de contato recusado pelo Bling',
  'customer.sac_contacts_registered': 'Cadastrou clientes vindos do atendimento',
  'order.manual_sale_recorded': 'Registrou uma venda manual',
  'order.status_changed': 'Mudou a situação de um pedido',
  'order.status_change_rejected': 'Teve a mudança de situação recusada pelo Bling',
  'order.updated': 'Editou um pedido',
  'order.deleted': 'Apagou um pedido',
  'finance.entry_deleted': 'Excluiu uma despesa',
  'finance.expense_cancelled': 'Cancelou uma despesa',
  'fiscal.document_issued': 'Emitiu uma NF-e',
  'chatwoot.send_confirmed': 'Confirmou a entrega de uma resposta',
  'chatwoot.send_rejected': 'Teve uma resposta recusada pelo Chatwoot',
  'chatwoot.send_invalidated': 'Cancelou uma resposta que estava na fila',
  'chatwoot.control_changed': 'Mudou quem atende uma conversa',
  'chatwoot.inbox_event_failed': 'Não conseguiu processar uma mensagem recebida',
  'sac.case_opened': 'Abriu um caso de atendimento',
  'sac.customer_verified': 'Confirmou o cliente de uma conversa',
  'sac.customer_verification_revoked': 'Desfez a confirmação de um cliente',
  'sac.order_lookup_blocked': 'Bloqueou consultas de pedido em uma conversa',
  'sac.policy_published': 'Publicou a política de atendimento',
  'sac.proposal_created': 'Criou uma proposta de resolução',
  'sac.proposal_edited': 'Editou uma proposta de resolução',
  'sac.proposal_approved': 'Aprovou uma proposta de resolução',
  'sac.proposal_rejected': 'Rejeitou uma proposta de resolução',
};

export function tituloDaAtividade(acao: string, autor: AutorDaAtividade, descricao: string): string {
  // A mesma ação tem dois sentidos: o bot respondendo sozinho, ou uma pessoa
  // respondendo pelo atendimento.
  if (acao === 'chatwoot.send_requested') {
    return autor.tipo === 'bot' ? 'Respondeu um cliente pelo WhatsApp' : 'Respondeu um cliente no atendimento';
  }
  return TITULO[acao] ?? descricao;
}
