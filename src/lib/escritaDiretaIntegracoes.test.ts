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
 * PRE-008: o inventário das tabelas de integração
 * (`docs/security/inventario-escrita-direta-integracoes.md`) como regra.
 *
 * Desde a migration 84 `authenticated` não tem INSERT/UPDATE/DELETE em
 * `conexoes_integracao` nem em `chatwoot_inboxes`, e nunca teve acesso a
 * `credenciais_integracao` e `integracoes_bling`: um caller do navegador
 * falharia com 42501. Este teste o barra antes, no commit, e fixa quem grava do
 * lado do servidor.
 */

const TABELAS = ['conexoes_integracao', 'chatwoot_inboxes', 'credenciais_integracao', 'integracoes_bling'] as const;
const NOMEIA_TABELA = /\b(conexoes_integracao|chatwoot_inboxes|credenciais_integracao|integracoes_bling)\b/;

/**
 * Quem grava direto nas tabelas de integração, sempre do servidor. Mudou?
 * Atualize o inventário: um gravador novo precisa de escopo verificado,
 * capacidade e (para reativar conexão) auditoria decididos.
 */
const GRAVADORES_DO_SERVIDOR: Record<string, readonly string[]> = {
  // OAuth: `pendente` → cofre → `conectado`, organização da transação OAuth;
  // e o espelho legado, que o `service_role` nem pode gravar (best-effort).
  'src/app/api/bling/callback/route.ts': ['conexoes_integracao', 'integracoes_bling'],
  // `POST /api/bling/connect` e `POST /api/chatwoot/connect` (organization:manage).
  'src/app/api/bling/connect/route.ts': ['conexoes_integracao'],
  'src/app/api/chatwoot/connect/route.ts': ['conexoes_integracao'],
  // O cofre: upsert e remoção por (organização, conexão).
  'src/lib/integrations/credentialsVault.ts': ['credenciais_integracao'],
  // O mapping de inbox: só depois de webhook assinado ou sync com as
  // credenciais da própria organização.
  'src/services/chatwoot/chatwootInboxRegistration.ts': ['chatwoot_inboxes'],
};

/** Gravadores que recebem o cliente por parâmetro; os callers têm de passar o `supabaseServer`. */
const GRAVADORES_POR_PARAMETRO: Record<string, { funcao: string; callers: readonly string[] }> = {
  'src/services/chatwoot/chatwootInboxRegistration.ts': {
    funcao: 'registerChatwootInboxIfNeeded',
    callers: ['src/app/api/chatwoot/sync/route.ts'],
  },
};

const acessos = (fonte: string) => acessosEm(fonte, TABELAS);

const fontes = fontesDoProduto();
const navegador = fontes.filter(({ fonte }) => doNavegador(fonte));
const fonteDe = (caminho: string) => fontes.find((f) => f.caminho === caminho)!.fonte;

describe('escrita direta nas tabelas de integração pelo navegador (PRE-008)', () => {
  it('o inventário enxerga os arquivos do navegador (o detector não está cego)', () => {
    // A tela de Integrações: fala com `/api/<provedor>/connect`, nunca com a tabela.
    expect(navegador.map((a) => a.caminho)).toContain('src/components/integracoes/IntegrationsPanel.tsx');
  });

  it('nenhum arquivo do navegador nomeia as tabelas de integração (nem por .from, nem por embed)', () => {
    expect(navegador.filter(({ fonte }) => NOMEIA_TABELA.test(fonte)).map((a) => a.caminho)).toEqual([]);
  });

  it('nenhum arquivo do navegador consulta tabela por nome não literal nem chama RPC', () => {
    expect(navegador.filter(({ fonte }) => fromNaoLiteral(fonte) || /\bsupabase\s*\.\s*rpc\(/.test(fonte))
      .map((a) => a.caminho)).toEqual([]);
  });

  it('quem executa como o usuário no servidor não acessa as tabelas de integração', () => {
    expect(fontes.filter(({ fonte }) => comSessaoDoUsuario(fonte) && NOMEIA_TABELA.test(fonte))
      .map((a) => a.caminho)).toEqual([]);
  });
});

describe('gravadores do servidor nas tabelas de integração (PRE-008)', () => {
  it('são exatamente os inventariados', () => {
    const gravadores: Record<string, string[]> = {};
    for (const { caminho, fonte } of fontes) {
      const tabelas = [...new Set(acessos(fonte).filter(({ cadeia }) => escreve(cadeia)).map((a) => a.tabela))].sort();
      if (tabelas.length > 0) gravadores[caminho] = tabelas;
    }
    expect(gravadores).toEqual(GRAVADORES_DO_SERVIDOR);
  });

  it('todos usam o service role: direto, ou recebido de callers que só passam o supabaseServer', () => {
    for (const caminho of Object.keys(GRAVADORES_DO_SERVIDOR)) {
      const porParametro = GRAVADORES_POR_PARAMETRO[caminho];
      if (!porParametro) {
        expect(fonteDe(caminho), caminho).toMatch(/\bsupabaseServer\b/);
        continue;
      }
      // A chamada, não a declaração: `function nome(` fica de fora.
      const chamada = new RegExp(`(?<!function )\\b${porParametro.funcao}\\(([^,]+),`, 'g');
      const chamadas = (fonte: string) => [...fonte.matchAll(chamada)].map((m) => m[1]!.trim());
      const callers = fontes.filter(({ fonte }) => chamadas(fonte).length > 0).map((a) => a.caminho).sort();
      expect(callers, porParametro.funcao).toEqual([...porParametro.callers].sort());
      for (const caller of callers) {
        const clientes = chamadas(fonteDe(caller));
        expect(clientes, caller).toEqual(clientes.map(() => 'supabaseServer'));
      }
    }
  });

  it('as rotas de conexão exigem organization:manage e tiram a organização da sessão verificada', () => {
    for (const rota of ['src/app/api/bling/connect/route.ts', 'src/app/api/chatwoot/connect/route.ts']) {
      const fonte = fonteDe(rota);
      expect(fonte, rota).toMatch(/capabilities\.has\('organization:manage'\)/);
      expect(fonte, rota).toMatch(/resolveActiveRequestOrganizationContext\(request\)/);
      // A organização gravada é a do escopo, nunca um campo do corpo.
      expect(fonte, rota).not.toMatch(/organizacao_id:\s*(body|parsed|payload)/);
    }
  });
});
