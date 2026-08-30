import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda estrutural contra **tipo que mente sobre o schema do Bling**.
 *
 * `bling-endpoints.test.ts` já impede chamar um caminho que não existe. Esta
 * guarda cuida do passo seguinte: o caminho existe, a resposta chega, e o
 * tipo TypeScript descreve errado o que veio.
 *
 * Foi assim que a etapa de pedidos morreu. `BlingPedido.situacao.valor` estava
 * declarado `string` e é `integer` no schema oficial. `mapBlingStatus` fazia
 * `status.trim()` — e o TypeScript, confiando na declaração, garantia que
 * aquilo era seguro. Em produção virou `e.trim is not a function`, sem
 * nenhuma pista de onde. Junto vinham `id`, `numero` e `contato.id`, todos
 * `integer` declarados como `string`; `valorunitario`, campo que o Bling não
 * tem; e `itens` declarado obrigatório quando a listagem não o devolve —
 * um `for...of` sobre `undefined` esperando para acontecer.
 *
 * O catálogo em `docs/integrations/bling-v3-schemas.json` é extraído do
 * OpenAPI oficial. Este teste compara campo a campo e falha no commit.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

interface CampoOficial {
  readonly tipo: string;
  readonly formato?: string;
  readonly ref?: string;
}

interface SchemaOficial {
  readonly obrigatorios: readonly string[];
  readonly campos: Readonly<Record<string, CampoOficial>>;
}

interface CatalogoDeSchemas {
  readonly schemas: Readonly<Record<string, SchemaOficial>>;
}

const catalogo = JSON.parse(
  readFileSync(path.join(RAIZ, 'docs/integrations/bling-v3-schemas.json'), 'utf8'),
) as CatalogoDeSchemas;

const fonteDosTipos = readFileSync(path.join(RAIZ, 'src/types/index.ts'), 'utf8');

/**
 * Campos de um bloco de interface, achatados por caminho.
 *
 * Um objeto declarado inline (`contato: { id: number }`) vira as chaves
 * `contato` e `contato.id`, para que a comparação alcance o mesmo nível de
 * aninhamento que os DTOs do Bling têm.
 */
export function camposDeclarados(fonte: string, nomeInterface: string): Map<string, string> {
  const abertura = new RegExp(String.raw`export interface ${nomeInterface} \{`, 'u').exec(fonte);
  if (!abertura) throw new Error(`interface ${nomeInterface} não encontrada`);

  const campos = new Map<string, string>();
  const caminho: string[] = [];
  let profundidade = 0;
  const i = abertura.index + abertura[0].length;

  // Sem comentários: um `/** ... */` pode conter chaves e desalinharia a conta.
  const corpo = fonte.slice(i).replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');

  const linhas = corpo.split('\n');
  for (const linha of linhas) {
    const limpa = linha.trim();
    if (limpa === '') continue;

    // Fim da interface: fecha no nível 0.
    if (limpa.startsWith('}') && profundidade === 0) break;

    if (limpa.startsWith('}')) {
      profundidade -= 1;
      caminho.pop();
      continue;
    }

    const declaracao = /^([a-zA-Z_][a-zA-Z0-9_]*)\??:\s*(.*)$/u.exec(limpa);
    if (!declaracao) continue;

    const nome = declaracao[1]!;
    const resto = declaracao[2]!.trim();
    const completo = [...caminho, nome].join('.');

    if (resto.startsWith('{')) {
      // Objeto inline aberto nesta linha e fechado adiante.
      campos.set(completo, 'object');
      if (!resto.includes('}')) {
        caminho.push(nome);
        profundidade += 1;
      }
      continue;
    }

    campos.set(completo, resto.replace(/;$/u, '').trim());
  }

  return campos;
}

/** O tipo TypeScript declarado é compatível com o tipo do OpenAPI? */
export function tipoCompativel(tsDeclarado: string, oficial: CampoOficial): boolean {
  const ts = tsDeclarado.replace(/\s/gu, '');

  if (oficial.tipo === 'integer' || oficial.tipo === 'number') return ts === 'number';
  if (oficial.tipo === 'boolean') return ts === 'boolean';
  if (oficial.tipo === 'string') {
    // União de literais ('F' | 'J' | 'E') é um string mais estreito, e vale.
    return ts === 'string' || /^'[^']*'(\|'[^']*')*$/u.test(ts);
  }
  // array e object são estruturais: a forma é conferida no nível de baixo.
  return true;
}

