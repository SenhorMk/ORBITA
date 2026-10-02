import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACCEPT_DE_IMAGEM,
  BUCKET_PRODUTO_IMAGENS,
  TAMANHO_MAXIMO_DA_IMAGEM,
  caminhoDaImagem,
  caminhoPertenceAoProduto,
  estadoDaFotoNoBling,
  imagemGerenciadaPeloOrbita,
  problemaDoArquivo,
  tipoDoCaminho,
} from './produtoImagemContract';

const ORG = '11111111-1111-4111-8111-111111111111';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const OBJ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('contrato da foto do produto', () => {
  it('bucket privado, JPEG/PNG/WebP, 3 MB (limite do Bling)', () => {
    expect(BUCKET_PRODUTO_IMAGENS).toBe('produto-imagens');
    expect(TAMANHO_MAXIMO_DA_IMAGEM).toBe(3 * 1024 * 1024);
    expect(ACCEPT_DE_IMAGEM).toBe('image/jpeg,image/png,image/webp');
  });

  it('problemaDoArquivo: tipo antes de tamanho, e o limite é inclusivo', () => {
    expect(problemaDoArquivo('image/gif', 10)).toBe('TipoNaoPermitido');
    expect(problemaDoArquivo('image/png', TAMANHO_MAXIMO_DA_IMAGEM + 1)).toBe('ArquivoGrandeDemais');
    expect(problemaDoArquivo('image/png', TAMANHO_MAXIMO_DA_IMAGEM)).toBeNull();
    expect(problemaDoArquivo('', 10)).toBe('TipoNaoPermitido');
  });

  it('caminhoDaImagem segue <org>/<produto>/<uuid>.<ext> em minúsculas', () => {
    expect(caminhoDaImagem(ORG.toUpperCase(), PRODUTO, OBJ, 'image/jpeg')).toBe(`${ORG}/${PRODUTO}/${OBJ}.jpg`);
    expect(tipoDoCaminho(`${ORG}/${PRODUTO}/${OBJ}.webp`)).toBe('image/webp');
    expect(tipoDoCaminho(`${ORG}/${PRODUTO}/${OBJ}.gif`)).toBeNull();
  });

  it('caminhoPertenceAoProduto só aceita o prefixo exato deste produto nesta organização', () => {
    const outraOrg = '99999999-9999-4999-8999-999999999999';
    const outroProduto = '44444444-4444-4444-8444-444444444444';
    expect(caminhoPertenceAoProduto(`${ORG}/${PRODUTO}/${OBJ}.png`, ORG, PRODUTO)).toBe(true);
    for (const adulterado of [
      `${outraOrg}/${PRODUTO}/${OBJ}.png`,
      `${ORG}/${outroProduto}/${OBJ}.png`,
      `${ORG}/${PRODUTO}/../${outroProduto}/${OBJ}.png`,
      `${ORG}/${PRODUTO}/${OBJ}.png/../../x`,
      `/${ORG}/${PRODUTO}/${OBJ}.png`,
      `${ORG}/${PRODUTO}/${OBJ}.PNG`,
      `${ORG}/${PRODUTO}/${OBJ}.svg`,
      `${ORG}/${PRODUTO}/foto.png`,
      `${ORG}/${PRODUTO}/sub/${OBJ}.png`,
    ]) {
      expect(caminhoPertenceAoProduto(adulterado, ORG, PRODUTO), adulterado).toBe(false);
    }
  });

  it('a regra do caminho é a mesma da restrição do banco (migration 70)', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../../database/70_foto_personalizada_do_produto.sql'), 'utf8');
    expect(sql).toContain("'^' || organizacao_id::text || '/' || id::text");
    expect(sql).toContain('/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$');
  });
});

describe('estado da foto no Bling: autoridade da imagem × desejado × confirmado × drift', () => {
  const A = `${ORG}/${PRODUTO}/${OBJ}.png`;
  const base = { blingId: '777', gerenciada: false, desejado: null, confirmado: null, divergente: false };

  it('nunca adotada + null/null = sem_foto: o Bling é dono da imagem', () => {
    expect(estadoDaFotoNoBling(base)).toBe('sem_foto');
    expect(imagemGerenciadaPeloOrbita(base)).toBe(false);
  });

  it('gerenciada + null/null = sincronizada: o estado sincronizado é NENHUMA imagem, nunca sem_foto', () => {
    expect(estadoDaFotoNoBling({ ...base, gerenciada: true })).toBe('sincronizada');
  });

  it('gerenciada com foto confirmada = sincronizada; remoção pendente = pendente', () => {
    expect(estadoDaFotoNoBling({ ...base, gerenciada: true, desejado: A, confirmado: A })).toBe('sincronizada');
    expect(estadoDaFotoNoBling({ ...base, gerenciada: true, desejado: null, confirmado: A })).toBe('pendente');
  });

  it('drift: gerenciada, nada desejado, e uma leitura atual mostrou imagem no Bling = pendente', () => {
    expect(estadoDaFotoNoBling({ ...base, gerenciada: true, divergente: true })).toBe('pendente');
  });

  it('gerenciada sem vínculo = sem_vinculo, inclusive sem foto', () => {
    expect(estadoDaFotoNoBling({ ...base, blingId: 'LOCAL-1', gerenciada: true })).toBe('sem_vinculo');
    expect(estadoDaFotoNoBling({ ...base, blingId: null, gerenciada: true, desejado: A })).toBe('sem_vinculo');
  });

  it('foto ou confirmação sem o campo de autoridade (leitura antiga) já provam a adoção', () => {
    expect(imagemGerenciadaPeloOrbita({ gerenciada: undefined, desejado: A, confirmado: null })).toBe(true);
    expect(imagemGerenciadaPeloOrbita({ gerenciada: undefined, desejado: null, confirmado: A })).toBe(true);
    expect(estadoDaFotoNoBling({ ...base, gerenciada: undefined, desejado: A })).toBe('pendente');
  });
});
