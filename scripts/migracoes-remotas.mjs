import fs from 'node:fs';
import path from 'node:path';

import { readCanonicalLedger, SUPABASE_CONFIG_PATH } from './database-ledger.mjs';
import { err, failureMessage, ok } from './script-result.mjs';

/**
 * Estado das migrações num banco remoto, e aplicação das que faltam.
 *
 * Existe porque mesclar o PR publica o código e não o SQL. Em 2026-08-30 o
 * banco de produção estava três migrações atrás, e por isso a correção do PR
 * #40 foi anunciada como entregue sem existir em produção. Ninguém percebeu
 * até o usuário reclamar do mesmo erro.
 *
 * A integração do Supabase com o GitHub não cobre este repositório: ela aplica
 * `supabase/migrations/`, e as migrações daqui vivem em `database/`, ordenadas
 * pelo ledger em `database/migrations.lock.json`. O diretório que a integração
 * procura não existe.
 *
 * O registro do que já foi aplicado é uma tabela de metadados do ferramental,
 * `public.migracoes_aplicadas`, criada por este script e deliberadamente fora
 * do schema da aplicação — pela mesma razão que `schema_migrations` não é uma
 * migration em nenhum framework: ela precisa existir antes da primeira.
 */

const DDL_REGISTRO = `
  create table if not exists public.migracoes_aplicadas (
    ordem       integer     not null,
    arquivo     text        primary key,
    sha256      text        not null,
    aplicada_em timestamptz not null default now()
  )
`;

/** Registro de uma migração aplicada. `arquivo` é a chave primária. */
const SQL_REGISTRAR = 'insert into public.migracoes_aplicadas (ordem, arquivo, sha256) values ($1, $2, $3)';

/** Igual, tolerando reexecução: só a adoção do estado atual precisa disso. */
const SQL_REGISTRAR_OU_ATUALIZAR = 'insert into public.migracoes_aplicadas (ordem, arquivo, sha256) values ($1, $2, $3) on conflict (arquivo) do update set sha256 = excluded.sha256';

/** O que o banco alvo já registra. */
const SQL_LER_REGISTRO = 'select arquivo, sha256 from public.migracoes_aplicadas';

/** A tabela de registro existe? Perguntar é mais barato que criar sem precisar. */
const SQL_REGISTRO_EXISTE = "select to_regclass('public.migracoes_aplicadas') is not null as existe";

/**
 * Compara o ledger do repositório com o que o banco alvo registra.
 *
 * @param {object} options
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }} options.client - Cliente já conectado.
 * @param {ReturnType<typeof readCanonicalLedger>} [options.ledgerResult] - Ledger canônico.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { pendentes: Array<Record<string, unknown>>, aplicadas: number, divergentes: string[], registroAusente: boolean } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>}
 */
export async function estadoDasMigracoes({ client, ledgerResult = readCanonicalLedger() }) {
  if (ledgerResult._tag === 'err') return ledgerResult;

  // Consultar o estado NÃO pode escrever no banco alvo. A primeira versão
  // criava a tabela de registro aqui, e com isso o caminho anunciado como
  // "somente leitura" emitia DDL em produção — exatamente o tipo de efeito
  // colateral escondido que este script existe para acabar.
  const { rows: existe } = await client.query(SQL_REGISTRO_EXISTE);
  const registroAusente = existe[0]?.existe !== true;

  const rows = registroAusente ? [] : (await client.query(SQL_LER_REGISTRO)).rows;
  const registradas = new Map(rows.map((r) => [String(r.arquivo), String(r.sha256)]));

  const pendentes = [];
  const divergentes = [];

  for (const migracao of ledgerResult.value.migrations) {
    const registrada = registradas.get(migracao.path);
    if (registrada === undefined) {
      pendentes.push(migracao);
      continue;
    }
    // Checksum diferente significa que uma migration já aplicada foi editada
    // depois. O ledger existe justamente para proibir isso.
    if (registrada !== migracao.sha256) divergentes.push(migracao.path);
  }

  return ok({ pendentes, aplicadas: registradas.size, divergentes, registroAusente });
}

/**
 * Aplica, em ordem, as migrações que faltam. Cada uma na sua transação: se a
 * terceira falhar, as duas primeiras continuam aplicadas e registradas, e a
 * próxima execução retoma exatamente de onde parou.
 *
 * @param {object} options
 * @param {{ query: Function }} options.client - Cliente já conectado.
 * @param {Array<Record<string, unknown>>} options.pendentes - Saída de `estadoDasMigracoes`.
 * @param {typeof fs} [options.fileSystem] - Fronteira de leitura.
 * @param {(mensagem: string) => void} [options.log] - Saída de progresso.
 */
