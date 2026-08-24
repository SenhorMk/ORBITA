import fs from 'node:fs';
import path from 'node:path';

const DATABASE_DIR = path.resolve(process.cwd(), 'database');
const CONFIG_PATH = path.resolve(process.cwd(), 'supabase', 'config.toml');

export function checkDatabaseDrift({
  databaseDir = DATABASE_DIR,
  configPath = CONFIG_PATH,
  fileSystem = fs,
} = {}) {
  const errors = [];

  if (!fileSystem.existsSync(databaseDir)) {
    return {
      success: false,
      errors: [`Database directory does not exist: ${databaseDir}`],
    };
  }

  if (!fileSystem.existsSync(configPath)) {
    return {
      success: false,
      errors: [`Supabase config.toml not found at: ${configPath}`],
    };
  }

  // 1. Read files physically present in database/
  const physicalSqlFiles = fileSystem
    .readdirSync(databaseDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // 2. Read schema_paths registered in supabase/config.toml
  const configContent = fileSystem.readFileSync(configPath, 'utf8');
  const schemaPathsMatch = configContent.match(/schema_paths\s*=\s*\[([\s\S]*?)\]/);

  if (!schemaPathsMatch) {
    return {
      success: false,
      errors: ['schema_paths configuration block not found in supabase/config.toml'],
    };
  }

  const registeredPaths = schemaPathsMatch[1]
    .split('\n')
    .map((line) => line.trim().replace(/[",]/g, ''))
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const registeredBasenames = registeredPaths.map((p) => path.basename(p));

  // 3. Verify that every physical SQL file is registered in the ledger
  for (const sqlFile of physicalSqlFiles) {
    if (!registeredBasenames.includes(sqlFile)) {
      errors.push(`Untracked migration file in database/: "${sqlFile}" is not listed in supabase/config.toml schema_paths`);
    }
  }

  // 4. Verify that every registered file in schema_paths actually exists on disk
  for (const registeredPath of registeredPaths) {
    const resolvedPath = path.resolve(path.dirname(configPath), registeredPath);
    if (!fileSystem.existsSync(resolvedPath)) {
      errors.push(`Missing migration referenced in schema_paths: "${registeredPath}" does not exist at ${resolvedPath}`);
    }
  }

  // 5. Verify that initial schema starts before incremental migrations
  if (registeredBasenames.length > 0) {
    const firstMigration = registeredBasenames[0];
    if (firstMigration !== 'schema_master.sql' && !firstMigration.startsWith('01_') && !firstMigration.startsWith('00_')) {
      errors.push(`Initial schema must be the first migration in schema_paths, found: ${firstMigration}`);
    }
  }

  return {
    success: errors.length === 0,
    errors,
    checkedFiles: physicalSqlFiles.length,
    registeredFiles: registeredBasenames.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/check-database-drift.mjs')) {
  const result = checkDatabaseDrift();
  if (!result.success) {
    console.error('❌ Database drift detected:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  } else {
    console.log(`✅ Database schema drift check passed (${result.checkedFiles} migrations verified against ledger).`);
    process.exit(0);
  }
}
