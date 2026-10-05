/**
 * CNPJ: normalizar, validar e formatar. Puro — a mesma regra no navegador e no
 * servidor. Era uma função local do Financeiro (`formatCNPJ`).
 */

/** Só os dígitos. */
export function digitosDoCnpj(valor: string): string {
  return valor.replace(/\D/gu, '');
}

function digitoVerificador(base: string): number {
  const pesos = base.length === 12
    ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const soma = [...base].reduce((total, digito, i) => total + Number(digito) * pesos[i]!, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** 14 dígitos com os dois verificadores corretos (e não uma sequência repetida). */
export function cnpjValido(valor: string): boolean {
  const digitos = digitosDoCnpj(valor);
  if (!/^\d{14}$/u.test(digitos) || /^(\d)\1{13}$/u.test(digitos)) return false;
  const primeiro = digitoVerificador(digitos.slice(0, 12));
  const segundo = digitoVerificador(digitos.slice(0, 12) + primeiro);
  return digitos.endsWith(`${primeiro}${segundo}`);
}

/** `12345678000190` → `12.345.678/0001-90`, formatando à medida que se digita. */
export function formatarCnpj(valor: string): string {
  const digitos = digitosDoCnpj(valor).slice(0, 14);
  return digitos
    .replace(/^(\d{2})(\d)/u, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/u, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/u, '.$1/$2')
    .replace(/(\d{4})(\d)/u, '$1-$2');
}
