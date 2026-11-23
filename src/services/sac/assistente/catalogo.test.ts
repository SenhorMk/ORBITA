import { describe, expect, it, vi } from 'vitest';
import { criarCatalogoComCache, descreverCatalogo, montarCatalogo, selecionarRelevantes, termos, type LinhaDeProduto } from './catalogo';
import { CONHECIMENTO_PORTAL_DO_HAUX, conhecimentoDe } from './conhecimento';
import { descreverPoliticasRecuperadas, recuperarPoliticas } from './politicas';

const linha = (nome: string, preco: number, estoque: number, extra: Partial<LinhaDeProduto> = {}): LinhaDeProduto => ({
  nome, preco, estoque, estoque_reservado: 0, situacao: 'ativo', arquivado_em: null, categoria: null, ...extra,
});

const LINHAS: LinhaDeProduto[] = [
  linha('Defumador - Limpeza e descarrego', 40, 3, { categoria: { descricao: 'Defumador' } }),
  linha('DEMO Defumador de Ervas', 35, 25, { categoria: { descricao: 'Defumador' } }),
  linha('Produto teste', 1000, 3),
  linha('Kuripe Cobra', 80, 1, { categoria: { descricao: 'Kuripe' } }),
  linha('Kuripe Floral', 100, 0),
  linha('Rapé Sansara - 15ml', '40.00' as unknown as number, 10),
  linha('Arquivado', 10, 5, { arquivado_em: '2026-11-01T00:00:00Z' }),
  linha('Inativo', 10, 5, { situacao: 'inativo' }),
  linha('Reservado', 10, 2, { estoque_reservado: 2 }),
];

describe('catálogo verificado do assistente', () => {
  const itens = montarCatalogo(LINHAS, CONHECIMENTO_PORTAL_DO_HAUX);

  it('só itens vendáveis: sem demonstração, teste, arquivados ou inativos', () => {
    expect(itens.map((i) => i.nome)).toEqual(['Defumador - Limpeza e descarrego', 'Kuripe Cobra', 'Kuripe Floral', 'Rapé Sansara - 15ml', 'Reservado']);
  });

  it('disponibilidade descontando o reservado, sem expor a quantidade', () => {
    expect(itens.find((i) => i.nome === 'Reservado')?.disponivel).toBe(false);
    expect(itens.find((i) => i.nome === 'Kuripe Floral')?.disponivel).toBe(false);
    expect(descreverCatalogo(itens, itens)).not.toMatch(/\b(?:3|10) (?:unidades|em estoque)\b/u);
  });

  it('singular simples e acentos: "defumadores" encontra o defumador; saudação não seleciona nada', () => {
    expect(termos('Quanto custam os DEFUMADORES?')).toEqual(['defumador']);
    expect(selecionarRelevantes(itens, 'quanto custam os defumadores?').map((i) => i.nome)).toEqual(['Defumador - Limpeza e descarrego']);
    expect(selecionarRelevantes(itens, 'Oi, bom dia!')).toEqual([]);
    expect(selecionarRelevantes(itens, 'tem kuripe?').map((i) => i.nome)).toEqual(['Kuripe Cobra', 'Kuripe Floral']);
  });

  it('o bloco do modelo traz categorias, preço formatado e o aviso de que estoque não é prazo', () => {
    const bloco = descreverCatalogo(itens, selecionarRelevantes(itens, 'defumador'));
    expect(bloco).toContain('Categorias do catálogo: Defumador, Kuripe.');
    expect(bloco).toContain('Defumador - Limpeza e descarrego | Defumador | R$ 40,00 | disponível');
    expect(bloco).toContain('não significa pronta-entrega');
  });

  it('cache curto: uma leitura por janela, por organização', async () => {
    const lerProdutos = vi.fn(async () => LINHAS);
    const ler = criarCatalogoComCache({ lerProdutos }, CONHECIMENTO_PORTAL_DO_HAUX, 60_000);
    await ler();
    await ler();
    expect(lerProdutos).toHaveBeenCalledTimes(1);
    expect(lerProdutos).toHaveBeenCalledWith(CONHECIMENTO_PORTAL_DO_HAUX.organizacaoId);
  });
});

describe('conhecimento por organização', () => {
  it('organização sem registro não recebe fatos comerciais', () => {
    expect(conhecimentoDe('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('política não confirmada chega ao modelo como NÃO INFORMADA', () => {
    const recuperadas = recuperarPoliticas(CONHECIMENTO_PORTAL_DO_HAUX.organizacaoId, CONHECIMENTO_PORTAL_DO_HAUX.politicas, ['como faço uma troca?']);
    const texto = descreverPoliticasRecuperadas(recuperadas);
    expect(texto).toContain('trocas e devoluções: NÃO INFORMADA');
    expect(texto).not.toMatch(/dias|gr[aá]tis|pix/iu);
  });

  it('política confirmada e vigente vira fato, com o texto aprovado e o registro', () => {
    const confirmada = { ...CONHECIMENTO_PORTAL_DO_HAUX.politicas[0], situacao: 'confirmada' as const,
      texto: 'Aceitamos Pix e cartão de crédito.', fonte: 'FIXTURE DE TESTE', aprovadoPor: 'teste', vigencia: { inicio: '2026-01-01T00:00:00Z', fim: null } };
    const texto = descreverPoliticasRecuperadas(recuperarPoliticas(CONHECIMENTO_PORTAL_DO_HAUX.organizacaoId, [confirmada], ['aceitam pix?']));
    expect(texto).toBe('- formas de pagamento [haux.pagamento v1]: Aceitamos Pix e cartão de crédito. (fonte: FIXTURE DE TESTE)');
  });
});
