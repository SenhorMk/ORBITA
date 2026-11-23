import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { criarModeloHauxPorAiSdk, finalizarRespostaHaux, lerConfiguracaoDeParadaHaux, lerConfiguracaoHaux, mensagemAtual } from './respostaAutomaticaHaux';
import { CONHECIMENTO_PORTAL_DO_HAUX } from './assistente/conhecimento';
import type { ItemDoCatalogo } from './assistente/catalogo';

const DEFUMADOR: ItemDoCatalogo = { nome: 'Defumador - Limpeza e descarrego', categoria: 'Defumador', preco: 40, disponivel: true };
const RAPE: ItemDoCatalogo = { nome: 'Rapé Sansara - 15ml', categoria: null, preco: 40, disponivel: true };
const ID = 'Assistente virtual do Portal do Haux';

type Resultado = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const resultado = (valor: unknown): Resultado => ({
  content: [{ type: 'text', text: JSON.stringify(valor) }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 40, text: 40, reasoning: 0 } },
  warnings: [],
}) as unknown as Resultado;

const entrada = (...textos: string[]) =>
  `<mensagens_do_cliente>\n${textos.map((t, i) => `<mensagem ordem="${i + 1}">${t}</mensagem>`).join('\n')}\n</mensagens_do_cliente>`;

function modeloQueResponde(valor: unknown) {
  const mock = new MockLanguageModelV4({ doGenerate: async () => resultado(valor) });
  const fonte = { conhecimento: CONHECIMENTO_PORTAL_DO_HAUX, catalogo: async () => [DEFUMADOR, RAPE] };
  return { mock, modelo: criarModeloHauxPorAiSdk(mock, 'groq', undefined, fonte) };
}

