/**
 * exportService.ts
 * Ticket 17: exportação de dados do titular — arquivo temporário cifrado,
 * com expiração, manifest versionado, e filtro de segredos/metadados
 * internos. Nunca grava o dado em texto plano em disco; nunca inclui
 * `access_token`/`refresh_token`/`webhook_secret`/`api_key`/senha/dado de
 * outro titular/metadados internos (lease_owner, ids de outra organização).
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const EXPORT_SCHEMA_VERSION = 1;

/** Chaves que nunca podem sobreviver à exportação, em qualquer profundidade
 * do payload — casefold e substring, para pegar variações
 * (`access_token`, `Authorization`, `webhook_secret`, `client_secret`...). */
const FORBIDDEN_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /token/i,
  /secret/i,
  /password/i,
  /senha/i,
  /api_key/i,
  /apikey/i,
  /authorization/i,
  /^lease_owner$/i,
  /^lease_expires_at$/i,
];

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) continue;
      result[key] = redactUnknown(v);
    }
    return result;
  }
  return value;
}

/** Remove recursivamente qualquer campo cujo nome bata com os padrões
 * proibidos, em objetos e arrays, preservando o resto da estrutura. Nunca
 * lança — payload malformado vira `null`/valor primitivo inalterado. */
export function redactExportPayload<T>(value: T): T {
  // SAFETY: redactUnknown only ever removes keys/elements from the input
  // shape (never adds or retypes a surviving value), so the redacted result
  // is always structurally assignable back to the caller's T.
  return redactUnknown(value) as T;
}

export interface ExportSystemEntry {
  readonly sistema: string;
  readonly status: string;
  readonly registros: number;
}

export interface ExportManifest {
  readonly schemaVersion: number;
  readonly solicitacaoId: string;
  readonly organizacaoId: string;
  readonly geradoEm: string;
  readonly sistemas: ReadonlyArray<ExportSystemEntry>;
  readonly conteudoHashSha256: string;
}

export function buildExportManifest(params: {
  readonly solicitacaoId: string;
  readonly organizacaoId: string;
  readonly geradoEm: string;
  readonly sistemas: ReadonlyArray<ExportSystemEntry>;
  readonly redactedPayload: unknown;
}): ExportManifest {
  const serialized = JSON.stringify(params.redactedPayload);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    solicitacaoId: params.solicitacaoId,
    organizacaoId: params.organizacaoId,
    geradoEm: params.geradoEm,
    sistemas: params.sistemas,
    conteudoHashSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
  };
}

export interface EncryptedExportFile {
  readonly filePath: string;
  /** Chave efêmera desta exportação, hex — nunca persistida em texto plano
   * fora da resposta imediata ao operador que a solicitou; a linha em
   * `titular_exportacoes` nunca guarda a chave, só o caminho/manifest. */
  readonly encryptionKeyHex: string;
  readonly expiresAt: Date;
}

/** Cifra o payload (já redigido) com AES-256-GCM e grava em um arquivo
 * temporário local: `iv(12) || authTag(16) || ciphertext`. Chave gerada por
 * exportação, nunca reaproveitada entre solicitações. */
export async function writeEncryptedExport(params: {
  readonly redactedPayload: unknown;
  readonly tempDir: string;
  readonly ttlMinutes: number;
  readonly now?: Date;
}): Promise<EncryptedExportFile> {
  await fs.mkdir(params.tempDir, { recursive: true });

  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(params.redactedPayload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const fileName = `titular-export-${crypto.randomUUID()}.bin`;
  const filePath = path.join(params.tempDir, fileName);
  await fs.writeFile(filePath, Buffer.concat([iv, authTag, encrypted]));

  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMinutes * 60_000);

  return { filePath, encryptionKeyHex: key.toString('hex'), expiresAt };
}

/** Descriptografa um arquivo escrito por `writeEncryptedExport` — usado por
 * quem detém a chave (o operador que solicitou, no momento da entrega) e
 * pelos próprios testes para provar que o conteúdo cifrado é o esperado. */
export async function readEncryptedExport(filePath: string, encryptionKeyHex: string): Promise<unknown> {
  const raw = await fs.readFile(filePath);
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const key = Buffer.from(encryptionKeyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

export interface ExportCleanupCandidate {
  readonly id: string;
  readonly caminhoArquivo: string;
  readonly expiraEm: Date;
  readonly status: 'disponivel' | 'expirado' | 'removido';
}

export interface ExportCleanupOutcome {
  readonly id: string;
  readonly removed: boolean;
}

/** Remove do disco todo arquivo de exportação `disponivel` cujo `expiraEm`
 * já passou; nunca toca em arquivos ainda válidos ou já removidos. Chamador
 * é responsável por persistir o novo status (`expirado`) para cada `id`
 * retornado com `removed: true`. */
export async function cleanupExpiredExports(
  candidates: ReadonlyArray<ExportCleanupCandidate>,
  now: Date,
  unlink: (filePath: string) => Promise<void> = (p) => fs.unlink(p),
): Promise<ExportCleanupOutcome[]> {
  const outcomes: ExportCleanupOutcome[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== 'disponivel' || candidate.expiraEm.getTime() > now.getTime()) continue;
    try {
      await unlink(candidate.caminhoArquivo);
      outcomes.push({ id: candidate.id, removed: true });
    } catch (err) {
      // Arquivo já removido (ex.: cleanup concorrente) não é uma falha —
      // qualquer outro erro é reportado, nunca engolido silenciosamente.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        outcomes.push({ id: candidate.id, removed: true });
      } else {
        outcomes.push({ id: candidate.id, removed: false });
      }
    }
  }
  return outcomes;
}
