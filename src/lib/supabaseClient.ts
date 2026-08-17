import { createClient } from '@supabase/supabase-js';
import { readSupabaseBrowserConfiguration } from './runtime-config';

const configuration = readSupabaseBrowserConfiguration({
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
});
if (configuration._tag === 'InvalidRuntimeConfiguration') {
  throw new Error(`Configuração Supabase inválida: ${configuration.variable}.`);
}

// Instância do cliente Supabase para consultas gerais e realtime
export const supabase = createClient(configuration.url, configuration.anonKey);
