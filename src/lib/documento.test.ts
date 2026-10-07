import { describe, expect, it } from 'vitest';

import { cnpjValido, cpfValido, formatarCnpj, tipoDePessoaDoDocumento } from './documento';

describe('CNPJ', () => {
  it('valida os dígitos verificadores, com ou sem máscara', () => {
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('33.000.167/0001-01')).toBe(true);
  });

  it('recusa verificador errado, sequência repetida, incompleto e longo demais', () => {
    expect(cnpjValido('11.222.333/0001-80')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
    expect(cnpjValido('00000000000000')).toBe(false);
    expect(cnpjValido('1122233300018')).toBe(false);
    expect(cnpjValido('112223330001811')).toBe(false);
  });

  it('formata enquanto se digita', () => {
    expect(formatarCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatarCnpj('1122')).toBe('11.22');
  });
});

describe('CPF', () => {
  it('valida os dígitos verificadores e recusa repetição', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('52998224724')).toBe(false);
    expect(cpfValido('11111111111')).toBe(false);
    expect(cpfValido('5299822472')).toBe(false);
  });
});

describe('o tipo de pessoa que um documento indica', () => {
  it('só documento VÁLIDO indica algo; tamanho sozinho não', () => {
    expect(tipoDePessoaDoDocumento('11.222.333/0001-81')).toBe('J');
    expect(tipoDePessoaDoDocumento('529.982.247-25')).toBe('F');
    expect(tipoDePessoaDoDocumento('11222333000180')).toBeNull();
    expect(tipoDePessoaDoDocumento('12345678901')).toBeNull();
    expect(tipoDePessoaDoDocumento('')).toBeNull();
  });
});
