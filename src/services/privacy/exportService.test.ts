import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExportManifest,
  cleanupExpiredExports,
  readEncryptedExport,
  redactExportPayload,
  writeEncryptedExport,
  type ExportCleanupCandidate,
} from './exportService';

describe('redactExportPayload — export sem secrets', () => {
  it('strips tokens/secrets/passwords/api keys at any depth', () => {
    const input = {
      cliente: { nome: 'Fulano', email: 'fulano@example.com' },
      conexao: {
        access_token: 'abc123',
        refresh_token: 'def456',
        webhook_secret: 'whsec_xxx',
        api_key: 'key_xxx',
        password: 'senha-super-secreta',
        senha: 'outra-senha',
        client_secret: 'shh',
        Authorization: 'Bearer zzz',
        lease_owner: 'worker-1',
      },
      pedidos: [{ id: '1', total: 99.9, meta: { token: 'nested-token' } }],
    };

    const redacted = redactExportPayload(input) as typeof input;

    expect(redacted.cliente).toEqual({ nome: 'Fulano', email: 'fulano@example.com' });
    expect(Object.keys((redacted as unknown as { conexao: Record<string, unknown> }).conexao)).toEqual([]);
    expect((redacted.pedidos[0] as unknown as { meta: Record<string, unknown> }).meta).toEqual({});
    expect(JSON.stringify(redacted)).not.toMatch(/abc123|def456|whsec_xxx|key_xxx|senha-super-secreta|Bearer zzz|nested-token/);
  });

  it('leaves ordinary business fields untouched', () => {
    const input = { nome: 'Fulano', telefone: '11999999999', total: 10 };
    expect(redactExportPayload(input)).toEqual(input);
  });
});

describe('buildExportManifest', () => {
  it('produces a versioned manifest with a content hash over the redacted payload', () => {
    const manifest = buildExportManifest({
      solicitacaoId: 'req-1',
      organizacaoId: 'org-1',
      geradoEm: '2026-01-01T00:00:00Z',
      sistemas: [{ sistema: 'banco', status: 'completed', registros: 3 }],
      redactedPayload: { foo: 'bar' },
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sistemas).toEqual([{ sistema: 'banco', status: 'completed', registros: 3 }]);
    expect(manifest.conteudoHashSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('writeEncryptedExport / readEncryptedExport', () => {
  const tempDir = path.join(os.tmpdir(), 'orbita-titular-export-test');

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a file that is not plaintext-readable without the key, and decrypts correctly with it', async () => {
    const payload = { cliente: { nome: 'Fulano', email: 'fulano@example.com' } };
    const result = await writeEncryptedExport({ redactedPayload: payload, tempDir, ttlMinutes: 60 });

    const rawOnDisk = await fs.readFile(result.filePath, 'utf8').catch(() => null);
    // O conteúdo cifrado não deve conter o texto plano do payload.
    if (rawOnDisk !== null) {
      expect(rawOnDisk).not.toContain('fulano@example.com');
    }

    const decrypted = await readEncryptedExport(result.filePath, result.encryptionKeyHex);
    expect(decrypted).toEqual(payload);
  });

  it('rejects decryption with the wrong key (authenticated encryption)', async () => {
    const payload = { cliente: { nome: 'Fulano' } };
    const result = await writeEncryptedExport({ redactedPayload: payload, tempDir, ttlMinutes: 60 });
    const wrongKey = '00'.repeat(32);
    await expect(readEncryptedExport(result.filePath, wrongKey)).rejects.toBeTruthy();
  });

  it('sets an expiration ttlMinutes in the future from `now`', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const result = await writeEncryptedExport({ redactedPayload: {}, tempDir, ttlMinutes: 30, now });
    expect(result.expiresAt.toISOString()).toBe('2026-01-01T00:30:00.000Z');
  });
});

describe('cleanupExpiredExports', () => {
  it('deletes only expired, still-available exports — never future or already-removed ones', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const unlinkCalls: string[] = [];
    const unlink = async (p: string) => {
      unlinkCalls.push(p);
    };

    const candidates: ExportCleanupCandidate[] = [
      { id: 'expired-1', caminhoArquivo: '/tmp/a.bin', expiraEm: new Date('2026-01-01T00:00:00Z'), status: 'disponivel' },
      { id: 'future-1', caminhoArquivo: '/tmp/b.bin', expiraEm: new Date('2026-01-03T00:00:00Z'), status: 'disponivel' },
      { id: 'already-removed-1', caminhoArquivo: '/tmp/c.bin', expiraEm: new Date('2026-01-01T00:00:00Z'), status: 'removido' },
    ];

    const outcomes = await cleanupExpiredExports(candidates, now, unlink);

    expect(unlinkCalls).toEqual(['/tmp/a.bin']);
    expect(outcomes).toEqual([{ id: 'expired-1', removed: true }]);
  });

  it('treats an already-missing file (ENOENT) as successfully cleaned up, not a failure', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const unlink = async () => {
      const err = new Error('missing') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const outcomes = await cleanupExpiredExports(
      [{ id: 'x', caminhoArquivo: '/tmp/gone.bin', expiraEm: new Date('2026-01-01T00:00:00Z'), status: 'disponivel' }],
      now,
      unlink,
    );
    expect(outcomes).toEqual([{ id: 'x', removed: true }]);
  });
});
