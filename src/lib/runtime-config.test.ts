import { describe, expect, it } from 'vitest';

import {
  readSupabaseBrowserConfiguration,
  readSupabaseServerConfiguration,
} from './runtime-config';

describe('Supabase runtime configuration', () => {
  it('permite apenas a URL exata da demo, com opt-in em desenvolvimento', () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55821',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-test-public-key-not-a-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'ci-test-service-role-not-a-secret',
      NEXT_PUBLIC_ORBITA_DEMO_LOCAL: 'true',
      NODE_ENV: 'development',
    };
    expect(readSupabaseBrowserConfiguration(env)._tag).toBe('ValidSupabaseBrowserConfiguration');
    expect(readSupabaseServerConfiguration(env)._tag).toBe('ValidSupabaseServerConfiguration');
    for (const mudanca of [{ NODE_ENV: 'production' }, { NEXT_PUBLIC_ORBITA_DEMO_LOCAL: 'false' },
      { NEXT_PUBLIC_SUPABASE_URL: 'http://192.168.1.2:55821' }, { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }]) {
      expect(readSupabaseBrowserConfiguration({ ...env, ...mudanca })._tag).toBe('InvalidRuntimeConfiguration');
      expect(readSupabaseServerConfiguration({ ...env, ...mudanca })._tag).toBe('InvalidRuntimeConfiguration');
    }
  });
  it('rejects missing browser credentials instead of creating a placeholder client', () => {
    expect(readSupabaseBrowserConfiguration({})).toEqual({
      _tag: 'InvalidRuntimeConfiguration',
      variable: 'NEXT_PUBLIC_SUPABASE_URL',
    });
  });

  it('rejects placeholder Supabase values', () => {
    expect(readSupabaseBrowserConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    })).toEqual({
      _tag: 'InvalidRuntimeConfiguration',
      variable: 'NEXT_PUBLIC_SUPABASE_URL',
    });
  });

  it('accepts structurally valid browser and server credentials', () => {
    const url = 'https://project-ref.supabase.co';
    const anonKey = ['public', 'key', '12345678901234567890'].join('-');
    const serviceRoleKey = ['server', 'key', '12345678901234567890'].join('-');
    const environment = {
      [['NEXT', 'PUBLIC', 'SUPABASE', 'URL'].join('_')]: url,
      [['NEXT', 'PUBLIC', 'SUPABASE', 'ANON', 'KEY'].join('_')]: anonKey,
      [['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_')]: serviceRoleKey,
    };

    expect(readSupabaseBrowserConfiguration(environment)).toEqual({
      _tag: 'ValidSupabaseBrowserConfiguration',
      anonKey,
      url,
    });
    expect(readSupabaseServerConfiguration(environment)).toEqual({
      _tag: 'ValidSupabaseServerConfiguration',
      serviceRoleKey,
      url,
    });
  });
});
