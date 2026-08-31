import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { buildBlingCredentialsPayload, buildBlingVaultCredentials } from '../../../../lib/config/blingCredentialsContract';
import { credentialsVault } from '../../../../lib/integrations/credentialsVault';
import { createSupabaseBlingWebhookTenantStore, resolveSignedBlingConnection } from './tenants';

/**
 * A guarda do ticket 11.
 *
 * O teste antigo do webhook autenticava contra `integracoes_bling` semeada por
 * ele mesmo — por isso passou verde durante todo o período em que **nenhum**
 * evento real do Bling era aceito. Aqui a credencial é gravada pelo mesmo par
 * `buildBlingVaultCredentials` + `credentialsVault.saveEncryptedCredentials`
 * que `POST /api/bling/connect` usa, e lida de volta pelo caminho que o webhook
 * usa em produção. Se as duas pontas divergirem outra vez — nome de chave,
 * tabela, formato — este teste fica vermelho.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

/** Supabase mínimo em memória, cobrindo só o que o cofre e a porta de leitura tocam. */
function createFakeSupabase() {
  const conexoes: Array<{ id: string; organizacao_id: string; provedor: string }> = [];
  const credenciais: Array<{ conexao_id: string; organizacao_id: string; dados_cifrados: string; chave_versao: string }> = [];

  const client = {
    from(table: string) {
      if (table === 'conexoes_integracao') {
        return {
          select: () => ({
            eq: (_col: string, provedor: string) =>
              Promise.resolve({ data: conexoes.filter((c) => c.provedor === provedor), error: null }),
          }),
        };
      }
      if (table === 'credenciais_integracao') {
        return {
          upsert: (row: { conexao_id: string; organizacao_id: string; dados_cifrados: string; chave_versao: string }) => {
            const i = credenciais.findIndex((c) => c.conexao_id === row.conexao_id);
            if (i >= 0) credenciais[i] = row;
            else credenciais.push(row);
            return Promise.resolve({ error: null });
          },
          select: () => ({
            eq: (_c1: string, orgId: string) => ({
              eq: (_c2: string, conexaoId: string) => ({
                maybeSingle: () => {
                  const found = credenciais.find((c) => c.organizacao_id === orgId && c.conexao_id === conexaoId);
                  return Promise.resolve({ data: found ?? null, error: null });
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`Tabela inesperada no fake: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, conexoes };
}

/** Conecta o Bling como a rota real conecta: conexão + credencial cifrada no cofre. */
async function conectarBling(
  fake: ReturnType<typeof createFakeSupabase>,
  conexaoId: string,
  organizacaoId: string,
  clientSecret: string,
) {
  fake.conexoes.push({ id: conexaoId, organizacao_id: organizacaoId, provedor: 'bling' });
  const payload = buildBlingCredentialsPayload('client-id-qualquer', clientSecret);
  await credentialsVault.saveEncryptedCredentials(
    organizacaoId,
    conexaoId,
    buildBlingVaultCredentials(payload),
    'v1',
    fake.client,
  );
}

function assinar(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

describe('resolveSignedBlingConnection', () => {
  let fake: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    fake = createFakeSupabase();
  });

  it('autentica com a credencial que o fluxo real de conexão grava no cofre', async () => {
    await conectarBling(fake, 'conn-a', ORG_A, 'segredo-da-org-a');
    const rawBody = '{"event":"order.created","data":{"id":"123"}}';

    const result = await resolveSignedBlingConnection(
      createSupabaseBlingWebhookTenantStore(fake.client),
      rawBody,
      assinar(rawBody, 'segredo-da-org-a'),
    );

    expect(result).toEqual({
      _tag: 'ConnectionResolved',
      connection: { id: 'conn-a', organizacaoId: ORG_A },
    });
  });

  it('escolhe a conexão certa quando há várias organizações conectadas', async () => {
    await conectarBling(fake, 'conn-a', ORG_A, 'segredo-da-org-a');
    await conectarBling(fake, 'conn-b', ORG_B, 'segredo-da-org-b');
    const rawBody = '{"event":"order.deleted","data":{"id":"456"}}';

    const result = await resolveSignedBlingConnection(
      createSupabaseBlingWebhookTenantStore(fake.client),
      rawBody,
      assinar(rawBody, 'segredo-da-org-b'),
    );

    expect(result).toMatchObject({ _tag: 'ConnectionResolved', connection: { organizacaoId: ORG_B } });
  });

  it('recusa assinatura que não corresponde a nenhuma conexão', async () => {
    await conectarBling(fake, 'conn-a', ORG_A, 'segredo-da-org-a');
    const rawBody = '{"event":"order.created"}';

    const result = await resolveSignedBlingConnection(
      createSupabaseBlingWebhookTenantStore(fake.client),
      rawBody,
      assinar(rawBody, 'segredo-que-ninguem-tem'),
    );

    expect(result).toEqual({ _tag: 'SignatureUnmatched' });
  });

  it('recusa corpo adulterado assinado com o secret certo', async () => {
    await conectarBling(fake, 'conn-a', ORG_A, 'segredo-da-org-a');
    const assinatura = assinar('{"event":"order.created"}', 'segredo-da-org-a');

    const result = await resolveSignedBlingConnection(
      createSupabaseBlingWebhookTenantStore(fake.client),
      '{"event":"order.deleted"}',
      assinatura,
    );

    expect(result).toEqual({ _tag: 'SignatureUnmatched' });
  });

  it('distingue banco indisponível de assinatura inválida', async () => {
    const store = {
      listConnections: () => Promise.reject(new Error('conexão recusada')),
      getClientSecret: () => Promise.resolve(null),
    };

    const result = await resolveSignedBlingConnection(store, '{}', 'sha256=qualquer');

    expect(result).toEqual({ _tag: 'ConnectionStoreUnavailable', cause: 'conexão recusada' });
  });

  it('não autentica ninguém quando nenhuma organização conectou o Bling', async () => {
    const rawBody = '{"event":"order.created"}';

    const result = await resolveSignedBlingConnection(
      createSupabaseBlingWebhookTenantStore(fake.client),
      rawBody,
      assinar(rawBody, 'qualquer'),
    );

    expect(result).toEqual({ _tag: 'SignatureUnmatched' });
  });

  describe('cofre que não responde não vira "assinatura inválida"', () => {
    /** Porta cujo cofre falha para as conexões nomeadas e funciona para as outras. */
    function storeComCofreInstavel(
      conexoes: readonly { id: string; organizacaoId: string }[],
      segredos: Record<string, string>,
      falham: readonly string[],
    ) {
      return {
        listConnections: async () => conexoes,
        getClientSecret: async (c: { id: string }) => {
          if (falham.includes(c.id)) throw new Error('timeout ao ler o cofre');
          return segredos[c.id] ?? null;
        },
      };
    }

    it('responde SignatureUnconfirmable quando a única conexão não pôde ser conferida', async () => {
      const rawBody = '{"event":"order.deleted","data":{"id":"1"}}';

      const result = await resolveSignedBlingConnection(
        storeComCofreInstavel([{ id: 'conn-a', organizacaoId: ORG_A }], {}, ['conn-a']),
        rawBody,
        assinar(rawBody, 'segredo-da-org-a'),
      );

      // Dizer "inválida" afirmaria que a assinatura é falsa. Não sabemos: o
      // cofre não respondeu. A rota traduz isto em 503, não em 403.
      expect(result).toMatchObject({ _tag: 'SignatureUnconfirmable', conexoesAfetadas: ['conn-a'] });
    });

    it('uma conexão saudável continua autenticando mesmo com outra em falha', async () => {
      const rawBody = '{"event":"order.created","data":{"id":"2"}}';

      const result = await resolveSignedBlingConnection(
        storeComCofreInstavel(
          [{ id: 'conn-quebrada', organizacaoId: ORG_B }, { id: 'conn-a', organizacaoId: ORG_A }],
          { 'conn-a': 'segredo-da-org-a' },
          ['conn-quebrada'],
        ),
        rawBody,
        assinar(rawBody, 'segredo-da-org-a'),
      );

      // A falha de uma organização não pode derrubar o webhook das outras.
      expect(result).toEqual({
        _tag: 'ConnectionResolved',
        connection: { id: 'conn-a', organizacaoId: ORG_A },
      });
    });

    it('assinatura que não casa com a conexão saudável, havendo outra em falha, é inconclusiva', async () => {
      const rawBody = '{"event":"order.created","data":{"id":"3"}}';

      const result = await resolveSignedBlingConnection(
        storeComCofreInstavel(
          [{ id: 'conn-quebrada', organizacaoId: ORG_B }, { id: 'conn-a', organizacaoId: ORG_A }],
          { 'conn-a': 'segredo-da-org-a' },
          ['conn-quebrada'],
        ),
        rawBody,
        assinar(rawBody, 'segredo-que-nao-e-da-org-a'),
      );

      // Pode ser forjada, ou pode ser da conexão que não conseguimos conferir.
      // Falhar como "inconclusivo" é o único desfecho honesto.
      expect(result).toMatchObject({ _tag: 'SignatureUnconfirmable' });
    });

    it('sem nenhuma falha de cofre, assinatura que não casa continua sendo recusa definitiva', async () => {
      await conectarBling(fake, 'conn-a', ORG_A, 'segredo-da-org-a');
      const rawBody = '{"event":"order.created"}';

      const result = await resolveSignedBlingConnection(
        createSupabaseBlingWebhookTenantStore(fake.client),
        rawBody,
        assinar(rawBody, 'segredo-forjado'),
      );

      expect(result).toEqual({ _tag: 'SignatureUnmatched' });
    });
  });
});
