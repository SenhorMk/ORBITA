import { err, ok } from './script-result.mjs';

/**
 * Opções de `scripts/migracoes-remotas.mjs`, lidas e validadas antes de
 * qualquer conexão com o banco alvo.
 */

const OPCOES_COM_VALOR = new Set(['--url', '--ate-arquivo', '--ate-ordem']);
const OPCOES_BOOLEANAS = new Set(['--aplicar', '--confirmar', '--adotar', '--previa']);

/**
 * Lê **todas** as opções de uma vez, antes de qualquer conexão. Recusa o que
 * faria a ferramenta ignorar em silêncio um pedido: opção desconhecida ou
 * repetida (`--ate-arquivo a --ate-arquivo b` — qual vale?), opção sem valor,
 * argumento solto, e combinações incompatíveis:
 *
 * - `--ate-arquivo` com `--ate-ordem`;
 * - `--adotar` com qualquer limite, com `--aplicar` ou com `--previa` (adotar
 *   marca o ledger inteiro, então um limite seria ignorado);
 * - `--previa` com `--aplicar`.
 *
 * Limites:
 * - `--ate-arquivo <nome.sql>`: o nome canônico exato (`80_comandos_de_clientes_e_pedidos.sql`).
 *   Um número aqui seria ambíguo entre o prefixo do nome e o ordinal do
 *   ledger, que são diferentes (o `80_…` é o ordinal 83).
 * - `--ate-ordem <n>`: o `order` do ledger (`database/migrations.lock.json`).
 *
 * @param {readonly string[]} argv - Os argumentos depois do script (`process.argv.slice(2)`).
 * @returns {{ readonly _tag: 'ok', readonly value: { readonly url: string | undefined, readonly limite: { readonly _tag: 'SemLimite' } | { readonly _tag: 'Arquivo', readonly nome: string } | { readonly _tag: 'Ordem', readonly ordem: number }, readonly aplicar: boolean, readonly confirmar: boolean, readonly adotar: boolean, readonly previa: boolean } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function lerOpcoes(argv) {
  const valores = new Map();
  const vistas = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) return err('ArgumentoInesperado', `Argumento sem opção: "${token.slice(0, 40)}".`);
    if (!OPCOES_COM_VALOR.has(token) && !OPCOES_BOOLEANAS.has(token)) {
      return err('OpcaoDesconhecida', `Opção desconhecida: ${token.slice(0, 40)}.`);
    }
    if (vistas.has(token)) return err('OpcaoRepetida', `${token} informada mais de uma vez.`);
    vistas.add(token);
    if (OPCOES_COM_VALOR.has(token)) {
      const valor = argv[i + 1];
      if (valor === undefined || valor.startsWith('--')) {
        return err(token === '--url' ? 'AlvoSemValor' : 'LimiteSemValor', `${token} precisa de um valor.`);
      }
      valores.set(token, valor);
      i += 1;
    }
  }

  const arquivo = valores.get('--ate-arquivo');
  const ordem = valores.get('--ate-ordem');
  const adotar = vistas.has('--adotar');
  const aplicar = vistas.has('--aplicar');
  const previa = vistas.has('--previa');

  if (arquivo !== undefined && ordem !== undefined) {
    return err('LimiteAmbiguo', 'Use --ate-arquivo OU --ate-ordem, não os dois.');
  }
  if (adotar && (arquivo !== undefined || ordem !== undefined)) {
    return err('CombinacaoIncompativel', '--adotar marca o ledger inteiro; um limite seria ignorado. Não combine.');
  }
  if (adotar && (aplicar || previa)) {
    return err('CombinacaoIncompativel', '--adotar não combina com --aplicar nem com --previa.');
  }
  if (previa && aplicar) return err('CombinacaoIncompativel', '--previa é somente leitura; não combina com --aplicar.');

  let limite = { _tag: 'SemLimite' };
  if (arquivo !== undefined) {
    if (!/^\d+_[a-z0-9_]+\.sql$/u.test(arquivo)) {
      return err('LimiteInvalido', `--ate-arquivo espera o nome canônico exato do arquivo (ex.: 80_comandos_de_clientes_e_pedidos.sql), não "${arquivo.slice(0, 60)}".`);
    }
    limite = { _tag: 'Arquivo', nome: arquivo };
  } else if (ordem !== undefined) {
    if (!/^[1-9]\d*$/u.test(ordem)) return err('LimiteInvalido', `--ate-ordem espera um inteiro positivo, não "${ordem.slice(0, 20)}".`);
    limite = { _tag: 'Ordem', ordem: Number(ordem) };
  }

  return ok(Object.freeze({
    url: valores.get('--url'),
    limite,
    aplicar,
    confirmar: vistas.has('--confirmar'),
    adotar,
    previa,
  }));
}

/**
 * O limite das opções (mesmas recusas de `lerOpcoes`).
 *
 * @param {readonly string[]} argv
 * @returns {{ readonly _tag: 'ok', readonly value: { readonly _tag: 'SemLimite' } | { readonly _tag: 'Arquivo', readonly nome: string } | { readonly _tag: 'Ordem', readonly ordem: number } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function lerLimite(argv) {
  const opcoes = lerOpcoes(argv);
  return opcoes._tag === 'err' ? opcoes : ok(opcoes.value.limite);
}
