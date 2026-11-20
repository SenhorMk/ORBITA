import { describe, expect, it } from 'vitest';

import { diaEmSaoPaulo, formatarDataDoPedido, idadeDaDataDoPedido } from './dataDoPedido';

// Caso real do staging (20/11/2026): venda manual às 23:23 de 19/11 em Brasília, pedido #28.
const VENDA_AS_23H_DE_19_11 = new Date('2026-11-20T02:23:19.187Z');

describe('data da venda manual', () => {
  it('é o dia em Brasília, não o dia UTC (venda depois das 21h)', () => {
    expect(diaEmSaoPaulo(VENDA_AS_23H_DE_19_11)).toBe('2026-11-19');
  });

  it('não muda o dia de uma venda à tarde', () => {
    expect(diaEmSaoPaulo(new Date('2026-08-29T15:30:00.000Z'))).toBe('2026-08-29');
  });

  it('vira o dia à meia-noite de Brasília', () => {
    expect(diaEmSaoPaulo(new Date('2026-11-20T02:59:59.000Z'))).toBe('2026-11-19');
    expect(diaEmSaoPaulo(new Date('2026-11-20T03:00:00.000Z'))).toBe('2026-11-20');
  });
});

describe('exibição da data do pedido', () => {
  // Como o banco devolve `pedidos.data`: meia-noite UTC do dia de negócio.
  const DATA_GUARDADA = '2026-11-19T00:00:00+00:00';

  it('mostra o dia guardado, sem deslocar para o dia anterior e sem hora inventada', () => {
    expect(formatarDataDoPedido(DATA_GUARDADA)).toBe('19/11');
    expect(formatarDataDoPedido(DATA_GUARDADA, true)).toBe('19/11/2026');
    expect(formatarDataDoPedido('2026-11-19')).toBe('19/11');
  });

  it('data ilegível vira travessão', () => {
    expect(formatarDataDoPedido(null)).toBe('—');
    expect(formatarDataDoPedido('não é data')).toBe('—');
  });

  it('idade em dias contra hoje em Brasília', () => {
    expect(idadeDaDataDoPedido(DATA_GUARDADA, VENDA_AS_23H_DE_19_11.getTime())).toBe('hoje');
    expect(idadeDaDataDoPedido(DATA_GUARDADA, Date.parse('2026-11-20T15:00:00Z'))).toBe('ontem');
    expect(idadeDaDataDoPedido('2026-10-05T00:00:00+00:00', Date.parse('2026-11-20T15:00:00Z'))).toBe('há 46 dias');
    expect(idadeDaDataDoPedido(undefined)).toBeNull();
  });
});
