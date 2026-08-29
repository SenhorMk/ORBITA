import { describe, expect, it } from 'vitest';

import {
  blingCredentialsPayloadSchema,
  buildBlingCredentialsPayload,
} from './blingCredentialsContract';

describe('contrato de credenciais do Bling (POST /api/config)', () => {
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