/**
 * Cada bloco de tipo nosso e o schema oficial que ele espelha.
 *
 * `BlingPedido` mistura os dois DTOs de propósito: a listagem devolve
 * `VendasDadosBaseDTO` e o detalhe devolve ele somado a `VendasDadosDTO`.
 */
const FRONTEIRAS = [
  { tipo: 'BlingPedido', prefixo: '', dtos: ['VendasDadosBaseDTO', 'VendasDadosDTO'] },
  { tipo: 'BlingPedido', prefixo: 'situacao', dtos: ['VendasSituacaoDTO'] },
  { tipo: 'BlingPedido', prefixo: 'contato', dtos: ['VendasContatoDTO'] },
  { tipo: 'BlingItemPedido', prefixo: '', dtos: ['VendasItemDTO'] },
  { tipo: 'BlingItemPedido', prefixo: 'produto', dtos: ['VendasItemProdutoDTO'] },
] as const;

function camposOficiais(dtos: readonly string[]): Record<string, CampoOficial> {
  const unido: Record<string, CampoOficial> = {};
  for (const dto of dtos) {
    const schema = catalogo.schemas[dto];
    if (!schema) throw new Error(`schema oficial ausente no catálogo: ${dto}`);
    Object.assign(unido, schema.campos);
  }
  return unido;
}

describe('os tipos Bling* não podem divergir do schema oficial', () => {
  it('o catálogo oficial foi carregado', () => {
    expect(Object.keys(catalogo.schemas).length).toBeGreaterThanOrEqual(6);
    expect(catalogo.schemas.VendasSituacaoDTO?.campos.valor?.tipo).toBe('integer');
  });

  it('situacao.valor é integer — declarar string derrubou a sincronização inteira', () => {
    const campos = camposDeclarados(fonteDosTipos, 'BlingPedido');
    expect(campos.get('situacao.valor')).toBe('number');
  });

  it('itens é opcional — a listagem de pedidos não devolve itens', () => {
    const bloco = /export interface BlingPedido \{[\s\S]*?\n\}/u.exec(fonteDosTipos)![0];
    expect(bloco).toMatch(/itens\?:/u);
  });

  it.each(FRONTEIRAS.map((f) => [`${f.tipo}${f.prefixo ? '.' + f.prefixo : ''} vs ${f.dtos.join(' + ')}`, f] as const))(
    '%s',
    (_rotulo, fronteira) => {
      const declarados = camposDeclarados(fonteDosTipos, fronteira.tipo);
      const oficiais = camposOficiais(fronteira.dtos);

      const nossos = [...declarados.entries()]
        .filter(([caminho]) =>
          fronteira.prefixo
            ? caminho.startsWith(`${fronteira.prefixo}.`)
              && caminho.slice(fronteira.prefixo.length + 1).split('.').length === 1
            : !caminho.includes('.'),
        )
        .map(([caminho, tipo]) => [caminho.split('.').pop()!, tipo] as const);

      expect(nossos.length, `nenhum campo lido de ${fronteira.tipo}`).toBeGreaterThan(0);

      const fantasmas = nossos.filter(([nome]) => !(nome in oficiais)).map(([nome]) => nome);
      expect(
        fantasmas,
        `Campos que o schema oficial do Bling não tem: ${fantasmas.join(', ')}. `
          + 'O Bling aceita e descarta em silêncio o que não conhece; na leitura, o campo chega sempre undefined.',
      ).toEqual([]);

      const divergentes = nossos
        .filter(([nome, ts]) => nome in oficiais && !tipoCompativel(ts, oficiais[nome]!))
        .map(([nome, ts]) => `${nome}: declarado \`${ts}\`, oficial \`${oficiais[nome]!.tipo}\``);

      expect(
        divergentes,
        `Tipos divergentes do schema oficial: ${divergentes.join('; ')}. `
          + 'Foi assim que `situacao.valor` virou `e.trim is not a function` em produção.',
      ).toEqual([]);
    },
  );
});
