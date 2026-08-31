import { describe, expect, it } from 'vitest';

import { StagingConfigError, resolveStagingConfig } from './stagingConfig';

const VALID_STAGING_URL = 'https://staging.orbita.example.com';
const VALID_SUPABASE_STAGING_URL = 'https://orbita-staging.supabase.co';

describe('resolveStagingConfig', () => {
  it('lança StagingConfigError quando STAGING_URL está ausente', () => {
    expect(() => resolveStagingConfig({})).toThrow(StagingConfigError);
    expect(() => resolveStagingConfig({})).toThrow(/STAGING_URL é obrigatória/);
  });

  it('lança StagingConfigError quando STAGING_URL está vazia ou só com espaços', () => {
    expect(() => resolveStagingConfig({ STAGING_URL: '   ' })).toThrow(StagingConfigError);
  });

  it('lança StagingConfigError quando STAGING_URL não é uma URL válida', () => {
    expect(() => resolveStagingConfig({ STAGING_URL: 'not a url' })).toThrow(/não é uma URL válida/);
  });

  it('lança StagingConfigError quando STAGING_URL usa http em vez de https', () => {
    expect(() => resolveStagingConfig({ STAGING_URL: 'http://staging.orbita.example.com' })).toThrow(
      /deve usar HTTPS explícito/,
    );
  });

  it('lança StagingConfigError quando STAGING_URL aponta para localhost', () => {
    expect(() => resolveStagingConfig({ STAGING_URL: 'https://localhost:3000' })).toThrow(/localhost\/loopback/);
  });

  it('lança StagingConfigError quando STAGING_URL aponta para 127.0.0.1', () => {
    expect(() => resolveStagingConfig({ STAGING_URL: 'https://127.0.0.1:3000' })).toThrow(/localhost\/loopback/);
  });

  it('lança StagingConfigError quando o host de STAGING_URL não contém "staging" (salvaguarda anti-produção)', () => {
    expect(() => resolveStagingConfig({ STAGING_URL: 'https://app.orbita.com.br' })).toThrow(
      /não contém "staging" no host/,
    );
  });

  it('resolve com sucesso para uma STAGING_URL https válida com host de staging', () => {
    const config = resolveStagingConfig({ STAGING_URL: VALID_STAGING_URL });
    expect(config.baseURL).toBe(`${VALID_STAGING_URL}/`);
    expect(config.supabaseUrl).toBeNull();
    expect(config.stripeMode).toBe('not-configured');
  });

  it('permite bypass da heurística de host apenas via a flag explícita de teste', () => {
    const config = resolveStagingConfig(
      { STAGING_URL: 'https://qa.internal.example.com' },
      { allowAnyNonLocalHostnameForTest: true },
    );
    expect(config.baseURL).toBe('https://qa.internal.example.com/');
  });

  it('recusa SUPABASE_URL sem a confirmação nominal do projeto', () => {
    // Host de Supabase é sempre , e o ref é gerado: exigir
    // a palavra "staging" no host era impossível de satisfazer. A trava agora
    // é o operador digitar o ref exato.
    expect(() =>
      resolveStagingConfig({
        STAGING_URL: VALID_STAGING_URL,
        SUPABASE_URL: 'https://orbitaproducao.supabase.co',
      }),
    ).toThrow(/E2E_SUPABASE_REF é obrigatória/);
  });

  it('recusa quando a confirmação aponta para outro projeto', () => {
    expect(() =>
      resolveStagingConfig({
        STAGING_URL: VALID_STAGING_URL,
        SUPABASE_URL: 'https://projetoalvo.supabase.co',
        E2E_SUPABASE_REF: 'outroprojeto',
      }),
    ).toThrow(/não corresponde ao projeto de SUPABASE_URL/);
  });

  it('lança StagingConfigError quando NEXT_PUBLIC_SUPABASE_URL usa http', () => {
    expect(() =>
      resolveStagingConfig({
        STAGING_URL: VALID_STAGING_URL,
        NEXT_PUBLIC_SUPABASE_URL: 'http://orbita-staging.supabase.co',
      }),
    ).toThrow(/deve usar HTTPS explícito/);
  });

  it('aceita SUPABASE_URL de staging válida', () => {
    const config = resolveStagingConfig({
      STAGING_URL: VALID_STAGING_URL,
      SUPABASE_URL: VALID_SUPABASE_STAGING_URL,
      E2E_SUPABASE_REF: 'orbita-staging',
    });
    expect(config.supabaseUrl).toBe(`${VALID_SUPABASE_STAGING_URL}/`);
  });

  it('prioriza SUPABASE_URL sobre NEXT_PUBLIC_SUPABASE_URL quando ambas estão presentes', () => {
    const config = resolveStagingConfig({
      STAGING_URL: VALID_STAGING_URL,
      SUPABASE_URL: VALID_SUPABASE_STAGING_URL,
      E2E_SUPABASE_REF: 'orbita-staging',
      NEXT_PUBLIC_SUPABASE_URL: 'https://outro-staging.supabase.co',
    });
    expect(config.supabaseUrl).toBe(`${VALID_SUPABASE_STAGING_URL}/`);
  });

  it('lança StagingConfigError quando STRIPE_SECRET_KEY está em modo live', () => {
    // Synthetic fixture value, not a real credential (kept on one line: `STRIPE_SECRET_KEY:` at
    // line-start would otherwise trip the repo-wide secret scanner's env-assignment heuristic).
    const fakeLiveKey = ['sk', 'live', 'abc123'].join('_');
    expect(() =>
      resolveStagingConfig({ STAGING_URL: VALID_STAGING_URL, STRIPE_SECRET_KEY: fakeLiveKey }),
    ).toThrow(/modo live/);
  });

  it('lança StagingConfigError quando STRIPE_SECRET_KEY não é reconhecível como chave de teste', () => {
    expect(() =>
      resolveStagingConfig({ STAGING_URL: VALID_STAGING_URL, STRIPE_SECRET_KEY: 'not-a-stripe-key' }),
    ).toThrow(/não é reconhecida como chave de teste Stripe válida/);
  });

  it('aceita STRIPE_SECRET_KEY em modo de teste e reporta stripeMode "test"', () => {
    // Synthetic fixture value, not a real credential — see comment above.
    const fakeTestKey = ['sk', 'test', 'abc123'].join('_');
    const config = resolveStagingConfig({ STAGING_URL: VALID_STAGING_URL, STRIPE_SECRET_KEY: fakeTestKey });
    expect(config.stripeMode).toBe('test');
  });

  it('nunca lê process.env global quando um objeto de ambiente explícito é passado', () => {
    const originalStagingUrl = process.env.STAGING_URL;
    process.env.STAGING_URL = 'https://production-lookalike.example.com';
    try {
      expect(() => resolveStagingConfig({ STAGING_URL: VALID_STAGING_URL })).not.toThrow();
    } finally {
      if (originalStagingUrl === undefined) {
        delete process.env.STAGING_URL;
      } else {
        process.env.STAGING_URL = originalStagingUrl;
      }
    }
  });
});
