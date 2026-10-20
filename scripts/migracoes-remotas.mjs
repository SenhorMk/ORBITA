import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readCanonicalLedger, SUPABASE_CONFIG_PATH } from './database-ledger.mjs';
import { descreverErroReportavel, erroReportavel } from './erro-reportavel-do-banco.mjs';
import { lerOpcoes } from './migracoes-remotas-opcoes.mjs';
import { err, failureMessage, ok } from './script-result.mjs';

export { erroReportavel } from './erro-reportavel-do-banco.mjs';
export { lerLimite, lerOpcoes } from './migracoes-remotas-opcoes.mjs';

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
 * Exclusão mútua entre executores: trava consultiva de **transação**, pega
 * logo depois do `begin` e antes de decidir executar. O Postgres a solta no
 * `commit` ou no `rollback` — nunca fica pendurada se o processo morrer.
 * Um segundo executor espera aqui e, ao entrar, relê o registro: o que o
 * primeiro gravou já está commitado.
 */
const SQL_TRAVA_DA_FERRAMENTA = "select pg_advisory_xact_lock(hashtextextended('orbita:migracoes-remotas', 0))";

/** Releitura depois da trava: outra execução já registrou esta migration? */
const SQL_JA_REGISTRADA = 'select 1 from public.migracoes_aplicadas where arquivo = $1';

/** O nome canônico do arquivo, sem o caminho relativo do ledger. */
function nomeDoArquivo(migracao) {
  return path.basename(String(migracao.path));
}

/** SHA-256 dos bytes do arquivo — o mesmo cálculo de `database-ledger.mjs`. */
function sha256(conteudo) {
  return createHash('sha256').update(conteudo).digest('hex');
}

function caminhoDaMigracao(migracao) {
  return path.resolve(path.dirname(SUPABASE_CONFIG_PATH), migracao.path);
}


