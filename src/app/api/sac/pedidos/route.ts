import { comFalhaSegura } from '../verificacao/rotas';

export const dynamic = 'force-dynamic';

/** Os pedidos do cliente confirmado na conversa. Sem confirmação válida, 409 e nenhum pedido. */
export const GET = comFalhaSegura('sac.pedidos.listar', 'listarPedidos');

/** Um pedido pelo número, procurado só entre os do cliente confirmado. */
export const POST = comFalhaSegura('sac.pedidos.localizar', 'localizarPedido');
