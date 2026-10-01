/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { escopoDaLeitura, mudouDeInstancia, useSessaoComGeracao } from './geracaoDaSessao';

const ana = { email: 'ana' };

describe('geração da sessão', () => {
  it('entrar, sair e trocar de conta são instâncias novas; revalidar a mesma conta não é', () => {
    expect(mudouDeInstancia(null, ana)).toBe(true);
    expect(mudouDeInstancia(ana, null)).toBe(true);
    expect(mudouDeInstancia(ana, { email: 'bia' })).toBe(true);
    expect(mudouDeInstancia(ana, { email: 'ana' })).toBe(false);
    expect(mudouDeInstancia(null, null)).toBe(false);
  });

  it('sair e entrar com a mesma conta avança a geração, e o escopo muda com a mesma organização e versão', () => {
    const { result } = renderHook(() => useSessaoComGeracao<{ email: string }>(() => ana));
    const antes = escopoDaLeitura({ geracao: result.current.geracao, identidade: 'ana' }, { id: 'org-a', versao: 7 });

    act(() => result.current.definirSessao(null));
    act(() => result.current.definirSessao({ email: 'ana' }));

    expect(result.current.geracao).toBe(2);
    const depois = escopoDaLeitura({ geracao: result.current.geracao, identidade: 'ana' }, { id: 'org-a', versao: 7 });
    expect(depois).not.toBe(antes);
  });

  it('renovar o token / restaurar a mesma sessão não troca a geração (o painel não recarrega à toa)', () => {
    const { result } = renderHook(() => useSessaoComGeracao<{ email: string }>(() => ana));
    act(() => result.current.definirSessao({ email: 'ana' }));
    expect(result.current.geracao).toBe(0);
  });

  it('sem sessão não há escopo', () => {
    expect(escopoDaLeitura({ geracao: 3, identidade: null }, { id: 'org-a', versao: 7 })).toBeNull();
  });

  it('page.tsx compõe o escopo com a geração, pela mesma função', () => {
    const pagina = readFileSync(path.resolve(__dirname, '../../app/page.tsx'), 'utf8');
    expect(pagina).toContain('useSessaoComGeracao<UserSession>(');
    expect(pagina).toMatch(/comporEscopoDaLeitura\(\s*\{ geracao: geracaoDaSessao, identidade: identidadeDaSessao \}/u);
    expect(pagina).not.toMatch(/useState<UserSession \| null>/u);
  });
});