export async function aplicarPendentes({ client, pendentes, fileSystem = fs, log = console.log }) {
  await client.query(DDL_REGISTRO);
  const aplicadas = [];

  for (const migracao of pendentes) {
    const caminho = path.resolve(path.dirname(SUPABASE_CONFIG_PATH), migracao.path);
    const sql = fileSystem.readFileSync(caminho, 'utf8').replace(/^﻿/, '');

    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        SQL_REGISTRAR,
        [migracao.order, migracao.path, migracao.sha256],
      );
      await client.query('commit');
      aplicadas.push(migracao.path);
      log(`aplicada  ${migracao.path}`);
    } catch (causa) {
      await client.query('rollback');
      return err(
        'MigracaoRemotaFalhou',
        `${migracao.path} falhou e foi revertida; as ${aplicadas.length} anteriores continuam aplicadas`,
        { arquivo: migracao.path, aplicadasAntes: aplicadas },
        causa instanceof Error ? causa.message : String(causa),
      );
    }
  }

  return ok(Object.freeze(aplicadas));
}

/**
 * Registra o ledger inteiro como aplicado, sem executar nada.
 *
 * Serve uma vez só, num banco que já tinha as migrações aplicadas à mão antes
 * deste script existir. Usar em qualquer outra situação mente para o registro.
 */
export async function adotarEstadoAtual({ client, ledgerResult = readCanonicalLedger() }) {
  if (ledgerResult._tag === 'err') return ledgerResult;

  await client.query(DDL_REGISTRO);
  for (const migracao of ledgerResult.value.migrations) {
    await client.query(
      SQL_REGISTRAR_OU_ATUALIZAR,
      [migracao.order, migracao.path, migracao.sha256],
    );
  }
  return ok(ledgerResult.value.migrations.length);
}

/** Lê o alvo do argumento explícito ou da variável de ambiente. Sem padrão. */
export function lerAlvo(argv, env) {
  const i = argv.indexOf('--url');
  const url = i >= 0 ? argv[i + 1] : env.SUPABASE_DB_URL;
  if (!url) {
    return err(
      'AlvoNaoInformado',
      'Informe o banco alvo com --url <conexão> ou SUPABASE_DB_URL. Não há alvo padrão: '
        + 'um padrão silencioso é como se aplica DDL no banco errado.',
    );
  }
  return ok(url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/migracoes-remotas.mjs')) {
  const { default: pg } = await import('pg');

  const alvo = lerAlvo(process.argv, process.env);
  if (alvo._tag === 'err') {
    console.error(failureMessage(alvo.error));
    process.exit(1);
  }

  const aplicar = process.argv.includes('--aplicar');
  const adotar = process.argv.includes('--adotar');
  const confirmado = process.argv.includes('--confirmar');

  const client = new pg.Client({ connectionString: alvo.value, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`Banco alvo: ${new URL(alvo.value).host}\n`);

  try {
    if (adotar) {
      if (!confirmado) {
        console.error('--adotar marca o ledger inteiro como aplicado SEM executar nada. Repita com --confirmar.');
        process.exit(1);
      }
      const r = await adotarEstadoAtual({ client });
      if (r._tag === 'err') throw new Error(failureMessage(r.error));
      console.log(`${r.value} migrações registradas como já aplicadas.`);
      process.exit(0);
    }

    const estado = await estadoDasMigracoes({ client });
    if (estado._tag === 'err') {
      console.error(failureMessage(estado.error));
      process.exit(1);
    }

    const { pendentes, aplicadas, divergentes, registroAusente } = estado.value;

    if (registroAusente) {
      console.log('Este banco ainda nao tem registro de migracoes aplicadas.');
      console.log('Se as migracoes ja foram aplicadas a mao, adote o estado atual: --adotar --confirmar\n');
    }

    if (divergentes.length > 0) {
      console.error('Migrações já aplicadas cujo conteúdo mudou depois:');
      for (const arquivo of divergentes) console.error(`  ${arquivo}`);
      console.error('\nEditar migration aplicada é proibido. Crie uma nova, forward-only.');
      process.exit(1);
    }

    console.log(`${aplicadas} aplicada(s), ${pendentes.length} pendente(s).`);
    for (const m of pendentes) console.log(`  pendente  ${m.path}`);

    if (pendentes.length === 0) {
      console.log('\nBanco em dia com o repositório.');
      process.exit(0);
    }

    if (!aplicar) {
      console.log('\nSomente leitura. Para aplicar: --aplicar --confirmar');
      process.exit(1);
    }

    if (!confirmado) {
      console.error('\n--aplicar executa DDL no banco acima. Repita com --confirmar.');
      process.exit(1);
    }

    console.log('');
    const r = await aplicarPendentes({ client, pendentes });
    if (r._tag === 'err') {
      console.error(`\n${failureMessage(r.error)}`);
      process.exit(1);
    }
    console.log(`\n${r.value.length} migração(ões) aplicada(s).`);
  } finally {
    await client.end();
  }
}