/**
 * Compara o ledger do repositório com o que o banco alvo registra.
 *
 * @param {object} options
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }} options.client - Cliente já conectado.
 * @param {ReturnType<typeof readCanonicalLedger>} [options.ledgerResult] - Ledger canônico.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: { pendentes: Array<Record<string, unknown>>, aplicadas: number, divergentes: string[], registroAusente: boolean, foraDeOrdem: string[], desconhecidas: string[] } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>}
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

  // A cadeia é uma sequência: o que está aplicado tem de ser um prefixo do
  // ledger. Uma pendente com alguma posterior já aplicada é lacuna, e um
  // registro que o ledger não conhece é um banco de outra história.
  const ultimaAplicada = Math.max(0, ...ledgerResult.value.migrations
    .filter((m) => registradas.has(m.path)).map((m) => Number(m.order)));
  const foraDeOrdem = pendentes.filter((m) => Number(m.order) < ultimaAplicada).map((m) => m.path);
  const conhecidas = new Set(ledgerResult.value.migrations.map((m) => m.path));
  const desconhecidas = [...registradas.keys()].filter((arquivo) => !conhecidas.has(arquivo));

  return ok({ pendentes, aplicadas: registradas.size, divergentes, registroAusente, foraDeOrdem, desconhecidas });
}

/**
 * O que uma execução vai aplicar, decidido antes de tocar no banco — e a mesma
 * decisão que a prévia mostra.
 *
 * Recusa: registro remoto divergente do ledger, lacuna na sequência, registro
 * que o ledger não conhece, limite inexistente, ambíguo ou já aplicado, e
 * arquivo local cujo conteúdo não bate com o checksum do ledger. As
 * posteriores ao limite ficam de fora — nem executadas, nem registradas.
 *
 * @param {object} options
 * @param {{ pendentes: Array<Record<string, unknown>>, divergentes: string[], foraDeOrdem: string[], desconhecidas: string[] }} options.estado - Saída de `estadoDasMigracoes`.
 * @param {{ _tag: 'SemLimite' } | { _tag: 'Arquivo', nome: string } | { _tag: 'Ordem', ordem: number }} options.limite - Saída de `lerLimite`.
 * @param {Array<Record<string, unknown>>} options.ledger - `ledger.value.migrations`.
 * @param {{ readFileSync: (caminho: string) => string | Buffer }} [options.fileSystem]
 * @returns {{ readonly _tag: 'ok', readonly value: { plano: Array<Record<string, unknown>>, posteriores: Array<Record<string, unknown>> } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function planejarAplicacao({ estado, limite, ledger, fileSystem = fs }) {
  if (estado.divergentes.length > 0) {
    return err('RegistroDivergente', 'Há migration aplicada cujo checksum difere do ledger.', { arquivos: estado.divergentes });
  }
  if (estado.foraDeOrdem.length > 0 || estado.desconhecidas.length > 0) {
    return err('SequenciaInesperada', 'O registro remoto não é um prefixo do ledger.', {
      lacunas: estado.foraDeOrdem,
      desconhecidas: estado.desconhecidas,
    });
  }

  let plano = estado.pendentes;
  if (limite._tag !== 'SemLimite') {
    const candidatas = limite._tag === 'Arquivo'
      ? ledger.filter((m) => nomeDoArquivo(m) === limite.nome)
      : ledger.filter((m) => Number(m.order) === limite.ordem);
    const descricao = limite._tag === 'Arquivo' ? limite.nome : `ordem ${limite.ordem}`;
    if (candidatas.length === 0) return err('LimiteInexistente', `${descricao} não existe no ledger.`);
    if (candidatas.length > 1) return err('LimiteAmbiguo', `${descricao} corresponde a ${candidatas.length} entradas do ledger.`);
    const alvo = candidatas[0];
    if (!estado.pendentes.some((m) => m.path === alvo.path)) {
      return err('LimiteJaAplicado', `${descricao} já está aplicada; nada a fazer até ela.`);
    }
    plano = estado.pendentes.filter((m) => Number(m.order) <= Number(alvo.order));
  }

  for (const migracao of plano) {
    const atual = sha256(fileSystem.readFileSync(caminhoDaMigracao(migracao)));
    if (atual !== migracao.sha256) {
      return err('ChecksumLocalDivergente', `${nomeDoArquivo(migracao)} no disco não bate com o ledger; regenere o ledger ou restaure o arquivo.`, {
        arquivo: migracao.path,
      });
    }
  }

  const noPlano = new Set(plano.map((m) => m.path));
  return ok({ plano, posteriores: estado.pendentes.filter((m) => !noPlano.has(m.path)) });
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
  const aplicadas = [];

  for (const migracao of pendentes) {
    const bruto = fileSystem.readFileSync(caminhoDaMigracao(migracao));
    // O arquivo pode ter mudado entre a prévia e a aplicação.
    if (migracao.sha256 !== undefined && sha256(bruto) !== migracao.sha256) {
      return err('ChecksumLocalDivergente', `${migracao.path} mudou no disco; nada dela foi aplicado`, {
        arquivo: migracao.path, aplicadasAntes: aplicadas,
      });
    }
    const sql = String(bruto).replace(/^﻿/, '');

    try {
      await client.query('begin');
      // Trava antes de decidir; o registro é criado e relido já sob ela.
      await client.query(SQL_TRAVA_DA_FERRAMENTA);
      await client.query(DDL_REGISTRO);
      if ((await client.query(SQL_JA_REGISTRADA, [migracao.path])).rows.length > 0) {
        await client.query('rollback');
        return err('MigracaoJaRegistrada', `${migracao.path} foi registrada por outra execução; parei sem aplicá-la`, {
          arquivo: migracao.path, aplicadasAntes: aplicadas,
        });
      }
      await client.query(sql);
      await client.query(
        SQL_REGISTRAR,
        [migracao.order, migracao.path, migracao.sha256],
      );
      await client.query('commit');
      aplicadas.push(migracao.path);
      log(`aplicada  ${migracao.path}`);
    } catch (causa) {
      await client.query('rollback').catch(() => {});
      const reportavel = erroReportavel(causa);
      return err(
        'MigracaoRemotaFalhou',
        `${nomeDoArquivo(migracao)} falhou e foi revertida (${descreverErroReportavel(reportavel)}); `
          + `as ${aplicadas.length} anteriores continuam aplicadas`,
        { arquivo: migracao.path, aplicadasAntes: aplicadas, ...reportavel },
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

  // Num banco que já registra migrations, adotar marcaria como aplicadas as
  // pendentes sem executá-las — exatamente o que o registro existe para impedir.
  const { rows: existe } = await client.query(SQL_REGISTRO_EXISTE);
  if (existe[0]?.existe === true && (await client.query(SQL_LER_REGISTRO)).rows.length > 0) {
    return err('AdocaoRecusada', 'Este banco já registra migrations aplicadas; adotar marcaria pendentes sem executá-las. Use --aplicar.');
  }

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

/**
 * Interpreta o alvo e constrói o cliente sem deixar a URL escapar.
 *
 * `new URL` e o parser do driver lançam com a URL inteira no erro (`input`,
 * mensagem, pilha), e a URL carrega a senha. Qualquer falha aqui vira uma
 * recusa fixa, sem a causa.
 *
 * @param {string} url - Conexão PostgreSQL, possivelmente com senha.
 * @param {new (config: Record<string, unknown>) => unknown} Client - Construtor do driver.
 * @returns {{ readonly _tag: 'ok', readonly value: { client: unknown, host: string } } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }}
 */
export function prepararConexao(url, Client) {
  try {
    const alvo = new URL(url);
    // `sslmode=disable` só quando a URL pede (laboratório local); o padrão é TLS.
    const semTls = alvo.searchParams.get('sslmode') === 'disable';
    const client = new Client({ connectionString: url, ssl: semTls ? false : { rejectUnauthorized: false } });
    return ok({ client, host: alvo.hostname });
  } catch {
    return err('AlvoInvalido', 'Alvo inválido: a URL de conexão não pôde ser interpretada (o valor não é exibido).');
  }
}

