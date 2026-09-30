import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { SupabaseArmazenamentoDeImagem } from './armazenamentoDeImagem';

type Resposta = { data: unknown; error: unknown };

/**
 * `supabase.storage.from(bucket)` gravando o que recebe. Responde o que o
 * teste manda, no formato de `@supabase/storage-js`.
 */
function clienteFalso(respostas: Partial<Record<'createSignedUploadUrl' | 'info' | 'remove' | 'createSignedUrls', Resposta>>) {
  const chamadas: Array<{ bucket: string; metodo: string; args: unknown[] }> = [];
  const metodo = (bucket: string, nome: keyof typeof respostas) => async (...args: unknown[]) => {
    chamadas.push({ bucket, metodo: nome, args });
    return respostas[nome] ?? { data: null, error: null };
  };
  const cliente = {
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: metodo(bucket, 'createSignedUploadUrl'),
        info: metodo(bucket, 'info'),
        remove: metodo(bucket, 'remove'),
        createSignedUrls: metodo(bucket, 'createSignedUrls'),
      }),
    },
  };
  // SAFETY: o fake implementa só o subconjunto de `storage` que o adapter usa;
  // é o adapter, e não o SDK, que está sob teste.
  return { cliente: cliente as unknown as SupabaseClient, chamadas };
}

const CAMINHO = 'o/p/x.png';

describe('SupabaseArmazenamentoDeImagem — API oficial do Storage, bucket produto-imagens', () => {
  it('autoriza upload só para o caminho pedido e sem sobrescrever objeto existente', async () => {
    const { cliente, chamadas } = clienteFalso({ createSignedUploadUrl: { data: { token: 'tk', path: CAMINHO, signedUrl: 'u' }, error: null } });
    expect(await new SupabaseArmazenamentoDeImagem(cliente).autorizarUpload(CAMINHO)).toEqual({ _tag: 'Autorizado', token: 'tk' });
    expect(chamadas).toEqual([{ bucket: 'produto-imagens', metodo: 'createSignedUploadUrl', args: [CAMINHO, { upsert: false }] }]);
  });

  it('inspeção: presente com tamanho e tipo; 404 é ausente; outro erro é indisponível', async () => {
    const presente = clienteFalso({ info: { data: { size: 123, contentType: 'image/png' }, error: null } });
    expect(await new SupabaseArmazenamentoDeImagem(presente.cliente).inspecionar(CAMINHO))
      .toEqual({ _tag: 'Presente', tamanho: 123, tipo: 'image/png' });

    const peloMetadata = clienteFalso({ info: { data: { metadata: { size: 9, mimetype: 'image/webp' } }, error: null } });
    expect(await new SupabaseArmazenamentoDeImagem(peloMetadata.cliente).inspecionar(CAMINHO))
      .toEqual({ _tag: 'Presente', tamanho: 9, tipo: 'image/webp' });

    for (const erro of [{ status: 404, message: 'x' }, { status: 400, statusCode: '404', message: 'x' }, { status: 400, message: 'Object not found' }]) {
      const ausente = clienteFalso({ info: { data: null, error: erro } });
      expect(await new SupabaseArmazenamentoDeImagem(ausente.cliente).inspecionar(CAMINHO)).toEqual({ _tag: 'Ausente' });
    }

    const fora = clienteFalso({ info: { data: null, error: { status: 503, message: 'upstream' } } });
    expect((await new SupabaseArmazenamentoDeImagem(fora.cliente).inspecionar(CAMINHO))._tag).toBe('Indisponivel');
  });

  it('assina leituras em lote e deixa fora o caminho que falhou', async () => {
    const { cliente, chamadas } = clienteFalso({
      createSignedUrls: {
        data: [
          { path: 'a.png', signedUrl: 'https://s/a', error: null },
          { path: 'b.png', signedUrl: null, error: 'Either the object does not exist' },
        ],
        error: null,
      },
    });
    const r = await new SupabaseArmazenamentoDeImagem(cliente).assinarLeituras(['a.png', 'b.png'], 3600);
    expect(r._tag === 'Assinadas' && [...r.urls]).toEqual([['a.png', 'https://s/a']]);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.args).toEqual([['a.png', 'b.png'], 3600]);
  });

  it('lista vazia não chama o Storage', async () => {
    const { cliente, chamadas } = clienteFalso({});
    expect((await new SupabaseArmazenamentoDeImagem(cliente).assinarLeituras([], 60))._tag).toBe('Assinadas');
    expect(chamadas).toEqual([]);
  });

  it('remoção relata falha sem lançar', async () => {
    const { cliente } = clienteFalso({ remove: { data: null, error: { message: 'x' } } });
    expect((await new SupabaseArmazenamentoDeImagem(cliente).remover([CAMINHO]))._tag).toBe('Falhou');
  });
});
