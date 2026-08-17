import { describe, expect, it } from 'vitest';

import {
  readSupabaseBrowserConfiguration,
  readSupabaseServerConfiguration,
} from './runtime-config';

describe('Supabase runtime configuration', () => {
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
