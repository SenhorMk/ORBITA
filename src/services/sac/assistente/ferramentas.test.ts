import { describe, expect, it, vi } from 'vitest';
import { executarConsultas, selecionarLinhas } from './ferramentas';
import { CONHECIMENTO_PORTAL_DO_HAUX } from './conhecimento';
import type { ItemDoCatalogo } from './catalogo';

const CATALOGO: ItemDoCatalogo[] = [
  { nome: 'Defumador - Limpeza e descarrego', categoria: 'Defumador', preco: 40, disponivel: true },
  { nome: 'Kuripe Cobra', categoria: 'Kuripe', preco: 80, disponivel: true },
];
const ok = async () => CATALOGO;

describe('ferramentas do assistente do cliente (somente leitura)', () => {
  it('saudação: só o catálogo (sem itens), sem linhas nem políticas', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, ['Olá, tudo bem?']);
    expect(r.resultados.map((x) => x.ferramenta)).toEqual(['consultar_catalogo']);
    expect(r.itensCitaveis).toEqual([]);
  });

  it('"quais defumadores vocês têm?": catálogo com o defumador do ERP e as quatro linhas da marca', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, ['Quais defumadores vocês têm?']);
    expect(r.resultados.map((x) => x.ferramenta)).toEqual(['consultar_catalogo', 'consultar_linhas']);
    expect(r.itensCitaveis.map((i) => i.nome)).toEqual(['Defumador - Limpeza e descarrego']);
    const linhas = r.resultados[1].conteudo;
    for (const nome of ['Portal de Luz', 'Portal de Purificação', 'Portal de Harmonia', 'Portal do Guardião']) expect(linhas).toContain(nome);
    expect(linhas).toContain('composição provisória');
  });

  it('"quanto custam?" depois de falar de defumadores: o histórico mantém o assunto', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, ['Quais defumadores vocês têm?', 'Quanto custam?']);
    expect(r.itensCitaveis.map((i) => i.nome)).toContain('Defumador - Limpeza e descarrego');
  });

  it('necessidade sem citar produto ("harmonizar o ambiente") seleciona as linhas', () => {
    expect(selecionarLinhas(CONHECIMENTO_PORTAL_DO_HAUX, ['Qual você recomenda para harmonizar o ambiente?']).length).toBe(4);
    expect(selecionarLinhas(CONHECIMENTO_PORTAL_DO_HAUX, ['Oi, bom dia'])).toEqual([]);
  });

  it('catálogo indisponível falha isolado: linhas continuam e nenhum preço é citável', async () => {
    const falha = vi.fn(async () => { throw new Error('rede'); });
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, falha, ['qual defumador vc indica?']);
    expect(r.resultados[0]).toMatchObject({ ferramenta: 'consultar_catalogo', ok: false });
    expect(r.resultados.map((x) => x.ferramenta)).toContain('consultar_linhas');
    expect(r.itensCitaveis).toEqual([]);
  });

  it('pergunta de troca ou frete consulta as políticas (não informadas)', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, ['Qual o prazo de entrega e como faço uma troca?']);
    const politica = r.resultados.find((x) => x.ferramenta === 'consultar_politica_comercial');
    expect(politica?.conteudo).toContain('frete e entrega: NÃO INFORMADA');
  });
});

describe('produto sem cadastro no ERP não herda preço de outro item', () => {
  it('as linhas sem item correspondente no ERP vêm marcadas, com aviso ao modelo', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, ['Qual você recomenda para harmonizar o ambiente?']);
    expect(r.nomesSemCadastro).toEqual(['Portal de Luz', 'Portal de Purificação', 'Portal de Harmonia', 'Portal do Guardião']);
    expect(r.resultados.find((x) => x.ferramenta === 'consultar_linhas')?.conteudo).toContain('NÃO estão cadastradas no ERP');
  });
});
