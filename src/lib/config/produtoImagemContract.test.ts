import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACCEPT_DE_IMAGEM,
  BUCKET_PRODUTO_IMAGENS,
  TAMANHO_MAXIMO_DA_IMAGEM,
  caminhoDaImagem,
  caminhoPertenceAoProduto,
  problemaDoArquivo,
  tipoDoCaminho,
} from './produtoImagemContract';

const ORG = '11111111-1111-4111-8111-111111111111';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const OBJ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('contrato da foto do produto', () => {
  it('bucket privado, JPEG/PNG/WebP, 5 MB', () => {
    expect(BUCKET_PRODUTO_IMAGENS).toBe('produto-imagens');
    expect(TAMANHO_MAXIMO_DA_IMAGEM).toBe(5 * 1024 * 1024);
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
