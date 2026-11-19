import { createClient } from '@supabase/supabase-js';
import { readSupabaseServerConfiguration } from './runtime-config';

const configuration = readSupabaseServerConfiguration({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_ORBITA_DEMO_LOCAL: process.env.NEXT_PUBLIC_ORBITA_DEMO_LOCAL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
if (configuration._tag === 'InvalidRuntimeConfiguration') {
  throw new Error(`Configuração Supabase inválida: ${configuration.variable}.`);
}

// Instância privilegiada para uso exclusivo no servidor (API routes, repositórios em SSR)
// Ignora políticas de RLS para persistência de dados.
export const supabaseServer = createClient(configuration.url, configuration.serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
