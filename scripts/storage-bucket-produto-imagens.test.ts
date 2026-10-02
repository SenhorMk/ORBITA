import { describe, expect, it } from 'vitest';

import { BUCKET_PRODUTO_IMAGENS, TAMANHO_MAXIMO_DA_IMAGEM, TIPOS_DE_IMAGEM } from '../src/lib/config/produtoImagemContract';
import { lerAlvo, lerConfiguracaoDesejada, planejarBucket, provisionarBucket } from './storage-bucket-produto-imagens.mjs';

const desejado = lerConfiguracaoDesejada();

/** `supabase.storage` em memória, gravando cada escrita. */
function storageFalso(inicial: Record<string, unknown> | null, opcoes: { recusarEscrita?: boolean; ilegivel?: boolean } = {}) {
  let bucket = inicial;
  const escritas: string[] = [];
  return {
    escritas,
    storage: {
      async getBucket() {
        if (opcoes.ilegivel) return { data: null, error: { status: 500, message: 'x' } };
        return bucket ? { data: bucket, error: null } : { data: null, error: { status: 400, statusCode: '404', message: 'Bucket not found' } };
      },
      async createBucket(id: string, o: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) {
        escritas.push(`create ${id}`);
        if (opcoes.recusarEscrita) return { data: null, error: { message: 'recusado' } };
        bucket = { id, public: o.public, file_size_limit: o.fileSizeLimit, allowed_mime_types: o.allowedMimeTypes };
        return { data: { name: id }, error: null };
      },
      async updateBucket(id: string, o: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) {
        escritas.push(`update ${id}`);
        bucket = { ...bucket, public: o.public, file_size_limit: o.fileSizeLimit, allowed_mime_types: o.allowedMimeTypes };
        return { data: { message: 'ok' }, error: null };
      },
    },
  };
}

describe('provisionamento do bucket produto-imagens', () => {
  it('a configuração é a mesma que o contrato TypeScript usa', () => {
    expect(desejado).toEqual({
      id: BUCKET_PRODUTO_IMAGENS,
      public: false,
      fileSizeLimit: TAMANHO_MAXIMO_DA_IMAGEM,
      allowedMimeTypes: [...TIPOS_DE_IMAGEM],
    });
  });

  it('planeja criar, ajustar (com cada divergência nomeada) ou nada', () => {
    expect(planejarBucket(null, desejado)).toEqual({ _tag: 'Criar' });
    expect(planejarBucket({ public: false, file_size_limit: 3145728, allowed_mime_types: ['image/webp', 'image/png', 'image/jpeg'] }, desejado))
      .toEqual({ _tag: 'EmConformidade' });
    const plano = planejarBucket({ public: true, file_size_limit: null, allowed_mime_types: null }, desejado);
    expect(plano._tag).toBe('Atualizar');
    expect(plano._tag === 'Atualizar' && plano.divergencias).toHaveLength(3);
  });

  it('status é somente leitura: não escreve nada, nem com bucket ausente', async () => {
    const falso = storageFalso(null);
    const r = await provisionarBucket({ storage: falso.storage, desejado });
    expect(r).toMatchObject({ _tag: 'ok', value: { plano: { _tag: 'Criar' }, aplicado: false } });
    expect(falso.escritas).toEqual([]);
  });

  it('aplicar cria, confere pela releitura, e a segunda execução não escreve nada (idempotente)', async () => {
    const falso = storageFalso(null);
    expect(await provisionarBucket({ storage: falso.storage, aplicar: true, desejado })).toMatchObject({ _tag: 'ok', value: { aplicado: true } });
    expect(await provisionarBucket({ storage: falso.storage, aplicar: true, desejado })).toMatchObject({ _tag: 'ok', value: { plano: { _tag: 'EmConformidade' }, aplicado: false } });
    expect(falso.escritas).toEqual(['create produto-imagens']);
  });

  it('bucket público é tornado privado por update', async () => {
    const falso = storageFalso({ id: 'produto-imagens', public: true, file_size_limit: 3145728, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] });
    expect((await provisionarBucket({ storage: falso.storage, aplicar: true, desejado }))._tag).toBe('ok');
    expect(falso.escritas).toEqual(['update produto-imagens']);
  });

  it('recusa e ilegibilidade são falhas tipadas', async () => {
    expect((await provisionarBucket({ storage: storageFalso(null, { recusarEscrita: true }).storage, aplicar: true, desejado }))._tag).toBe('err');
    expect((await provisionarBucket({ storage: storageFalso(null, { ilegivel: true }).storage, desejado }))._tag).toBe('err');
  });

  it('sem --url https explícito ou sem a chave no ambiente, recusa', () => {
    expect(lerAlvo([], { SUPABASE_SERVICE_ROLE_KEY: 'k' })._tag).toBe('err');
    expect(lerAlvo(['--url', 'http://x.supabase.co'], { SUPABASE_SERVICE_ROLE_KEY: 'k' })._tag).toBe('err');
    expect(lerAlvo(['--url', 'https://x.supabase.co'], {})._tag).toBe('err');
    expect(lerAlvo(['--url', 'https://x.supabase.co'], { SUPABASE_SERVICE_ROLE_KEY: 'k' })._tag).toBe('ok');
  });
});
