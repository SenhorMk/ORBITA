import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogoDeAjuda } from './catalogo';

interface Superficie {
  readonly id: string;
  readonly availability?: string;
  readonly locations?: readonly { readonly file: string; readonly line: number }[];
}

const matriz: readonly Superficie[] = JSON.parse(readFileSync(resolve('docs/helpinfo/matriz.json'), 'utf8'));

describe('rastreabilidade da matriz HelpInfo recuperada', () => {
  it('mantém as superfícies originais e a movimentação de estoque do PR153, sem as duas listas técnicas removidas de Integrações', () => {
    const cobertas = matriz.filter((s) => !s.id.startsWith('legado.'));
    expect(cobertas.map((s) => s.id).sort()).toEqual(Object.keys(catalogoDeAjuda).sort());
    expect(cobertas).toHaveLength(64);
    expect(cobertas.some((s) => s.id === 'integracoes.inbox' || s.id === 'integracoes.envios')).toBe(false);
    expect(cobertas.filter((s) => s.availability)).toHaveLength(0);
    expect(cobertas.some((s) => s.id === 'estoque.movimentacoes')).toBe(true);
    expect(matriz.filter((s) => s.id.startsWith('legado.')).map((s) => s.id)).toEqual(['legado.pedidos']);
  });

  it('monta cada ajuda em seus componentes atuais, sem contar a galeria como cobertura', () => {
    for (const superficie of matriz.filter((s) => !s.id.startsWith('legado.'))) {
      expect(superficie.locations?.length, superficie.id).toBeGreaterThan(0);
      for (const local of superficie.locations ?? []) {
        expect(local.file).toMatch(/^src\/(app|components)\//);
        expect(local.file).not.toMatch(/\.test\./);
        expect(readFileSync(resolve(local.file), 'utf8'), superficie.id).toContain(`ajudaId="${superficie.id}"`);
      }
    }
  });
});