describe('assistente do Portal do Haux: resposta natural com fatos verificados', () => {
  it('texto natural do modelo sai com a identificação automática, sem frases prontas', () => {
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'Bom dia! Em que posso ajudar?' }, [], ID))
      .toEqual({ acao: 'responder', texto: `${ID}\n\nBom dia! Em que posso ajudar?` });
  });

  it('preço citado precisa existir no catálogo enviado ao modelo', () => {
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'O Defumador - Limpeza e descarrego custa R$ 40,00.' }, [DEFUMADOR], ID)).not.toBeNull();
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'O defumador custa R$ 25,00.' }, [DEFUMADOR], ID)).toBeNull();
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'Custa R$ 40,00.' }, [], ID)).toBeNull();
  });

  it.each(['Me passa seu CPF para eu verificar.', 'Veja em https://loja.exemplo', 'Já cancelei o seu pedido.', 'Seu pedido foi enviado ontem.'])(
    'recusa texto que pede dado sensível, traz link ou afirma ação: %s', (texto) => {
      expect(finalizarRespostaHaux({ acao: 'responder', texto }, [DEFUMADOR], ID)).toBeNull();
    });

  it('preço de outro item atribuído a uma linha sem cadastro é recusado', () => {
    const linhas = ['Portal de Harmonia'];
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'O Portal de Harmonia está disponível por R$ 40,00.' }, [DEFUMADOR], ID, linhas)).toBeNull();
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'Recomendo o Portal de Harmonia, com preço R$ 40,00.' }, [DEFUMADOR], ID, linhas)).toBeNull();
    // Visto no smoke real: o item do ERP renomeado com o nome da linha.
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'Disponíveis: Defumador Líquido – Portal da Harmonia, por R$ 40,00.' }, [DEFUMADOR], ID, linhas)).toBeNull();
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'O defumador custa R$ 40,00.' }, [DEFUMADOR], ID, linhas)).toBeNull();
    expect(finalizarRespostaHaux({ acao: 'responder', texto: 'O Portal de Harmonia ainda não tem preço cadastrado. O Defumador - Limpeza e descarrego custa R$ 40,00.' }, [DEFUMADOR], ID, linhas)).not.toBeNull();
  });

  it('encaminhar continua respondendo a pessoa, com texto acolhedor', () => {
    expect(finalizarRespostaHaux({ acao: 'encaminhar', texto: 'Não tenho essa informação confirmada; vou pedir para a equipe te responder.' }, [], ID))
      .toMatchObject({ acao: 'encaminhar', texto: expect.stringContaining('equipe') });
  });

  it('saída fora do schema não vira resposta', () => {
    expect(finalizarRespostaHaux({ texto: 'sem decisão' }, [], ID)).toBeNull();
    expect(finalizarRespostaHaux({ acao: 'humano', texto: 'x' }, [], ID)).toBeNull();
  });

  it('pergunta de recomendação sem a palavra "defumador" usa o histórico e as linhas da marca', async () => {
    const { mock, modelo } = modeloQueResponde({ acao: 'responder', texto: 'Para energia leve no ambiente, o Portal de Harmonia combina frescor das ervas e suavidade floral.' });
    await modelo.gerar('', entrada('queria saber o preço dos defumadores', 'qual você indica pra deixar o ambiente com uma energia melhor?'), AbortSignal.timeout(1000));
    const prompt = JSON.stringify(mock.doGenerateCalls[0].prompt);
    expect(prompt).toContain('Defumador - Limpeza e descarrego | Defumador | R$ 40,00');
    expect(prompt).toContain('[consultar_linhas]');
    expect(prompt).toContain('Portal de Purificação (DEF 002): limpeza, descarrego e renovação');
  });

  it('pergunta de política traz as políticas como NÃO INFORMADA', async () => {
    const { mock, modelo } = modeloQueResponde({ acao: 'encaminhar', texto: 'Ainda não tenho a política de trocas confirmada; a equipe te orienta.' });
    await modelo.gerar('', entrada('quero devolver um produto'), AbortSignal.timeout(1000));
    expect(JSON.stringify(mock.doGenerateCalls[0].prompt)).toContain('trocas e devoluções: NÃO INFORMADA');
  });

  it('a mensagem atual é a de maior ordem', () => {
    expect(mensagemAtual(entrada('Quero atendente.', 'Quanto custam os defumadores?'))).toBe('Quanto custam os defumadores?');
  });

  it('pergunta de preço chega ao modelo com o catálogo verificado e as políticas não informadas', async () => {
    const { mock, modelo } = modeloQueResponde({ acao: 'responder', texto: 'Temos o Defumador - Limpeza e descarrego por R$ 40,00, disponível.' });
    const saida = await modelo.gerar('', entrada('Quanto custam os defumadores?'), AbortSignal.timeout(1000));
    expect(saida).toEqual({ texto: `${ID}\n\nTemos o Defumador - Limpeza e descarrego por R$ 40,00, disponível.` });
    const prompt = JSON.stringify(mock.doGenerateCalls[0].prompt);
    expect(prompt).toContain('Defumador - Limpeza e descarrego | Defumador | R$ 40,00 | disponível');
    expect(prompt).not.toContain('Rapé Sansara');
    expect(prompt).toContain('[consultar_catalogo]');
    expect(prompt).toContain('Portal de Harmonia (DEF 003)');
  });

  it('preço inventado pelo modelo é recusado e escala (null)', async () => {
    const { modelo } = modeloQueResponde({ acao: 'responder', texto: 'O defumador custa R$ 19,90.' });
    expect(await modelo.gerar('', entrada('Quanto custa o defumador?'), AbortSignal.timeout(1000))).toBeNull();
  });

  it('catálogo indisponível: o modelo é avisado e não recebe preços', async () => {
    const mock = new MockLanguageModelV4({ doGenerate: async () => resultado({ acao: 'encaminhar', texto: 'Não consigo consultar os preços agora; a equipe te responde.' }) });
    const modelo = criarModeloHauxPorAiSdk(mock, 'groq', undefined, {
      conhecimento: CONHECIMENTO_PORTAL_DO_HAUX, catalogo: async () => { throw new Error('rede'); } });
    expect(await modelo.gerar('', entrada('Quanto custa?'), AbortSignal.timeout(1000))).toMatchObject({ texto: expect.stringContaining('equipe') });
    expect(JSON.stringify(mock.doGenerateCalls[0].prompt)).toContain('[consultar_catalogo — FALHOU]');
  });

  it('recusa configuração sem chave, sem expor o valor', () => {
    expect(lerConfiguracaoHaux({})).toMatchObject({ _tag: 'ConfiguracaoInvalida' });
    expect(lerConfiguracaoHaux({ HAUX_BOT_ENABLED: 'false' })).toEqual({ _tag: 'Desligado' });
  });

  it('permite desligar mesmo sem chave do provedor', () => {
    expect(lerConfiguracaoDeParadaHaux({ NEXT_PUBLIC_SUPABASE_URL: 'https://etqjqeqqbjrzyyxodntv.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'ci-test-service-role-not-a-secret',
      CHATWOOT_AI_FIRST_EXECUTOR: 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f' })).toMatchObject({ _tag: 'Configurada' });
  });
});
