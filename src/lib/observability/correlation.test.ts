import { describe, it, expect } from 'vitest';
import {
  generateCorrelationId,
  getCorrelationId,
  withCorrelationHeaders,
  CORRELATION_HEADER,
  REQUEST_ID_HEADER,
} from './correlation';

describe('correlation utility', () => {
  it('generateCorrelationId gera id prefixado com corr_', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^corr_[0-9a-f-]+$/);
  });

  it('getCorrelationId extrai header x-correlation-id existente', () => {
    const req = new Request('https://orbita.test/api/test', {
      headers: { [CORRELATION_HEADER]: 'corr_custom_123' },
    });
    expect(getCorrelationId(req)).toBe('corr_custom_123');
  });

  it('getCorrelationId extrai header x-request-id como fallback', () => {
    const req = new Request('https://orbita.test/api/test', {
      headers: { [REQUEST_ID_HEADER]: 'req_custom_456' },
    });
    expect(getCorrelationId(req)).toBe('req_custom_456');
  });

  it('getCorrelationId gera novo id se nenhum header for fornecido', () => {
    const req = new Request('https://orbita.test/api/test');
    const id = getCorrelationId(req);
    expect(id).toMatch(/^corr_/);
  });

  it('getCorrelationId rejeita header gigante e gera um novo id seguro', () => {
    const huge = 'a'.repeat(5000);
    const req = new Request('https://orbita.test/api/test', {
      headers: { [CORRELATION_HEADER]: huge },
    });
    const id = getCorrelationId(req);
    expect(id).not.toBe(huge);
    expect(id.length).toBeLessThan(200);
    expect(id).toMatch(/^corr_/);
  });

  it('getCorrelationId rejeita header malformado (caracteres fora do padrão seguro) e gera novo id', () => {
    const req = new Request('https://orbita.test/api/test', {
      headers: { [CORRELATION_HEADER]: 'corr_evil<script>alert(1)</script>' },
    });
    const id = getCorrelationId(req);
    expect(id).not.toContain('<script>');
    expect(id).toMatch(/^corr_[A-Za-z0-9_-]+$/);
  });

  it('getCorrelationId aceita id existente com formato seguro sem regenerar', () => {
    const req = new Request('https://orbita.test/api/test', {
      headers: { [CORRELATION_HEADER]: 'corr_abc-123_XYZ' },
    });
    expect(getCorrelationId(req)).toBe('corr_abc-123_XYZ');
  });

  it('withCorrelationHeaders propaga o correlation ID fornecido', () => {
    const base = { 'Content-Type': 'application/json' };
    const headers = withCorrelationHeaders(base, 'corr_test_789');

    expect(headers['content-type']).toBe('application/json');
    expect(headers[CORRELATION_HEADER]).toBe('corr_test_789');
    expect(headers[REQUEST_ID_HEADER]).toBe('corr_test_789');
  });
});
