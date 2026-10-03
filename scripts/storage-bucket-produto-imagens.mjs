import fs from 'node:fs';
import path from 'node:path';

import { err, failureMessage, ok } from './script-result.mjs';

/**
 * Estado e provisionamento do bucket `produto-imagens`, onde fica a foto do
 * produto escolhida no ORBITA.
 *
 * Existe para que nenhuma requisição de usuário crie bucket. A aplicação
 * assume o bucket pronto; quem o cria é uma pessoa, por este script, com alvo
 * explícito e confirmação — o mesmo desenho de `migracoes-remotas.mjs`.
 *
 * A configuração desejada é lida de `src/lib/config/produtoImagemBucket.json`,
 * o mesmo arquivo que o contrato TypeScript importa: privado, JPEG/PNG/WebP,
 * 3 MB (o limite por imagem do Bling). Tudo passa pela API oficial do Storage (`getBucket`, `createBucket`,
 * `updateBucket`); nada toca `storage.buckets` ou `storage.objects` por SQL.
 *
 * Nenhuma policy de `storage.objects` é criada nem precisa existir: o bucket é
 * privado, o upload usa token assinado emitido pelo servidor para um caminho
 * exato, e a leitura usa URL assinada. Sem policy, `anon` e `authenticated`
 * não leem nem escrevem nada nele diretamente.
 *
 * ```bash
 * npm run storage:status  -- --url https://<ref>.supabase.co
 * npm run storage:aplicar -- --url https://<ref>.supabase.co --confirmar
 * ```
 *
 * A chave vem só do ambiente, nunca de argumento (argumento fica no histórico
 * do shell), e nunca é impressa.
 */

export const CAMINHO_DA_CONFIGURACAO = path.resolve('src/lib/config/produtoImagemBucket.json');

/**
 * @returns {{ id: string, public: boolean, fileSizeLimit: number, allowedMimeTypes: string[] }}
 */
export function lerConfiguracaoDesejada(caminho = CAMINHO_DA_CONFIGURACAO) {
  return JSON.parse(fs.readFileSync(caminho, 'utf8'));
}

const mesmoConjunto = (a = [], b = []) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Compara o bucket remoto com o desejado.
 *
 * @param {null | { public: boolean, file_size_limit?: number | null, allowed_mime_types?: string[] | null }} atual - `null` quando o bucket não existe.
 * @param {ReturnType<typeof lerConfiguracaoDesejada>} desejado
 * @returns {{ _tag: 'Criar' } | { _tag: 'Atualizar', divergencias: string[] } | { _tag: 'EmConformidade' }}
 */
export function planejarBucket(atual, desejado) {
  if (atual === null) return { _tag: 'Criar' };
  const divergencias = [];
  if (atual.public !== desejado.public) divergencias.push(`public: ${atual.public} → ${desejado.public}`);
  if (Number(atual.file_size_limit ?? 0) !== desejado.fileSizeLimit) {
    divergencias.push(`file_size_limit: ${atual.file_size_limit ?? 'sem limite'} → ${desejado.fileSizeLimit}`);
  }
  if (!mesmoConjunto(atual.allowed_mime_types ?? [], desejado.allowedMimeTypes)) {
    divergencias.push(`allowed_mime_types: ${(atual.allowed_mime_types ?? []).join(',') || 'qualquer'} → ${desejado.allowedMimeTypes.join(',')}`);
  }
  return divergencias.length === 0 ? { _tag: 'EmConformidade' } : { _tag: 'Atualizar', divergencias };
}

/** Bucket inexistente volta como erro 400/404 com "not found", conforme a versão do Storage. */
function naoEncontrado(erro) {
  return erro?.status === 404 || erro?.statusCode === '404' || /not.?found/iu.test(erro?.message ?? '');
}

