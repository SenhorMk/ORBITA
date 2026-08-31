import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { credentialsVault, redactSensitiveData, createConnectionInputSchema } from './credentialsVault';

describe('CredentialsVault & Redaction Boundary', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;
  const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = testKey;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEnv;
    vi.restoreAllMocks();
  });

  describe('createConnectionInputSchema', () => {
    it('validates connection input schema correctly', () => {
      const valid = {
        organizacao_id: '95000000-0000-4000-8000-000000000001',
        provedor: 'bling',
        nome: 'Conexao Principal',
        status: 'conectado',
        metadata: { accountId: '123' },
      };
      const parsed = createConnectionInputSchema.safeParse(valid);
      expect(parsed.success).toBe(true);
    });

    it('rejects invalid provider or malformed uuid', () => {
      const invalid = {
        organizacao_id: 'not-a-uuid',
        provedor: 'invalid-provider',
      };
      const parsed = createConnectionInputSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  describe('redactSensitiveData', () => {
    it('redacts sensitive fields in shallow and deep structures', () => {
      const payload = {
        name: 'Integration Config',
        client_id: 'client-123',
        client_secret: 'super-secret-secret',
        tokens: {
          access_token: 'raw-access-token',
          refresh_token: 'raw-refresh-token',
          expires_in: 3600,
        },
        metadata: {
          account: 'Empresa Alpha',
          api_key: 'private-api-key',
        },
      };

      const redacted = redactSensitiveData(payload) as typeof payload;

      expect(redacted.name).toBe('Integration Config');
      expect(redacted.client_id).toBe('client-123');
      expect(redacted.client_secret).toBe('[REDACTED]');
      // Desde a unificacao da politica (ticket 03b), uma CHAVE sensivel redige
      // o valor inteiro, inclusive quando ele e um objeto. `tokens` casa com o
      // padrao, entao some por completo — e some junto o `expires_in`, que era
      // diagnostico. E o preco certo: a regra anterior descia no objeto e
      // deixaria passar `{ secret: { valor: ... } }`, cuja chave interna nao
      // casa com nada.
      expect(redacted.tokens).toBe('[REDACTED]');
      expect(redacted.metadata.account).toBe('Empresa Alpha');
      expect(redacted.metadata.api_key).toBe('[REDACTED]');
    });

    it('handles arrays and null/primitive inputs gracefully', () => {
      expect(redactSensitiveData(null)).toBeNull();
      expect(redactSensitiveData(undefined)).toBeUndefined();
      expect(redactSensitiveData('text')).toBe('text');
      expect(redactSensitiveData(123)).toBe(123);

      const arrayInput = [
        { password: '123', label: 'Item 1' },
        { webhook_secret: 'whsec_abc', label: 'Item 2' },
      ];
      const arrayRedacted = redactSensitiveData(arrayInput) as Array<{ password: string; webhook_secret?: string; label: string }>;
      expect(arrayRedacted[0]?.password).toBe('[REDACTED]');
      expect(arrayRedacted[0]?.label).toBe('Item 1');
      expect(arrayRedacted[1]?.webhook_secret).toBe('[REDACTED]');
    });
  });

  describe('saveEncryptedCredentials & getDecryptedCredentials', () => {
    it('encrypts credentials at rest and decrypts accurately', async () => {
      let storedRow: Record<string, unknown> | null = null;

      const mockClient = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'credenciais_integracao') {
            return {
              upsert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
                storedRow = { ...payload };
                return Promise.resolve({ error: null });
              }),
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((col1: string, val1: string) => ({
                  eq: vi.fn().mockImplementation((col2: string, val2: string) => ({
                    maybeSingle: vi.fn().mockImplementation(() => {
                      if (
                        storedRow &&
                        storedRow[col1] === val1 &&
                        storedRow[col2] === val2
                      ) {
                        return Promise.resolve({ data: storedRow, error: null });
                      }
                      return Promise.resolve({ data: null, error: null });
                    }),
                  })),
                })),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const orgId = '00000000-0000-4000-8000-000000000001';
      const conexaoId = '11111111-0000-4000-8000-000000000001';
      const rawSecret = {
        client_secret: 'bling-secret-12345',
        access_token: 'token-abcde',
        refresh_token: 'refresh-xyz',
      };

      await credentialsVault.saveEncryptedCredentials(orgId, conexaoId, rawSecret, 'v1', mockClient);

      // Verify that stored data is encrypted
      expect(storedRow).not.toBeNull();
      if (storedRow) {
        const row = storedRow as Record<string, unknown>;
        expect(row['dados_cifrados']).toBeDefined();
        expect(typeof row['dados_cifrados']).toBe('string');
        const cipherText = row['dados_cifrados'] as string;
        expect(cipherText).not.toContain('bling-secret-12345');
        expect(cipherText).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i);
      }

      // Decrypt and verify
      const decrypted = await credentialsVault.getDecryptedCredentials(orgId, conexaoId, mockClient);
      expect(decrypted).toEqual(rawSecret);

      // Attempting access with different orgId returns null (tenant isolation)
      const wrongOrgDecrypted = await credentialsVault.getDecryptedCredentials('wrong-org', conexaoId, mockClient);
      expect(wrongOrgDecrypted).toBeNull();
    });

    it('fails closed when encrypted envelope is corrupted', async () => {
      const mockClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    dados_cifrados: '000000000000000000000000:00000000000000000000000000000000:deadbeef',
                    chave_versao: 'v1',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const result = await credentialsVault.getDecryptedCredentials('org-1', 'conn-1', mockClient);
      expect(result).toBeNull();
    });
  });
});
