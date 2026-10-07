/**
 * CPF e CNPJ: normalizar, validar e formatar. Puro: a mesma regra no
 * navegador e no servidor.
 *
 * Validar o documento diz se ele é **bem formado**. Não diz nada sobre
 * tributação: ter CNPJ não torna ninguém contribuinte de ICMS.
 */

/** Só os dígitos. */
export function digitosDoDocumento(valor: string): string {
  return valor.replace(/\D/gu, '');
}

/** Dígito verificador módulo 11 com os pesos dados. */
function digitoVerificador(base: string, pesos: readonly number[]): number {
  const soma = [...base].reduce((total, digito, i) => total + Number(digito) * pesos[i]!, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, ...PESOS_CNPJ_1];

/** 14 dígitos com os dois verificadores corretos (e não uma sequência repetida). */
export function cnpjValido(valor: string): boolean {
  const d = digitosDoDocumento(valor);
  if (!/^\d{14}$/u.test(d) || /^(\d)\1{13}$/u.test(d)) return false;
  const primeiro = digitoVerificador(d.slice(0, 12), PESOS_CNPJ_1);
  const segundo = digitoVerificador(d.slice(0, 12) + primeiro, PESOS_CNPJ_2);
  return d.endsWith(`${primeiro}${segundo}`);
}

/** 11 dígitos com os dois verificadores corretos (e não uma sequência repetida). */
export function cpfValido(valor: string): boolean {
  const d = digitosDoDocumento(valor);
  if (!/^\d{11}$/u.test(d) || /^(\d)\1{10}$/u.test(d)) return false;
  const primeiro = digitoVerificador(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = digitoVerificador(d.slice(0, 9) + primeiro, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d.endsWith(`${primeiro}${segundo}`);
}

/**
 * O tipo de pessoa que um documento **válido** indica: CNPJ → `J`, CPF → `F`.
 * Documento incompleto ou com verificador errado não indica nada.
 */
export function tipoDePessoaDoDocumento(valor: string): 'J' | 'F' | null {
  if (cnpjValido(valor)) return 'J';
  if (cpfValido(valor)) return 'F';
  return null;
}

/** `12345678000190` → `12.345.678/0001-90`, formatando à medida que se digita. */
export function formatarCnpj(valor: string): string {
  const digitos = digitosDoDocumento(valor).slice(0, 14);
  return digitos
    .replace(/^(\d{2})(\d)/u, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/u, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/u, '.$1/$2')
    .replace(/(\d{4})(\d)/u, '$1-$2');
}
