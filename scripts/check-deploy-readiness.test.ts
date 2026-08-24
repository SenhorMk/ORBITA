import { describe, it, expect } from 'vitest';
import {
  validateEnvironmentVariables,
  validateMigrationsExist,
  runDeployReadinessCheck,
} from './check-deploy-readiness.mjs';

describe('check-deploy-readiness script', () => {
  it('validateEnvironmentVariables detecta variáveis ausentes e válidas', () => {
    const mockEnv = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'your-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'your-service-role-key',
      BLING_CLIENT_ID: 'your-bling-client-id',
    };

    const res = validateEnvironmentVariables(mockEnv as unknown as NodeJS.ProcessEnv);
    expect(res.valid).toBe(true);
    expect(res.missing).toHaveLength(0);
    expect(res.configuredIntegrations).toContain('BLING_CLIENT_ID');
  });

  it('validateEnvironmentVariables acusa erro quando falta variável obrigatória', () => {
    const mockEnv = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co',
    };

    const res = validateEnvironmentVariables(mockEnv as unknown as NodeJS.ProcessEnv);
    expect(res.valid).toBe(false);
    expect(res.missing).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(res.missing).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('validateMigrationsExist encontra arquivos SQL no diretório database', () => {
    const res = validateMigrationsExist();
    expect(res.valid).toBe(true);
    expect(res.count).toBeGreaterThanOrEqual(37);
  });

  it('runDeployReadinessCheck consolida o estado completo', () => {
    const mockEnv = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'your-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'your-service-role-key',
    };

    const res = runDeployReadinessCheck(mockEnv as unknown as NodeJS.ProcessEnv);
    expect(res.isReady).toBe(true);
  });
});
