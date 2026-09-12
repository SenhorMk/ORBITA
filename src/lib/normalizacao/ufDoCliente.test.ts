import { describe, expect, it } from 'vitest';

import { normalizarUf } from './ufDoCliente';

describe('normalizarUf', () => {
  it('persiste a sigla em maiúsculas', () => {
    expect(normalizarUf('pr')).toBe('PR');
    expect(normalizarUf('SP')).toBe('SP');
    expect(normalizarUf(' rj ')).toBe('RJ');
  });

  it('a string vazia do formulário vira NULL, e não um texto de tamanho zero', () => {
    // Era exatamente este valor que atravessava até o Postgres e batia em
    // `chk_cliente_uf` — depois de o contato já ter sido criado no Bling.
    expect(normalizarUf('')).toBeNull();
    expect(normalizarUf('   ')).toBeNull();
  });

  it('ausência vira NULL', () => {
    expect(normalizarUf(undefined)).toBeNull();
    expect(normalizarUf(null)).toBeNull();
  });

  it('NULL explícito é o que faz a remoção de uma UF existente acontecer', () => {
    // Num upsert do supabase-js, chave com `undefined` desaparece na
    // serialização: no update a coluna ficaria como estava, e apagar a UF de um
    // contato não apagaria nada. `null` é o que apaga.
    expect(normalizarUf('')).not.toBeUndefined();
    expect(normalizarUf('')).toBeNull();
  });

  it('o que não tem dois caracteres não é gravado como se fosse UF', () => {
    // A recusa de formato é do contrato, antes daqui. Esta é a rede embaixo, e
    // uma rede não adivinha: não corta "XYZ" para "XY".
    expect(normalizarUf('XYZ')).toBeNull();
    expect(normalizarUf('P')).toBeNull();
  });

  it('valor que não é texto vira NULL', () => {
    expect(normalizarUf(42)).toBeNull();
    expect(normalizarUf({ uf: 'PR' })).toBeNull();
  });
});
