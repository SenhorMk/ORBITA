import { describe, expect, it } from 'vitest';

import {
  acessos as acessosEm,
  comSessaoDoUsuario,
  doNavegador,
  escreve,
  fontesDoProduto,
  fromNaoLiteral,
} from './__testkit__/escritaDireta';

/**
 * PRE-007B: o inventário da escrita direta fiscal
 * (`docs/security/inventario-escrita-direta-fiscal.md`) como regra.
 *
 * Desde a migration 83 `authenticated` não tem INSERT/UPDATE/DELETE em
 * `documentos_fiscais`: um caller do navegador falharia com 42501. Este teste
 * o barra antes, no commit, e fixa quem grava do lado do servidor.
 */

const TABELAS = ['documentos_fiscais'] as const;

/**
 * Quem grava direto em `documentos_fiscais`, sempre com `supabaseServer`
 * (service role, organização do escopo verificado). Mudou? Atualize o
 * inventário: um gravador novo precisa de capacidade e auditoria decididas.
 */
const GRAVADORES_DO_SERVIDOR: Record<string, readonly string[]> = {
  // `upsertNfe`, chamado só por `POST /api/nfe` (organization:manage), enquanto a
  // fatia 2 não passa o registro para a RPC auditada.
  'src/repositories/pedidoRepository.ts': ['documentos_fiscais'],
};

const acessos = (fonte: string) => acessosEm(fonte, TABELAS);

const fontes = fontesDoProduto();
const navegador = fontes.filter(({ fonte }) => doNavegador(fonte));

describe('escrita direta fiscal pelo navegador (PRE-007B)', () => {
  it('o inventário enxerga os arquivos do navegador (o detector não está cego)', () => {
    // A tela que fatura: fala com `POST /api/nfe`, nunca com a tabela.
    expect(navegador.map((a) => a.caminho)).toContain('src/app/page.tsx');
  });

  it('nenhum arquivo do navegador nomeia documentos_fiscais (nem por .from, nem por embed)', () => {
    expect(navegador.filter(({ fonte }) => /\bdocumentos_fiscais\b/.test(fonte)).map((a) => a.caminho)).toEqual([]);
  });

  it('nenhum arquivo do navegador consulta tabela por nome não literal nem chama RPC', () => {
    expect(navegador.filter(({ fonte }) => fromNaoLiteral(fonte) || /\bsupabase\s*\.\s*rpc\(/.test(fonte))
      .map((a) => a.caminho)).toEqual([]);
  });

  it('quem executa como o usuário no servidor não acessa documentos_fiscais', () => {
    expect(fontes.filter(({ fonte }) => comSessaoDoUsuario(fonte) && /\bdocumentos_fiscais\b/.test(fonte))
      .map((a) => a.caminho)).toEqual([]);
  });
});

describe('gravadores do servidor em documentos_fiscais (PRE-007B)', () => {
  it('são exatamente os inventariados, e todos usam o cliente service role', () => {
    const gravadores: Record<string, string[]> = {};
    for (const { caminho, fonte } of fontes) {
      const tabelas = [...new Set(acessos(fonte).filter(({ cadeia }) => escreve(cadeia)).map((a) => a.tabela))].sort();
      if (tabelas.length > 0) gravadores[caminho] = tabelas;
    }
    expect(gravadores).toEqual(GRAVADORES_DO_SERVIDOR);
    for (const caminho of Object.keys(gravadores)) {
      expect(fontes.find((f) => f.caminho === caminho)!.fonte).toMatch(/\bsupabaseServer\b/);
    }
  });

  it('o único caller do gravador é POST /api/nfe, que exige organization:manage', () => {
    const callers = fontes.filter(({ fonte }) => /\.upsertNfe\(/.test(fonte)).map((a) => a.caminho);
    expect(callers).toEqual(['src/app/api/nfe/route.ts']);
    expect(fontes.find((f) => f.caminho === 'src/app/api/nfe/route.ts')!.fonte)
      .toMatch(/escopoTemCapacidade\(scope, 'organization:manage'\)/);
  });
});