/** Linha do plano: ordinal do ledger, nome do arquivo e início do checksum. Nada do alvo. */
function linhaDoPlano(prefixo, m) {
  return `  ${prefixo}  ordem ${String(m.order).padStart(3)}  ${nomeDoArquivo(m)}  ${String(m.sha256).slice(0, 12)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/migracoes-remotas.mjs')) {
  // Instalados antes de qualquer interpretação do alvo: uma exceção não prevista
  // (URL, conexão, autenticação, consulta) sai só com o SQLSTATE e a categoria —
  // nem mensagem, nem pilha, nem `input`, que podem carregar a URL com senha.
  process.on('uncaughtException', (causa) => {
    console.error(`Falha inesperada (${descreverErroReportavel(erroReportavel(causa))}).`);
    process.exit(1);
  });
  process.on('unhandledRejection', (causa) => {
    console.error(`Falha inesperada (${descreverErroReportavel(erroReportavel(causa))}).`);
    process.exit(1);
  });
  const { default: pg } = await import('pg');

  // Tudo validado antes de abrir conexão: nenhuma recusa acontece depois de
  // uma escrita remota.
  const opcoes = lerOpcoes(process.argv.slice(2));
  if (opcoes._tag === 'err') {
    console.error(failureMessage(opcoes.error));
    process.exit(1);
  }
  const alvo = lerAlvo(opcoes.value.url === undefined ? [] : ['--url', opcoes.value.url], process.env);
  if (alvo._tag === 'err') {
    console.error(failureMessage(alvo.error));
    process.exit(1);
  }
  const { aplicar, adotar, previa, confirmar: confirmado } = opcoes.value;
  const limite = { value: opcoes.value.limite };

  const conexao = prepararConexao(alvo.value, pg.Client);
  if (conexao._tag === 'err') {
    console.error(failureMessage(conexao.error));
    process.exit(1);
  }
  const { client } = conexao.value;
  await client.connect();
  // Só o host: a URL carrega usuário e senha, e não vai para nenhum relatório.
  console.log(`Banco alvo (host): ${conexao.value.host}\n`);

  try {
    if (adotar) {
      if (!confirmado) {
        console.error('--adotar marca o ledger inteiro como aplicado SEM executar nada. Repita com --confirmar.');
        process.exit(1);
      }
      const r = await adotarEstadoAtual({ client });
      if (r._tag === 'err') {
        console.error(failureMessage(r.error));
        process.exit(1);
      }
      console.log(`${r.value} migrações registradas como já aplicadas.`);
      process.exit(0);
    }

    const ledger = readCanonicalLedger();
    const estado = await estadoDasMigracoes({ client, ledgerResult: ledger });
    if (estado._tag === 'err' || ledger._tag === 'err') {
      console.error(failureMessage(estado._tag === 'err' ? estado.error : ledger.error));
      process.exit(1);
    }

    const { pendentes, aplicadas, registroAusente } = estado.value;
    if (registroAusente) {
      console.log('Este banco ainda nao tem registro de migracoes aplicadas.');
      console.log('Adotar o estado atual (--adotar) só vale se TODAS as migracoes ja foram aplicadas a mao.\n');
    }
    console.log(`${aplicadas} aplicada(s), ${pendentes.length} pendente(s) no ledger.`);

    const plano = planejarAplicacao({ estado: estado.value, limite: limite.value, ledger: ledger.value.migrations });
    if (plano._tag === 'err') {
      console.error(`\n${failureMessage(plano.error)}`);
      for (const [chave, valor] of Object.entries(plano.error)) {
        if (Array.isArray(valor) && valor.length > 0) console.error(`  ${chave}: ${valor.map((v) => path.basename(String(v))).join(', ')}`);
      }
      process.exit(1);
    }

    console.log(limite.value._tag === 'SemLimite' ? '\nPlano (sem limite: todas as pendentes):' : '\nPlano (até o limite, inclusive):');
    for (const m of plano.value.plano) console.log(linhaDoPlano('aplicar ', m));
    for (const m of plano.value.posteriores) console.log(linhaDoPlano('fica de fora', m));

    if (plano.value.plano.length === 0) {
      console.log('\nBanco em dia com o repositório.');
      process.exit(0);
    }
    if (previa || !aplicar) {
      console.log('\nSomente leitura: nada foi executado. Para aplicar este plano: --aplicar --confirmar (com o mesmo limite).');
      process.exit(previa ? 0 : 1);
    }
    if (!confirmado) {
      console.error('\n--aplicar executa DDL no banco acima. Repita com --confirmar.');
      process.exit(1);
    }

    console.log('');
    const r = await aplicarPendentes({ client, pendentes: plano.value.plano });
    if (r._tag === 'err') {
      console.error(`\n${failureMessage(r.error)}`);
      process.exit(1);
    }
    console.log(`\n${r.value.length} migração(ões) aplicada(s); ${plano.value.posteriores.length} posterior(es) não tocada(s).`);
  } finally {
    await client.end();
  }
}
