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
 * PRE-007A: o inventário da escrita direta financeira
 * (`docs/security/inventario-escrita-direta-financeira.md`) como regra.
 *
 * Desde a migration 82 `authenticated` não tem INSERT/UPDATE/DELETE em
 * `titulos_financeiros`, `fornecedores`, `contas_financeiras` e
 * `categorias_financeiras`: um caller do navegador falharia com 42501. Este
 * teste o barra antes, no commit, e fixa quem grava do lado do servidor.
 */

const TABELAS = ['titulos_financeiros', 'fornecedores', 'contas_financeiras', 'categorias_financeiras'] as const;

/**
 * Quem grava direto nas quatro tabelas, sempre com `supabaseServer`
 * (service role, organização do escopo verificado). Mudou? Atualize o
 * inventário: um gravador novo precisa de capacidade e auditoria decididas.
 */
const GRAVADORES_DO_SERVIDOR: Record<string, readonly string[]> = {
  // `upsertTitulo` (despesa e sincronização), `vincularPedidos` (sincronização) e, enquanto a
  // fatia 2 não entra, o DELETE/UPDATE das correções de título.
  'src/repositories/financeiroRepository.ts': ['titulos_financeiros'],
};

const acessos = (fonte: string) => acessosEm(fonte, TABELAS);

const fontes = fontesDoProduto();
const navegador = fontes.filter(({ fonte }) => doNavegador(fonte));

describe('escrita direta financeira pelo navegador (PRE-007A)', () => {
  it('o inventário enxerga os arquivos do navegador (o detector não está cego)', () => {
    expect(navegador.map((a) => a.caminho)).toContain('src/components/financeiro/LancamentoDeDespesa.tsx');
  });

  it('nenhum arquivo do navegador lê nem grava as quatro tabelas', () => {
    const tocadas = navegador.flatMap(({ caminho, fonte }) => acessos(fonte).map(({ tabela }) => `${caminho} → ${tabela}`));
    expect(tocadas).toEqual([]);
  });

  it('nenhum arquivo do navegador consulta tabela por nome não literal nem chama RPC', () => {
    expect(navegador.filter(({ fonte }) => fromNaoLiteral(fonte) || /\bsupabase\s*\.\s*rpc\(/.test(fonte))
      .map((a) => a.caminho)).toEqual([]);
  });

  it('quem executa como o usuário no servidor não acessa as quatro tabelas', () => {
    const comSessao = fontes
      .filter(({ fonte }) => comSessaoDoUsuario(fonte))
      .flatMap(({ caminho, fonte }) => acessos(fonte).map(({ tabela }) => `${caminho} → ${tabela}`));
    expect(comSessao).toEqual([]);
  });
});

describe('gravadores do servidor nas quatro tabelas (PRE-007A)', () => {
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
});
