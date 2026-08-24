import pg from 'pg';

const { Client } = pg;
const LOCAL_DATABASE_ROLE = 'postgres';

/**
 * Create a PostgreSQL client pinned to the disposable local Supabase database.
 * PostgreSQL notices are preserved with a narrow, secret-free projection.
 *
 * @param {string} applicationName - Safe client name included in PostgreSQL activity metadata.
 * @param {{ warn?: (message: string) => void }} [logger] - Notice logger.
 * @returns {import('pg').Client} Unconnected local PostgreSQL client.
 */
export function createLocalDatabaseClient(applicationName, logger = console) {
  const client = new Client({
    host: '127.0.0.1',
    port: 54322,
    database: LOCAL_DATABASE_ROLE,
    user: LOCAL_DATABASE_ROLE,
    password: LOCAL_DATABASE_ROLE,
    application_name: applicationName,
  });
  client.on('notice', (notice) => {
    const severity = typeof notice.severity === 'string' ? notice.severity : 'NOTICE';
    const code = typeof notice.code === 'string' ? ` ${notice.code}` : '';
    const message = typeof notice.message === 'string' ? notice.message : 'PostgreSQL emitted a notice';
    logger.warn?.(`[database-lab] postgres ${severity}${code}: ${message}`);
  });
  return client;
}
