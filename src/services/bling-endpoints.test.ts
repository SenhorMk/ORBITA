import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda estrutural contra caminho inexistente na API do Bling.
 *
 * Três vezes seguidas um caminho ou parâmetro que **não existe** passou
 * despercebido, porque o Bling responde sem reclamar do que não conhece:
 *
 * - Ticket 31: `GET /produtos?codigo=` — o filtro é `codigos[]`. O provedor
 *   ignorava e devolvia a listagem inteira, o que virava um PUT destrutivo.
 * - Ticket 32: `fone` e `contribuinte` em `/contatos` — os campos são
 *   `telefone` e `indicadorIe`. Os valores eram descartados em silêncio.
 * - Ticket 33: `GET /contas-financeiras` — o caminho é `/contas-contabeis`.
 *   O 404 caía num `return []` e parecia "conta sem portador nenhum".
 *
 * Este teste compara cada caminho que `src/services/bling.ts` monta com a
 * lista oficial em `docs/integrations/bling-v3-paths.json`, extraída do
 * OpenAPI publicado pelo Bling. Um caminho inventado passa a falhar aqui, no
 * commit, em vez de em produção sem mensagem.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

interface CatalogoDePaths {
  readonly paths: readonly string[];
}

const catalogo = JSON.parse(
  readFileSync(path.join(RAIZ, 'docs/integrations/bling-v3-paths.json'), 'utf8'),
) as CatalogoDePaths;

const fonteDoAdapter = readFileSync(path.join(RAIZ, 'src/services/bling.ts'), 'utf8');

/**
 * Extrai os caminhos que o adapter monta sobre `this.baseUrl`, normalizando
 * interpolações (`${id}`) para o marcador de parâmetro do OpenAPI.
 */
export function extrairCaminhosChamados(fonte: string): string[] {
  const encontrados = new Set<string>();
  const padrao = /\$\{this\.baseUrl\}(\/[^`'"?\s]*)/gu;

  for (const correspondencia of fonte.matchAll(padrao)) {
    const bruto = correspondencia[1]!;
    // `${...}` vira `{param}`; a comparação é por forma, não por valor.
    const normalizado = bruto.replace(/\$\{[^}]*\}/gu, '{param}').replace(/\/+$/u, '');
    if (normalizado) encontrados.add(normalizado);
  }

  return [...encontrados].sort();
}

/** Mesma normalização do lado do catálogo oficial. */
function normalizarOficial(caminho: string): string {
  return caminho.replace(/\{[^}]*\}/gu, '{param}');
}

describe('caminhos do Bling usados pelo adapter', () => {
  const oficiais = new Set(catalogo.paths.map(normalizarOficial));
  const chamados = extrairCaminhosChamados(fonteDoAdapter);

  it('o catálogo oficial foi carregado', () => {
    expect(catalogo.paths.length).toBeGreaterThan(100);
  });

  it('o adapter realmente monta caminhos sobre baseUrl', () => {
    expect(chamados.length).toBeGreaterThan(10);
  });

  it('todo caminho chamado existe no OpenAPI oficial do Bling', () => {
    const inexistentes = chamados.filter((caminho) => !oficiais.has(caminho));

    expect(
      inexistentes,
      `Caminhos ausentes do OpenAPI oficial: ${inexistentes.join(', ')}. `
        + 'Confira em docs/integrations/bling-v3-paths.json — o Bling responde sem reclamar do que não conhece.',
    ).toEqual([]);
  });

  it('reconhece um caminho inventado', () => {
    // Guarda da própria guarda: o extrator precisa enxergar o caminho para o
    // teste acima ter valor.
    const chamadosFalsos = extrairCaminhosChamados('await this.fetchWithAuth(`${this.baseUrl}/nao-existe`)');

    expect(chamadosFalsos).toEqual(['/nao-existe']);
    expect(oficiais.has('/nao-existe')).toBe(false);
  });

  it('normaliza interpolação de id para o parâmetro do OpenAPI', () => {
    const chamadosComId = extrairCaminhosChamados(
      'this.fetchWithAuth(`${this.baseUrl}/pedidos/vendas/${idPedido}/situacoes/${idSituacao}`)',
    );

    expect(chamadosComId).toEqual(['/pedidos/vendas/{param}/situacoes/{param}']);
    expect(oficiais.has(chamadosComId[0]!)).toBe(true);
  });
});
