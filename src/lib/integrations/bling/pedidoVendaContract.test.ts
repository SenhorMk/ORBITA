import { describe, expect, it } from 'vitest';

import {
  BLING_DUPLICATE_SALE_FIELD_CODE,
  parseBlingFailure,
  pedidoVendaCreatedSchema,
  pedidoVendaPayloadSchema,
} from './pedidoVendaContract';

/**
 * Payload que a rota montava antes deste ticket (`syncVendaToBling`).
 * Mantido literalmente para que o schema oficial continue provando a
 * divergência — se alguém reintroduzir essa forma, o teste acusa.
 */
const PAYLOAD_ANTERIOR = {
  contato: { id: 4321 },
  data: '2026-08-29',
  situacao: { id: 9 },
  itens: [{ descricao: 'Camiseta', quantidade: 2, valor: 49.9, produto: { id: 77 } }],
};

describe('contrato oficial de POST /pedidos/vendas', () => {
  it('rejeita o payload que a rota montava antes, por faltar campos obrigatórios do OpenAPI oficial', () => {
    const result = pedidoVendaPayloadSchema.safeParse(PAYLOAD_ANTERIOR);

    expect(result.success).toBe(false);
    const caminhosFaltando = result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join('.'));

    // Obrigatórios no schema oficial e ausentes no payload antigo.
    expect(caminhosFaltando).toContain('dataPrevista');
    expect(caminhosFaltando).toContain('dataSaida');
    expect(caminhosFaltando).toContain('parcelas');
    expect(caminhosFaltando).toContain('itens.0.valorLista');
  });

  it('recusa item sem produto.id, que a v3 valida por ID e o código antigo substituía por codigo', () => {
    const semProdutoId = {
      ...PAYLOAD_ANTERIOR,
      dataPrevista: '2026-08-29',
      dataSaida: '2026-08-29',
      parcelas: [{ dataVencimento: '2026-08-29', valor: 99.8, formaPagamento: { id: 12 } }],
      itens: [{ descricao: 'Camiseta', quantidade: 2, valor: 49.9, valorLista: 49.9, codigo: 'CAM-01' }],
    };

    expect(pedidoVendaPayloadSchema.safeParse(semProdutoId).success).toBe(false);
  });

  it('aceita um payload completo e ignora situacao, que é por conta e não deve ser fixada no código', () => {
    const completo = {
      contato: { id: 4321 },
      data: '2026-08-29',
      dataPrevista: '2026-08-29',
      dataSaida: '2026-08-29',
      itens: [{ descricao: 'Camiseta', quantidade: 2, valor: 49.9, valorLista: 49.9, produto: { id: 77 } }],
      parcelas: [{ dataVencimento: '2026-08-29', valor: 99.8, formaPagamento: { id: 12 } }],
    };

    const result = pedidoVendaPayloadSchema.safeParse(completo);
    expect(result.success).toBe(true);
    expect(result.success && 'situacao' in result.data).toBe(false);
  });

  it('exige data no formato AAAA-MM-DD, como o format: date do schema oficial', () => {
    const comDataISO = {
      contato: { id: 1 },
      data: new Date('2026-08-29T12:00:00.000Z').toISOString(),
      dataPrevista: '2026-08-29',
      dataSaida: '2026-08-29',
      itens: [{ descricao: 'X', quantidade: 1, valor: 1, valorLista: 1, produto: { id: 2 } }],
      parcelas: [{ dataVencimento: '2026-08-29', valor: 1, formaPagamento: { id: 3 } }],
    };

    expect(pedidoVendaPayloadSchema.safeParse(comDataISO).success).toBe(false);
  });
});

describe('resposta 201 de POST /pedidos/vendas', () => {
  it('extrai o id real e não presume um campo numero, que a criação não devolve', () => {
    const parsed = pedidoVendaCreatedSchema.parse({ data: { id: 918273 } });

    expect(parsed.data.id).toBe('918273');
    expect('numero' in parsed.data).toBe(false);
  });

  it('preserva alertas devolvidos junto com a criação', () => {
    const parsed = pedidoVendaCreatedSchema.parse({
      data: { id: '5', alertas: [{ code: 42, msg: 'Estoque insuficiente no depósito padrão' }] },
    });

    expect(parsed.data.alertas?.[0]?.msg).toContain('Estoque insuficiente');
  });

  it('recusa uma confirmação sem id, em vez de inventar um identificador', () => {
    expect(pedidoVendaCreatedSchema.safeParse({ data: {} }).success).toBe(false);
  });
});

describe('tradução de erro do Bling', () => {
  it('usa description e os campos inválidos em vez de devolver o JSON cru', () => {
    const corpo = JSON.stringify({
      error: {
        type: 'VALIDATION_ERROR',
        message: 'Erro de validação',
        description: 'Não foi possível salvar o pedido de venda',
        fields: [{ code: 10, msg: 'Campo obrigatório não informado', element: 'parcelas' }],
      },
    });

    const falha = parseBlingFailure(400, corpo);

    expect(falha.type).toBe('VALIDATION_ERROR');
    expect(falha.message).toContain('Não foi possível salvar o pedido de venda');
    expect(falha.message).toContain('parcelas: Campo obrigatório não informado');
    expect(falha.message).not.toContain('{');
    expect(falha.duplicateSale).toBe(false);
  });

  it('reconhece a recusa de venda duplicada pelo código estruturado, não por substring da mensagem', () => {
    const corpo = JSON.stringify({
      error: {
        type: 'VALIDATION_ERROR',
        description: 'Informações idênticas a última venda salva',
        fields: [{ code: BLING_DUPLICATE_SALE_FIELD_CODE, msg: 'Informações idênticas a última venda salva' }],
      },
    });

    expect(parseBlingFailure(400, corpo).duplicateSale).toBe(true);
  });

  it('degrada com mensagem própria quando o corpo não é o envelope da v3', () => {
    const falha = parseBlingFailure(502, '<html>Bad Gateway</html>');

    expect(falha.type).toBe('HTTP_502');
    expect(falha.duplicateSale).toBe(false);
    expect(falha.message.length).toBeGreaterThan(0);
  });
});
