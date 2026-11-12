import { comFalhaSegura } from '../../verificacao/rotas';

export const dynamic = 'force-dynamic';

/** O retrato de um pedido do cliente confirmado na conversa: itens, estoque, pagamento, rastreio e frescor. Só leitura. */
export const GET = comFalhaSegura('sac.pedidos.retrato', 'lerRetrato');
