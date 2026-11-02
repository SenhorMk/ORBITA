import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Operação do Chatwoot CE do MSG-001 por `docker compose`. A prova usa um projeto
 * próprio (`PROJETO_DA_PROVA`), apagado a cada execução: nunca toca os volumes do
 * ambiente de desenvolvimento. Nada aqui recebe segredo real.
 */

export const VERSAO_FIXADA = '4.19.1';
export const PROJETO_DA_PROVA = 'orbita-chatwoot-prova';
export const PORTA_DA_PROVA = 3187;
const ARQUIVO = 'infra/chatwoot-dev/docker-compose.yml';

/** @returns {Record<string, string>} Segredos descartáveis, só em memória, para uma execução da prova. */
export function segredosDaProva() {
  const aleatorio = () => crypto.randomBytes(32).toString('hex');
  return {
    CHATWOOT_DEV_PORT: String(PORTA_DA_PROVA),
    CHATWOOT_SECRET_KEY_BASE: aleatorio(),
    CHATWOOT_POSTGRES_PASSWORD: aleatorio(),
    CHATWOOT_REDIS_PASSWORD: aleatorio(),
  };
}

/**
 * @param {string[]} args - Argumentos depois de `docker compose -p <projeto> -f <arquivo>`.
 * @param {{ readonly entrada?: Uint8Array | string, readonly binario?: boolean, readonly timeout?: number }} [opcoes] - Entrada e formato.
 * @returns {import('node:child_process').SpawnSyncReturns<any>} Resultado do processo.
 */
export function compose(args, opcoes = {}) {
  return spawnSync('docker', ['compose', '-p', PROJETO_DA_PROVA, '-f', ARQUIVO, ...args], {
    encoding: opcoes.binario ? undefined : 'utf8',
    input: opcoes.entrada,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    timeout: opcoes.timeout ?? 300_000,
  });
}

/**
 * Espera a API responder. Só um 200 com a versão conta como de pé.
 *
 * @param {string} base - Origem do Chatwoot.
 * @param {number} [tentativas] - Tentativas, a cada dois segundos.
 * @returns {Promise<string | null>} Versão informada pela instância, ou `null`.
 */
export async function esperarChatwoot(base, tentativas = 150) {
  for (let i = 0; i < tentativas; i += 1) {
    try {
      const resposta = await fetch(`${base}/api`, { signal: AbortSignal.timeout(3000) });
      if (resposta.status === 200) {
        const corpo = await resposta.json();
        if (typeof corpo.version === 'string') return corpo.version;
      }
    } catch {
      // Ainda subindo.
    }
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
  return null;
}

const PROVISIONAR = `
senha = ENV.fetch('CW_SENHA')
saida = %w[a b].map do |letra|
  conta = Account.create!(name: "Conta sintetica #{letra}")
  usuario = User.new(name: "Agente sintetico #{letra}", email: "agente-#{letra}@orbita.test", password: senha, password_confirmation: senha)
  usuario.skip_confirmation!
  usuario.save!
  AccountUser.create!(account: conta, user: usuario, role: :administrator)
  { letra: letra, account_id: conta.id, token: usuario.access_token.token }
end
puts "PROVISIONADO=#{saida.to_json}"
`;

/**
 * Cria duas contas sintéticas com um agente administrador em cada uma.
 *
 * @returns {{ readonly letra: string, readonly account_id: number, readonly token: string }[]} Contas criadas.
 */
export function provisionarContas() {
  const senha = `Aa1!${crypto.randomBytes(16).toString('hex')}`;
  const r = compose(['exec', '-T', '-e', `CW_SENHA=${senha}`, 'rails', 'bundle', 'exec', 'rails', 'runner', PROVISIONAR]);
  const linha = String(r.stdout).split('\n').find((l) => l.startsWith('PROVISIONADO='));
  if (r.status !== 0 || !linha) throw new Error(`Provisionamento falhou: ${String(r.stderr).slice(-400)}`);
  return JSON.parse(linha.slice('PROVISIONADO='.length));
}

/** @returns {string} IPv4 da máquina visto de dentro do container: o IPv6 anunciado pelo Docker Desktop nem sempre tem rota. */
export function ipv4DoHostNoContainer() {
  const r = compose(['exec', '-T', 'sidekiq', 'getent', 'ahostsv4', 'host.docker.internal']);
  const ip = /^(\d+\.\d+\.\d+\.\d+)\s/m.exec(String(r.stdout))?.[1];
  if (!ip) throw new Error('IPv4 do host não encontrado no container');
  return ip;
}

/** @returns {boolean} `true` quando Postgres e Redis não publicam nenhuma porta no host. */
export function bancosSemPortaNoHost() {
  return ['postgres', 'redis'].every((servico) => {
    const r = compose(['ps', '--format', 'json', servico]);
    const publicadas = String(r.stdout).split('\n').filter(Boolean).flatMap((l) => JSON.parse(l).Publishers ?? []);
    return publicadas.length > 0 && publicadas.every((p) => !p.PublishedPort);
  });
}

/**
 * Backup lógico, perda total do volume do Postgres e restore. O que importa é o
 * banco voltar com as mensagens e os tokens de antes.
 *
 * @param {string} senhaDoPostgres - Senha descartável da prova.
 * @returns {void}
 */
export function destruirERestaurarBanco(senhaDoPostgres) {
  const dump = compose(['exec', '-T', '-e', `PGPASSWORD=${senhaDoPostgres}`, 'postgres', 'pg_dump', '-U', 'postgres', '-Fc', 'chatwoot'], { binario: true });
  if (dump.status !== 0 || !dump.stdout?.length) throw new Error('pg_dump falhou');
  compose(['stop', 'rails', 'sidekiq', 'postgres']);
  compose(['rm', '-f', 'postgres']);
  const removido = spawnSync('docker', ['volume', 'rm', `${PROJETO_DA_PROVA}_postgres`], { encoding: 'utf8' });
  if (removido.status !== 0) throw new Error(`Volume não removido: ${removido.stderr}`);
  compose(['up', '-d', '--wait', 'postgres']);
  const restore = compose(['exec', '-T', '-e', `PGPASSWORD=${senhaDoPostgres}`, 'postgres', 'pg_restore', '-U', 'postgres', '-d', 'chatwoot', '--no-owner', '--exit-on-error'], { entrada: dump.stdout, binario: true });
  if (restore.status !== 0) throw new Error(`pg_restore falhou: ${String(restore.stderr).slice(-400)}`);
  compose(['up', '-d', 'rails', 'sidekiq']);
}
