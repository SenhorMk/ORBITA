import { describe, expect, it } from 'vitest';

import { fontesDoProduto } from './__testkit__/escritaDireta';

/**
 * MSG-003A: nenhum caller novo das chaves globais dos espelhos do Chatwoot.
 *
 * Webhook e sync gravam e localizam pelo UUID local através do store
 * (`espelhoChatwootSupabase.ts`), que recebe a tabela de `TABELA_DO_RECURSO`
 * e sempre filtra organização + conexão. Quem ainda nomeia as tabelas está
 * listado com o ticket que o migra; a lista só encolhe.
 */

const NOMEIA_ESPELHO = /\bchatwoot_(contacts|conversations|messages)\b/;

const LEITORES_LEGADOS: Record<string, string> = {
  // O mapa recurso → tabela, consumido só pelo store.
  'src/services/chatwoot/identidadeChatwoot.ts': 'MSG-003A (store)',
  // Leitura e tempo real do navegador pelo UUID local, sob RLS (MSG-003B).
  'src/components/mensageria/espelhoDaMensageria.ts': 'leitura por UUID local',
  'src/components/mensageria/useMensageria.ts': 'comentário',
  // Lê os contatos da organização inteira para o vínculo SAC → ERP; não busca por id.
  'src/services/integrationService.ts': 'leitura por organização',
  // Retenção por id legado, via RPC da migration 51: contração no MSG-004.
  'src/services/privacy/adapters/retentionDbAdapter.ts': 'MSG-004',
};

const fontes = fontesDoProduto();

describe('chaves globais dos espelhos do Chatwoot (MSG-003A)', () => {
  it('o detector enxerga o store (não está cego)', () => {
    expect(fontes.map((f) => f.caminho)).toContain('src/services/chatwoot/espelhoChatwootSupabase.ts');
  });

  it('só os arquivos listados nomeiam as tabelas de espelho', () => {
    const nomeiam = fontes.filter(({ fonte }) => NOMEIA_ESPELHO.test(fonte)).map((f) => f.caminho).sort();
    expect(nomeiam).toEqual(Object.keys(LEITORES_LEGADOS).sort());
  });

  it('webhook, sync, envio e status não tocam as tabelas: passam pelo espelho e pelo resolver', () => {
    for (const caminho of [
      'src/app/api/chatwoot/sync/route.ts',
      'src/app/api/chatwoot/send/route.ts',
      'src/app/api/chatwoot/status/route.ts',
      'src/services/chatwoot/chatwootWebhookService.ts',
      'src/services/chatwoot/chatwootWebhookPersistence.ts',
      'src/services/chatwoot/espelhoChatwoot.ts',
    ]) {
      const fonte = fontes.find((f) => f.caminho === caminho)!.fonte;
      expect(NOMEIA_ESPELHO.test(fonte), caminho).toBe(false);
    }
  });

  it('só o store consulta pelo mapa recurso → tabela', () => {
    const usam = fontes.filter(({ fonte }) => /\.from\(\s*TABELA_DO_RECURSO\b/.test(fonte)).map((f) => f.caminho);
    expect(usam).toEqual(['src/services/chatwoot/espelhoChatwootSupabase.ts']);
  });

  it('fora do store, ninguém grava nos espelhos (MSG-003B)', () => {
    const gravam = Object.keys(LEITORES_LEGADOS).filter((caminho) => {
      const fonte = fontes.find((f) => f.caminho === caminho)?.fonte ?? '';
      return /\.from\(\s*['"]chatwoot_(contacts|conversations|messages)['"]\s*\)[^;]*\.(insert|update|upsert|delete)\(/.test(fonte);
    });
    expect(gravam).toEqual([]);
  });

  it('o navegador não lê nem assina pelo id remoto', () => {
    const fonte = fontes.find((f) => f.caminho === 'src/components/mensageria/espelhoDaMensageria.ts')!.fonte;
    expect(fonte).not.toMatch(/conversation_id|contact_id_fkey|select\('\*/u);
    for (const caminho of ['src/components/mensageria/useEnvio.ts', 'src/components/mensageria/useMensageria.ts']) {
      const hook = fontes.find((f) => f.caminho === caminho)!.fonte;
      expect(hook, caminho).not.toMatch(/conversationId|(?:conversa|selecionada\??)\.id(?!_)/u);
    }
  });
});
