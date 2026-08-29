import { describe, expect, it } from 'vitest';

import { resolveAppBaseUrl, resolveBlingCallbackUrl } from './appBaseUrl';

describe('origem pública estável', () => {
  it('prefere APP_BASE_URL', () => {
    const result = resolveAppBaseUrl({
      APP_BASE_URL: 'https://orbita.mkautobots.site',
      STRIPE_APP_BASE_URL: 'https://outro.example.org',
    });

    expect(result).toEqual({ _tag: 'AppBaseUrlResolved', origin: 'https://orbita.mkautobots.site' });
  });

  it('aceita STRIPE_APP_BASE_URL, que nomeia a mesma origem allowlisted', () => {
    const result = resolveAppBaseUrl({ STRIPE_APP_BASE_URL: 'https://orbita.mkautobots.site' });

    expect(result).toEqual({ _tag: 'AppBaseUrlResolved', origin: 'https://orbita.mkautobots.site' });
  });

  it('normaliza para a origem pura, descartando caminho e barra final', () => {
    const result = resolveAppBaseUrl({ APP_BASE_URL: 'https://orbita.mkautobots.site/app/' });

    expect(result).toEqual({ _tag: 'AppBaseUrlResolved', origin: 'https://orbita.mkautobots.site' });
  });

  it('recusa valor ausente, vazio ou não-URL', () => {
    expect(resolveAppBaseUrl({})._tag).toBe('AppBaseUrlMissing');
    expect(resolveAppBaseUrl({ APP_BASE_URL: '   ' })._tag).toBe('AppBaseUrlMissing');
    expect(resolveAppBaseUrl({ APP_BASE_URL: 'orbita.mkautobots.site' })._tag).toBe('AppBaseUrlMissing');
  });

  it('recusa placeholder em vez de propagá-lo para o cadastro no Bling', () => {
    expect(resolveAppBaseUrl({ APP_BASE_URL: 'https://seu-dominio.com' })._tag).toBe('AppBaseUrlMissing');
    expect(resolveAppBaseUrl({ APP_BASE_URL: 'https://placeholder.app' })._tag).toBe('AppBaseUrlMissing');
  });
});

describe('URL de retorno do Bling', () => {
  it('é montada sobre a origem estável', () => {
    expect(resolveBlingCallbackUrl({ APP_BASE_URL: 'https://orbita.mkautobots.site' }))
      .toBe('https://orbita.mkautobots.site/api/bling/callback');
  });

  it('é null quando a origem não está configurada, para a tela poder dizer isso', () => {
    expect(resolveBlingCallbackUrl({})).toBeNull();
  });

  it('nunca deriva de um host de preview efêmero', () => {
    // A origem só entra por configuração; não existe caminho que leia o
    // navegador. Este teste guarda a ausência dessa entrada.
    expect(resolveBlingCallbackUrl({ APP_BASE_URL: 'https://orbita-1e91i3lpo-orbita16.vercel.app' }))
      .toBe('https://orbita-1e91i3lpo-orbita16.vercel.app/api/bling/callback');
    expect(resolveBlingCallbackUrl({})).toBeNull();
  });
});
