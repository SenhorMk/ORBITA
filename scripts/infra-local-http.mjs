import https from 'node:https';

/**
 * GET HTTPS local do infra-local (MSG-020C). Resolve sempre: `status` 0 quando não
 * houve resposta (erro de rede ou timeout).
 *
 * @param {{ port: number, path: string, timeoutMs: number }} opcoes
 * @returns {Promise<{ status: number, corpo: string }>}
 */
export function getHttpsLocal({ port, path, timeoutMs }) {
  return new Promise((ok) => {
    // Certificado interno do Caddy para localhost: só esta checagem local o aceita.
    const req = https.get({ host: '127.0.0.1', port, path, servername: 'localhost', headers: { host: 'localhost' }, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, corpo }));
    });
    // A opção timeout só avisa: sem destroy a conexão fica aberta e a promessa não resolve.
    req.on('timeout', () => req.destroy(new Error(`timeout de ${timeoutMs} ms`)));
    req.on('error', (e) => ok({ status: 0, corpo: e.message }));
  });
}
