import { describe, expect, it } from 'vitest';
import { validarResposta } from './validacao';
import { descreverCatalogo, montarCatalogo, type ItemDoCatalogo } from './catalogo';
import { executarConsultas } from './ferramentas';
import { CONHECIMENTO_PORTAL_DO_HAUX } from './conhecimento';
import { semLinhasRepetidas, semSaudacaoRepetida } from '../respostaAutomaticaHaux';

const HARMONIA: ItemDoCatalogo = { nome: 'Defumador Líquido - Portal da Harmonia', categoria: 'Defumador', preco: 40, disponivel: true };
const COBRA: ItemDoCatalogo = { nome: 'Kuripe Cobra', categoria: 'Kuripe', preco: 80, disponivel: true };
const FLORAL_SEM_ESTOQUE: ItemDoCatalogo = { nome: 'Kuripe Floral', categoria: 'Kuripe', preco: 100, disponivel: false };
const SEM_PRECO: ItemDoCatalogo = { nome: 'Kuripe Grande Verde', categoria: 'Kuripe', preco: null, disponivel: true };
const CATALOGO = [HARMONIA, COBRA, FLORAL_SEM_ESTOQUE, SEM_PRECO];
const LINHAS_SEM_CADASTRO = ['Portal do Guardião'];
const validar = (texto: string) => validarResposta(texto, CATALOGO, LINHAS_SEM_CADASTRO);

describe('afirmações comerciais só com fonte verificada', () => {
  it('1. preço correto associado ao produto exato; preço de outro item é recusado', () => {
    expect(validar('O Defumador Líquido - Portal da Harmonia custa R$ 40,00.')).toBeNull();
    expect(validar('O Kuripe Cobra custa R$ 80,00.')).toBeNull();
    expect(validar('O Kuripe Cobra custa R$ 40,00.')).toBe('preco_sem_produto');
    // Texto real do Groq recusado antes: nome na 1ª frase, preço na 3ª.
    expect(validar('Para harmonizar o ambiente, recomendo o Defumador Líquido - Portal da Harmonia. Ele oferece aroma fresco, herbal, levemente cítrico e floral. O preço é R$ 40,00 e está disponível no ERP.')).toBeNull();
  });

  it('2. produto existente sem preço confirmado: aparece como "preço não cadastrado" e não aceita valor', () => {
    const itens = montarCatalogo([{ nome: 'Kuripe Grande Verde', preco: null, estoque: 2, estoque_reservado: 0, situacao: 'ativo', arquivado_em: null }],
      CONHECIMENTO_PORTAL_DO_HAUX);
    expect(itens).toEqual([{ nome: 'Kuripe Grande Verde', categoria: null, preco: null, disponivel: true }]);
    expect(descreverCatalogo(itens, itens)).toContain('Kuripe Grande Verde | sem categoria | preço não cadastrado | disponível');
    expect(validar('O Kuripe Grande Verde custa R$ 100,00.')).not.toBeNull();
    expect(validar('O Kuripe Grande Verde ainda não tem preço cadastrado.')).toBeNull();
  });

  it('3. linha conhecida sem produto cadastrado: sem preço nem estoque atribuídos', () => {
    expect(validar('O Portal do Guardião custa R$ 40,00.')).not.toBeNull();
    expect(validar('O Portal do Guardião está disponível.')).toBe('preco_de_produto_sem_cadastro');
    expect(validar('O Portal do Guardião ainda não está cadastrado no catálogo.')).toBeNull();
  });

  it.each([
    'Ele está em estoque e pronto para envio.',
    'Temos pronta-entrega.',
    'Despachamos hoje mesmo!',
    'Chega em 3 dias úteis.',
    'Garantimos a disponibilidade para você.',
  ])('4. estoque positivo não vira promessa de envio: %s', (texto) => {
    expect(validar(`O Defumador Líquido - Portal da Harmonia está disponível. ${texto}`)).toBe('promessa_de_envio');
  });

  it('4. estoque positivo dito sem promessa é aceito', () => {
    expect(validar('O Defumador Líquido - Portal da Harmonia está disponível no estoque.')).toBeNull();
  });

  it('5. produto indisponível não é apresentado como disponível', () => {
    expect(validar('O Kuripe Floral está disponível.')).toBe('indisponivel_como_disponivel');
    expect(validar('O Kuripe Floral está sem estoque no momento.')).toBeNull();
  });

  it('6. histórico com mudança de assunto: a mensagem atual define os itens principais', async () => {
    const r = await executarConsultas(CONHECIMENTO_PORTAL_DO_HAUX, async () => CATALOGO, ['Quais defumadores vocês têm?', 'e kuripe, tem?']);
    expect(r.itensCitaveis[0].categoria).toBe('Kuripe');
    expect(r.itensCitaveis.map((i) => i.nome)).toContain('Kuripe Cobra');
  });

  it.each([
    'O Portal da Harmonia alivia a ansiedade.',
    'Esse defumador cura a insônia.',
    'Resultado garantido na primeira aplicação.',
    'Tem efeito terapêutico comprovado.',
  ])('7. recomendação sem benefício inventado: %s', (texto) => {
    expect(validar(texto)).toBe('beneficio_inventado');
  });

  it('7. descrição simbólica da marca e ressalva negativa são aceitas', () => {
    expect(validar('O Portal da Harmonia tem aroma fresco e herbal, pensado para serenidade e equilíbrio.')).toBeNull();
    expect(validar('Não prometemos efeito terapêutico.')).toBeNull();
  });
});

describe('naturalidade em conversa em andamento', () => {
  it('tira a saudação de abertura repetida, sem perder o conteúdo', () => {
    expect(semSaudacaoRepetida('Olá! Temos o Kuripe Cobra.')).toBe('Temos o Kuripe Cobra.');
    expect(semSaudacaoRepetida('Boa noite, o Kuripe Cobra custa R$ 80,00.')).toBe('O Kuripe Cobra custa R$ 80,00.');
    expect(semSaudacaoRepetida('Temos o Kuripe Cobra.')).toBe('Temos o Kuripe Cobra.');
    expect(semSaudacaoRepetida('Olá!')).toBe('Olá!');
  });

  it('item listado duas vezes aparece uma vez (visto no widget, conversa 24)', () => {
    const texto = 'Temos:\n- Defumador Líquido – Portal da Harmonia: R$ 40,00, disponível\n'
      + '- Defumador Líquido – Portal da Purificação: R$ 40,00, disponível\n'
      + '- Defumador Líquido – Portal da Harmonia: R$ 40,00, disponível\nRecomendo o Portal da Harmonia.';
    expect(semLinhasRepetidas(texto).match(/Portal da Harmonia: R\$/gu)).toHaveLength(1);
    expect(semLinhasRepetidas(texto)).toContain('Recomendo o Portal da Harmonia.');
  });
});
