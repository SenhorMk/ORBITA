import pg from 'pg';

const { Client } = pg;
const LOCAL_DATABASE_ROLE = 'postgres';

/** Default port of the disposable local Supabase Postgres lab (`supabase db start`). */
export const DEFAULT_LOCAL_DATABASE_PORT = 54322;

/**
 * Create a PostgreSQL client pinned to a disposable local Postgres instance.
 * PostgreSQL notices are preserved with a narrow, secret-free projection.
 *
 * @param {string} applicationName - Safe client name included in PostgreSQL activity metadata.
 * @param {{ warn?: (message: string) => void }} [logger] - Notice logger.
 * @param {number} [port] - Local port of the disposable instance. Defaults to the Supabase
 *   local lab port; a second port is used only for a second, equally disposable local
 *   Postgres container (e.g. the backup/restore lab's restore target), never a remote host.
 * @returns {import('pg').Client} Unconnected local PostgreSQL client.
 */
export function createLocalDatabaseClient(applicationName, logger = console, port = DEFAULT_LOCAL_DATABASE_PORT) {
  const client = new Client({
    host: '127.0.0.1',
    port,
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
