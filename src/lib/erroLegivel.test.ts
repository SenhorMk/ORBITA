import { describe, expect, it } from 'vitest';
import { descreverErro } from './erroLegivel';

describe('descreverErro', () => {
  it('nunca devolve [object Object] para o erro do PostgREST', () => {
    const postgrest = {
      code: '42P10',
      message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
      details: null,
      hint: null,
    };

    const descricao = descreverErro(postgrest);

    expect(descricao).not.toContain('[object Object]');
    expect(descricao).toContain('42P10');
    expect(descricao).toContain('ON CONFLICT');
  });

  it('inclui details e hint quando o Postgres os fornece', () => {
    const descricao = descreverErro({
      code: '23503',
      message: 'insert violates foreign key',
      details: 'Key (categoria_id)=(x) is not present in table "categorias".',
      hint: 'Sincronize as categorias antes dos produtos.',
    });

    expect(descricao).toContain('Key (categoria_id)');
    expect(descricao).toContain('dica: Sincronize as categorias');
  });

  it('preserva a mensagem de um Error comum', () => {
    expect(descreverErro(new Error('Bling devolveu 401'))).toBe('Bling devolveu 401');
  });

  it('anexa o código quando um Error também carrega code', () => {
    const err = Object.assign(new Error('permissão negada'), { code: '42501' });
    expect(descreverErro(err)).toBe('[42501] permissão negada');
  });

  it('serializa um objeto sem campos conhecidos em vez de perdê-lo', () => {
    expect(descreverErro({ status: 500, body: 'upstream' })).toBe('{"status":500,"body":"upstream"}');
  });

  it('atravessa string, null e undefined sem inventar nada', () => {
    expect(descreverErro('timeout')).toBe('timeout');
    expect(descreverErro(null)).toBe('null');
    expect(descreverErro(undefined)).toBe('undefined');
  });
});
