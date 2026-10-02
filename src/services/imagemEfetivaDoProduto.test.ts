import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { VALIDADE_DA_LEITURA_ASSINADA_S } from '@/lib/config/produtoImagemContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { Produto } from '@/types';

import type { ArmazenamentoDeImagemPort } from './armazenamentoDeImagem';
import { comImagemEfetiva } from './imagemEfetivaDoProduto';

const ORG = '11111111-1111-4111-8111-111111111111';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;

const FOTO = `${ORG}/33333333-3333-4333-8333-333333333333/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
const BLING = 'https://orgbling.s3.amazonaws.com/p.jpg';

const produto = (id: string, extra: Partial<Produto> = {}): Produto => ({ id, bling_id: id, nome: id, preco: 1, estoque: 1, ...extra });

function armazenamento(resultado: 'ok' | 'indisponivel' = 'ok') {
  const chamadas: Array<{ caminhos: readonly string[]; validade: number }> = [];
  const porta: Pick<ArmazenamentoDeImagemPort, 'assinarLeituras'> = {
    async assinarLeituras(caminhos, validade) {
      chamadas.push({ caminhos, validade });
      if (resultado === 'indisponivel') return { _tag: 'Indisponivel', causa: new Error('fora') };
      return { _tag: 'Assinadas', urls: new Map(caminhos.map((c) => [c, `https://storage.test/sign/${c}?token=t`])) };
    },
  };
  return { porta, chamadas };
}

describe('imagem efetiva: foto do ORBITA → Bling → placeholder', () => {
  it('a foto do ORBITA vence a imagem do Bling, por URL assinada; o caminho continua separado', async () => {
    const { porta } = armazenamento();
    const [p] = await comImagemEfetiva(scope, [produto('p1', { imagem_url: BLING, imagem_storage_path: FOTO })], porta);
    expect(p!.imagem_url).toBe(`https://storage.test/sign/${FOTO}?token=t`);
    expect(p!.imagem_storage_path).toBe(FOTO);
  });

  it('sem foto do ORBITA, vale a do Bling', async () => {
    const { porta, chamadas } = armazenamento();
    const [p] = await comImagemEfetiva(scope, [produto('p1', { imagem_url: BLING, imagem_storage_path: null })], porta);
    expect(p!.imagem_url).toBe(BLING);
    expect(chamadas).toEqual([]);
  });

  it('remoção pendente no Bling: o espelho é a foto que está saindo, e não volta para a tela', async () => {
    const { porta } = armazenamento();
    const [p] = await comImagemEfetiva(scope, [produto('p1', { imagem_url: BLING, imagem_storage_path: null, imagem_bling_sync_path: FOTO })], porta);
    expect(p).not.toHaveProperty('imagem_url');
  });

  it('nunca adotada pelo ORBITA + imagem do Bling: o fallback aparece', async () => {
    const { porta } = armazenamento();
    const [p] = await comImagemEfetiva(scope, [produto('p1', { imagem_url: BLING, imagem_bling_gerenciada_pelo_orbita: false })], porta);
    expect(p!.imagem_url).toBe(BLING);
  });

  it('gerenciada pelo ORBITA e sem foto: nunca mostra imagem_url — remoção pendente, confirmada, ou espelho regravado', async () => {
    const { porta } = armazenamento();
    const casos = [
      produto('confirmada', { imagem_url: BLING, imagem_bling_gerenciada_pelo_orbita: true }),
      produto('pendente', { imagem_url: BLING, imagem_bling_gerenciada_pelo_orbita: true, imagem_bling_sync_path: FOTO }),
      produto('drift', { imagem_url: BLING, imagem_bling_gerenciada_pelo_orbita: true, imagem_bling_divergencia_detectada_em: '2026-10-02T12:00:00Z' }),
    ];
    for (const p of await comImagemEfetiva(scope, casos, porta)) expect(p, p.id).not.toHaveProperty('imagem_url');
  });

  it('sem nenhuma das duas, imagem_url fica ausente — a tela desenha o placeholder', async () => {
    const { porta } = armazenamento();
    const [a, b] = await comImagemEfetiva(scope, [produto('a'), produto('b', { imagem_url: '  ' })], porta);
    expect(a).not.toHaveProperty('imagem_url');
    expect(b).not.toHaveProperty('imagem_url');
  });

  it('assina em lote: uma chamada só, sem caminhos repetidos, com a validade do contrato', async () => {
    const { porta, chamadas } = armazenamento();
    const outra = FOTO.replace('bbbbbbbb', 'cccccccc');
    await comImagemEfetiva(scope, [
      produto('a', { imagem_storage_path: FOTO }),
      produto('b', { imagem_storage_path: outra }),
      produto('c', { imagem_storage_path: FOTO }),
      produto('d'),
    ], porta);
    expect(chamadas).toEqual([{ caminhos: [FOTO, outra], validade: VALIDADE_DA_LEITURA_ASSINADA_S }]);
  });

  it('Storage fora do ar: o catálogo não cai; produto com foto é gerenciado, então placeholder, nunca o espelho', async () => {
    const { porta } = armazenamento('indisponivel');
    const produtos = await comImagemEfetiva(scope, [
      produto('a', { imagem_url: BLING, imagem_storage_path: FOTO }),
      produto('b', { imagem_storage_path: FOTO }),
    ], porta);
    expect(produtos[0]).not.toHaveProperty('imagem_url');
    expect(produtos[1]).not.toHaveProperty('imagem_url');
  });
});

describe('as leituras da tela passam pela imagem efetiva', () => {
  const fonte = (rota: string) => readFileSync(path.resolve(__dirname, '../app/api', rota, 'route.ts'), 'utf8');

  it.each(['dashboard', 'produtos'])('/api/%s entrega produtos por comImagemEfetiva, nunca o getAll cru', (rota) => {
    const codigo = fonte(rota);
    expect(codigo).toMatch(/comImagemEfetiva\(scope, await produtoRepository\.getAll\(scope\)/u);
    expect(codigo.match(/produtoRepository\.getAll/gu)).toHaveLength(1);
  });
});
