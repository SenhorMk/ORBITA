import { describe, expect, it } from 'vitest';

import {
  blingCredentialsPayloadSchema,
  blingVaultCredentialsSchema,
  buildBlingCredentialsPayload,
  buildBlingVaultCredentials,
} from './blingCredentialsContract';

describe('contrato de credenciais do Bling (POST /api/bling/connect)', () => {
  it('o corpo montado pelo cliente é aceito pelo validador do servidor', () => {
    // Esta é a asserção que fecha o buraco real: cliente e servidor deixam de
    // ser verificados isoladamente. Se qualquer um dos lados mudar de forma
    // sem o outro, este teste quebra.
    const payload = buildBlingCredentialsPayload('client-id-abc', 'client-secret-xyz');

    const parsed = blingCredentialsPayloadSchema.safeParse(payload);

    expect(parsed.success).toBe(true);
  });

  it('rejeita a forma aninhada que o SetupWizard enviava e causou o defeito', () => {
    // Regressão explícita: `{ bling: { ... } }` era o que o cliente mandava
    // enquanto a rota lia da raiz, produzindo 400 em toda conexão do Bling.
    const legacyNestedBody = {
      bling: { clientId: 'client-id-abc', clientSecret: 'client-secret-xyz' },
    };

    const parsed = blingCredentialsPayloadSchema.safeParse(legacyNestedBody);

    expect(parsed.success).toBe(false);
  });

  it('remove espaços nas bordas antes de enviar', () => {
    const payload = buildBlingCredentialsPayload('  client-id-abc  ', '  client-secret-xyz  ');

    expect(payload).toEqual({ clientId: 'client-id-abc', clientSecret: 'client-secret-xyz' });
  });

  it('o que a rota de conexão cifra no cofre é exatamente o que o callback OAuth lê de volta', () => {
    // Segunda fronteira do mesmo dado. `POST /api/bling/connect` grava com
    // `buildBlingVaultCredentials`; `GET /api/bling/callback` lê com
    // `blingVaultCredentialsSchema`. Renomear uma chave em um lado quebra aqui,
    // em vez de só falhar em produção como nos tickets 26 e 27.
    const stored = buildBlingVaultCredentials(buildBlingCredentialsPayload('client-id-abc', 'client-secret-xyz'));

    const readBack = blingVaultCredentialsSchema.safeParse(stored);

    expect(readBack.success).toBe(true);
    if (readBack.success) {
      expect(readBack.data).toEqual({ client_id: 'client-id-abc', client_secret: 'client-secret-xyz' });
    }
  });

  it('o cofre rejeita credenciais incompletas em vez de devolver um client_secret vazio', () => {
    const readBack = blingVaultCredentialsSchema.safeParse({ client_id: 'client-id-abc', client_secret: '' });

    expect(readBack.success).toBe(false);
  });

  it('rejeita credenciais vazias com mensagem própria por campo', () => {
    const parsed = blingCredentialsPayloadSchema.safeParse({ clientId: '', clientSecret: '' });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message);
      expect(messages).toContain('Client ID do Bling é obrigatório');
      expect(messages).toContain('Client Secret do Bling é obrigatório');
    }
  });
});