/**
 * Lê o estado e, só com `aplicar`, cria ou ajusta o bucket. Idempotente: a
 * segunda execução encontra o bucket em conformidade e não escreve nada.
 *
 * @param {object} options
 * @param {{ getBucket: Function, createBucket: Function, updateBucket: Function }} options.storage - `supabase.storage`.
 * @param {boolean} [options.aplicar]
 * @param {ReturnType<typeof lerConfiguracaoDesejada>} [options.desejado]
 */
export async function provisionarBucket({ storage, aplicar = false, desejado = lerConfiguracaoDesejada() }) {
  const lido = await storage.getBucket(desejado.id);
  if (lido.error && !naoEncontrado(lido.error)) {
    return err('BucketIlegivel', `não foi possível ler o bucket ${desejado.id} (status ${lido.error.status ?? 'desconhecido'})`);
  }
  const plano = planejarBucket(lido.error ? null : lido.data, desejado);
  if (plano._tag === 'EmConformidade' || !aplicar) return ok({ plano, aplicado: false });

  const opcoes = { public: desejado.public, fileSizeLimit: desejado.fileSizeLimit, allowedMimeTypes: desejado.allowedMimeTypes };
  const escrito = plano._tag === 'Criar'
    ? await storage.createBucket(desejado.id, opcoes)
    : await storage.updateBucket(desejado.id, opcoes);
  if (escrito.error) {
    return err('BucketNaoAplicado', `o Storage recusou ${plano._tag === 'Criar' ? 'a criação' : 'o ajuste'} do bucket ${desejado.id}`);
  }

  // Confere de novo pela leitura: o que vale é o estado, não a resposta da escrita.
  const relido = await storage.getBucket(desejado.id);
  const depois = relido.error ? { _tag: 'Criar' } : planejarBucket(relido.data, desejado);
  if (depois._tag !== 'EmConformidade') {
    return err('BucketForaDeConformidade', `o bucket ${desejado.id} ainda diverge depois da aplicação`);
  }
  return ok({ plano, aplicado: true });
}

/** O alvo nunca tem padrão: sem `--url` https explícito, o script recusa. */
export function lerAlvo(argv, env) {
  const indice = argv.indexOf('--url');
  const url = indice >= 0 ? argv[indice + 1] : undefined;
  if (!url || !/^https:\/\/[^/\s]+$/u.test(url)) return err('AlvoAusente', 'informe --url https://<projeto>.supabase.co');
  const chave = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!chave) return err('ChaveAusente', 'defina SUPABASE_SERVICE_ROLE_KEY no ambiente (nunca como argumento)');
  return ok({ url, chave });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/storage-bucket-produto-imagens.mjs')) {
  const alvo = lerAlvo(process.argv, process.env);
  if (alvo._tag === 'err') {
    console.error(failureMessage(alvo.error));
    process.exit(1);
  }
  const aplicar = process.argv.includes('--aplicar');
  if (aplicar && !process.argv.includes('--confirmar')) {
    console.error('--aplicar cria ou altera o bucket no projeto acima. Repita com --confirmar.');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const cliente = createClient(alvo.value.url, alvo.value.chave, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log(`Projeto alvo: ${new URL(alvo.value.url).host}`);

  const r = await provisionarBucket({ storage: cliente.storage, aplicar });
  if (r._tag === 'err') {
    console.error(failureMessage(r.error));
    process.exit(1);
  }
  const { plano, aplicado } = r.value;
  if (plano._tag === 'EmConformidade') console.log('Bucket produto-imagens em conformidade. Nada a fazer.');
  else if (aplicado) console.log(`Bucket produto-imagens: ${plano._tag === 'Criar' ? 'criado' : 'ajustado'} e conferido.`);
  else {
    console.log(plano._tag === 'Criar' ? 'Bucket produto-imagens não existe.' : 'Bucket produto-imagens diverge:');
    for (const d of plano.divergencias ?? []) console.log(`  ${d}`);
    console.log('\nSomente leitura. Para aplicar: --aplicar --confirmar');
    process.exit(1);
  }
}
