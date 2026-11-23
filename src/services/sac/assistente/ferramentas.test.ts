import { describe, expect, it, vi } from 'vitest';
import { assuntoDaResposta, ehEncerramento, executarConsultas, selecionarLinhas } from './ferramentas';
import { CONHECIMENTO_PORTAL_DO_HAUX } from './conhecimento';
import type { ItemDoCatalogo } from './catalogo';

const CATALOGO: ItemDoCatalogo[] = [
  { nome: 'Defumador - Limpeza e descarrego', categoria: 'Defumador', preco: 40, disponivel: true },
  { nome: 'Kuripe Cobra', categoria: 'Kuripe', preco: 80, disponivel: true },
];
const ok = async () => CATALOGO;
const so = (atual: string) => ({ historico: [], atual: [atual] });

describe('ferramentas do assistente do cliente (somente leitura)', () => {
  it('saudação: só o catálogo (sem itens), sem linhas nem políticas', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, so('Olá, tudo bem?'));
    expect(r.resultados.map((x) => x.ferramenta)).toEqual(['consultar_catalogo']);
    expect(r.itensCitaveis).toEqual([]);
  });

  it('"quais defumadores vocês têm?": catálogo com o defumador do ERP e as quatro linhas da marca', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, so('Quais defumadores vocês têm?'));
    expect(r.resultados.map((x) => x.ferramenta)).toEqual(['consultar_catalogo', 'consultar_linhas']);
    expect(r.itensCitaveis.map((i) => i.nome)).toEqual(['Defumador - Limpeza e descarrego']);
    const linhas = r.resultados[1].conteudo;
    for (const nome of ['Portal de Luz', 'Portal de Purificação', 'Portal de Harmonia', 'Portal do Guardião']) expect(linhas).toContain(nome);
    expect(linhas).toContain('composição provisória');
  });

  it('"quanto custam?" depois de falar de defumadores: o histórico mantém o assunto', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, { historico: ['Quais defumadores vocês têm?'], atual: ['Quanto custam?'] });
    expect(r.itensCitaveis.map((i) => i.nome)).toContain('Defumador - Limpeza e descarrego');
  });

  it('necessidade sem citar produto ("harmonizar o ambiente") seleciona as linhas', () => {
    expect(selecionarLinhas(CONHECIMENTO_PORTAL_DO_HAUX, ['Qual você recomenda para harmonizar o ambiente?']).length).toBe(4);
    expect(selecionarLinhas(CONHECIMENTO_PORTAL_DO_HAUX, ['Oi, bom dia'])).toEqual([]);
  });

  it('catálogo indisponível falha isolado: linhas continuam e nenhum preço é citável', async () => {
    const falha = vi.fn(async () => { throw new Error('rede'); });
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, falha, so('qual defumador vc indica?'));
    expect(r.resultados[0]).toMatchObject({ ferramenta: 'consultar_catalogo', ok: false });
    expect(r.resultados.map((x) => x.ferramenta)).toContain('consultar_linhas');
    expect(r.itensCitaveis).toEqual([]);
  });

  it('pergunta de troca ou frete consulta as políticas (não informadas)', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, so('Qual o prazo de entrega e como faço uma troca?'));
    const politica = r.resultados.find((x) => x.ferramenta === 'consultar_politica_comercial');
    expect(politica?.conteudo).toContain('frete e entrega: NÃO INFORMADA');
  });
});

describe('produto sem cadastro no ERP não herda preço de outro item', () => {
  it('as linhas sem item correspondente no ERP vêm marcadas, com aviso ao modelo', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, so('Qual você recomenda para harmonizar o ambiente?'));
    expect(r.nomesSemCadastro).toEqual(['Portal de Luz', 'Portal de Purificação', 'Portal de Harmonia', 'Portal do Guardião']);
    expect(r.resultados.find((x) => x.ferramenta === 'consultar_linhas')?.conteudo).toContain('NÃO estão cadastradas no ERP');
  });

  it('linha cadastrada no ERP com outro artigo ("Portal da Harmonia") não é marcada sem cadastro', async () => {
    const comLinha = async () => [...CATALOGO, { nome: 'Defumador Líquido - Portal da Harmonia', categoria: 'Defumador', preco: 40, disponivel: true }];
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, comLinha, so('Qual você recomenda para harmonizar o ambiente?'));
    expect(r.nomesSemCadastro).not.toContain('Portal de Harmonia');
    expect(r.itensCitaveis.map((i) => i.nome)).toContain('Defumador Líquido - Portal da Harmonia');
  });
});

describe('assunto da resposta: a solicitação atual manda; o histórico só resolve referências', () => {
  it('pergunta com assunto próprio ignora o histórico (troca e retomada de assunto)', () => {
    expect(assuntoDaResposta({ historico: ['quanto custa o defumador?'], atual: ['e kuripe?'] })).toEqual({ busca: ['e kuripe?'], linhas: ['e kuripe?'] });
  });

  it('pergunta só referencial usa apenas a mensagem anterior mais recente com assunto', () => {
    const conversa = { historico: ['tem rapé?', 'e kuripe?', 'obrigado'], atual: ['qual desses é o mais barato?'] };
    expect(assuntoDaResposta(conversa)).toEqual({ busca: ['e kuripe?', 'qual desses é o mais barato?'], linhas: ['e kuripe?'] });
  });

  it('"sim" e "tem disponível?" seguem o assunto anterior; agradecimento não consulta nada', async () => {
    expect(assuntoDaResposta({ historico: ['quero um kuripe'], atual: ['sim'] }).busca).toContain('quero um kuripe');
    expect(assuntoDaResposta({ historico: ['quero um kuripe'], atual: ['Vocês têm disponível?'] }).busca).toContain('quero um kuripe');
    expect(ehEncerramento('Muito obrigada! Valeu')).toBe(true);
    expect(ehEncerramento('Ok, e quanto custa?')).toBe(false);
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, { historico: ['quanto custa o defumador?'], atual: ['obrigado!'] });
    expect(r).toEqual({ resultados: [], itensCitaveis: [], nomesSemCadastro: [], politicas: [] });
  });

  it('política perguntada antes não volta a ser consultada quando o assunto muda', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, ok, { historico: ['qual o prazo de entrega?'], atual: ['tem kuripe?'] });
    expect(r.resultados.map((x) => x.ferramenta)).toEqual(['consultar_catalogo']);
    expect(r.itensCitaveis.map((i) => i.nome)).toEqual(['Kuripe Cobra']);
  });
});
