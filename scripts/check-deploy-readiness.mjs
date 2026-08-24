#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const REQUIRED_PRODUCTION_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

export const OPTIONAL_INTEGRATION_VARS = [
  'BLING_CLIENT_ID',
  'BLING_CLIENT_SECRET',
  'CHATWOOT_API_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

export function validateEnvironmentVariables(env = process.env) {
  const missing = [];
  for (const varName of REQUIRED_PRODUCTION_VARS) {
    if (!env[varName] || env[varName].trim().length === 0) {
      missing.push(varName);
    }
  }

  const configuredIntegrations = [];
  for (const varName of OPTIONAL_INTEGRATION_VARS) {
    if (env[varName] && env[varName].trim().length > 0) {
      configuredIntegrations.push(varName);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    configuredIntegrations,
  };
}

export function validateMigrationsExist(databaseDir = path.join(ROOT_DIR, 'database')) {
  if (!fs.existsSync(databaseDir)) {
    return { valid: false, count: 0, error: 'Diretório database não encontrado' };
  }

  const files = fs.readdirSync(databaseDir).filter((f) => f.endsWith('.sql'));
  return {
    valid: files.length > 0,
    count: files.length,
    files,
  };
}

export function runDeployReadinessCheck(env = process.env) {
  const envCheck = validateEnvironmentVariables(env);
  const migrationCheck = validateMigrationsExist();

  const isReady = envCheck.valid && migrationCheck.valid;

  return {
    isReady,
    envCheck,
    migrationCheck,
  };
}

if (process.argv[1] === __filename) {
  console.log('🔍 Executando verificação de deploy readiness...');
  const result = runDeployReadinessCheck();

  if (!result.migrationCheck.valid) {
    console.error(`❌ Falha nas migrations: ${result.migrationCheck.error}`);
    process.exit(1);
  }

  console.log(`✅ ${result.migrationCheck.count} arquivos de migration validados.`);

  if (!result.envCheck.valid) {
    console.warn(`⚠️ Variáveis de ambiente obrigatórias não encontradas no runner atual: ${result.envCheck.missing.join(', ')}`);
  } else {
    console.log('✅ Variáveis de ambiente obrigatórias presentes.');
  }

  console.log('🚀 Deploy readiness check concluído com sucesso.');
}
