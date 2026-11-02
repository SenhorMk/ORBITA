/**
 * A porta do BLING na venda manual: as seis chamadas ao ERP que este fluxo
 * faz, e o que cada resposta significa.
 *
 * Separada de `ports.ts` porque é a superfície do fluxo que fala com o ERP;
 * as demais portas falam com o banco. `ports.ts` reexporta, então quem
 * consome importa de um lugar só.
 *
 * O caminho até o fornecedor, em camadas:
 * regra do ORBITA (`handler.ts`, `reconciliacao.ts`) → este port (o que a
 * venda precisa do ERP) → adapter `blingManualOrderAdapter` (`dependencias.ts`,
 * só repassa) → `BlingClient` (`services/bling.ts`, faz o HTTP) → contratos
 * Zod (`lib/integrations/bling/pedidoVendaContract.ts`) → API do Bling.
 */
import type { ContatoTipo, IndicadorIe } from '@/lib/config/clienteContract';
import type { BlingCallResult, BuscaDePedidoPorNumeroLoja, PedidoVendaPayload } from '@/lib/integrations/bling/pedidoVendaContract';

export interface ManualOrderBlingPort {
  /** `GET /formas-pagamentos` — a forma marcada como padrão na conta do proprietário. */
  getDefaultFormaPagamentoId(): Promise<BlingCallResult<number>>;
  /**
   * `POST /contatos` — usado quando o cliente local ainda não tem cadastro no Bling.
   * `tipo` e `indicadorIe` são os do cadastro, nunca deduzidos do documento.
   */
  createContato(input: {
    nome: string;
    email: string | null;
    telefone: string | null;
    documento: string | null;
    tipo: ContatoTipo;
    indicadorIe: IndicadorIe;
  }): Promise<BlingCallResult<{ id: number }>>;
  /** `POST /pedidos/vendas` — o payload já vem validado contra o schema oficial. */
  createPedidoVenda(payload: PedidoVendaPayload): Promise<BlingCallResult<{ id: string; alertas: readonly string[] }>>;
  /** `POST /pedidos/vendas/{id}/lancar-estoque` — baixa vinculada ao pedido, no depósito padrão. */
  lancarEstoquePedido(pedidoBlingId: string): Promise<BlingCallResult<void>>;
  /**
   * `GET /pedidos/vendas?numerosLojas[]=<referencia>` — procura o pedido pela
   * referência local que o ORBITA enviou em `numeroLoja` na criação.
   *
   * É a peça que torna a reconciliação possível SEM `bling_id`: quando
   * `createPedidoVenda` não devolve resposta, o ORBITA não sabe o id do pedido
   * — mas sabe a referência, porque ela foi decidida antes do envio.
   *
   * `NenhumPedido` significa "o Bling respondeu, e esta consulta não viu pedido
   * com essa referência". É diferente de uma falha de consulta (`BlingFailed`),
   * mas o ORBITA **não** a trata como prova de que o pedido nunca foi criado.
   * `UmPedido` e `VariosPedidos` são conferidos
   * por igualdade exata de `numeroLoja` no adapter.
   */
  buscarPedidoPorNumeroLoja(numeroLoja: string): Promise<BlingCallResult<BuscaDePedidoPorNumeroLoja>>;
  /**
   * Compensação: marca como cancelado um pedido que o Bling aceitou e o ORBITA
   * não conseguiu gravar.
   *
   * Cancelar, e não apagar. Apagar destruiria o rastro de que a venda chegou a
   * existir no ERP; cancelado é um estado legítimo que diz "isto não vale", e
   * a sincronização traz o pedido cancelado para cá — os dois lados convergem
   * em vez de um esquecer.
   */
  cancelarPedidoVenda(pedidoBlingId: string): Promise<BlingCallResult<void>>;
}
