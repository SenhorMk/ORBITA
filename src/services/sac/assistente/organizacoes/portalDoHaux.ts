import type { ConhecimentoDaOrganizacao } from '../conhecimento';
import type { RegistroDePolitica, SituacaoDaPolitica } from '../politicas';

const ORGANIZACAO = 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f';

/** Registro ainda sem aprovação: sem texto, sem fonte, sem responsável, sem vigência. */
function politica(id: string, tema: string, situacao: Exclude<SituacaoDaPolitica, 'confirmada'>,
  sinonimos: readonly string[], perguntas: readonly string[]): RegistroDePolitica {
  return { id, organizacaoId: ORGANIZACAO, tema, situacao, texto: null, perguntas, sinonimos, fonte: null, versao: 1,
    vigencia: { inicio: null, fim: null }, aprovadoPor: null };
}

/**
 * Base de conhecimento do Portal do Haux consumida pelo assistente.
 * Espelho legível: `docs/ai/organizacoes/portal-do-haux.md`.
 *
 * Fonte das linhas de defumador: "Portal do Haux — Briefing Defumadores
 * Completo" (revisão de 12/10/2026), fichas DEF 001–004, textos "versão do
 * briefing enviado" pelo próprio Portal. O briefing marca composição, medidas
 * e textos técnicos como provisórios: o assistente pode descrever a proposta
 * de cada linha na linguagem da marca, mas não afirma composição final,
 * volume nem efeito terapêutico. Preço e estoque vêm SEMPRE do ERP.
 */
export const CONHECIMENTO_PORTAL_DO_HAUX: ConhecimentoDaOrganizacao = {
  organizacaoId: ORGANIZACAO,
  nomeDaMarca: 'Portal do Haux',
  identificacao: 'Assistente virtual do Portal do Haux',
  tom: 'Acolhedor, respeitoso e direto, em português do Brasil; linguagem ritual e simbólica da marca sem promessas de efeito.',
  linhas: [
    {
      nome: 'Portal de Luz', codigo: 'DEF 001', categoria: 'Defumador de Ambiente',
      sintese: 'elevação, clareza e conexão espiritual',
      perfilAromatico: 'floral, delicado, levemente herbal e luminoso',
      descricao: 'Um encontro entre a delicadeza floral e o frescor das ervas. Fragrância suave e luminosa que convida à elevação, à clareza e à conexão com a luz interior, envolvendo o ambiente em uma atmosfera de acolhimento e inspiração.',
      palavrasChave: ['luz', 'clareza', 'elevação', 'leveza', 'florescimento', 'inspiração', 'acolhimento', 'floral', 'suave', 'delicado', 'espiritual'],
      essencias: 'jasmim e alecrim',
    },
    {
      nome: 'Portal de Purificação', codigo: 'DEF 002', categoria: 'Defumador de Ambiente',
      sintese: 'limpeza, descarrego e renovação',
      perfilAromatico: 'herbal, verde, fresco e marcante',
      descricao: 'Inspirado na força purificadora das ervas, reúne notas herbais frescas e marcantes em uma fragrância que evoca a renovação. Um convite à limpeza energética, ao descarrego e à abertura de caminhos, preparando o ambiente para receber novas energias.',
      palavrasChave: ['purificação', 'purificar', 'limpeza', 'limpar', 'descarrego', 'renovação', 'renovar', 'abertura', 'caminhos', 'fresco', 'herbal', 'energia', 'energias'],
      essencias: 'arruda, eucalipto, alecrim e lavanda',
    },
    {
      nome: 'Portal de Harmonia', codigo: 'DEF 003', categoria: 'Defumador de Ambiente',
      sintese: 'serenidade, equilíbrio e harmonização',
      perfilAromatico: 'fresco, herbal, levemente cítrico e floral',
      descricao: 'Uma combinação delicada entre o frescor das ervas e a suavidade floral. Fragrância acolhedora que convida à serenidade, ao equilíbrio e à tranquilidade, criando uma atmosfera propícia ao descanso, à contemplação e à harmonização das energias.',
      palavrasChave: ['harmonia', 'harmonizar', 'equilíbrio', 'serenidade', 'calma', 'tranquilidade', 'paz', 'descanso', 'relaxar', 'contemplação', 'acolhimento', 'ambiente'],
      essencias: 'capim-limão, lavanda e alecrim',
    },
    {
      nome: 'Portal do Guardião', codigo: 'DEF 004', categoria: 'Defumador de Ambiente',
      sintese: 'proteção, firmeza e força ancestral',
      perfilAromatico: 'quente, intenso, especiado, profundo e envolvente, com nuances amadeiradas',
      descricao: 'Um aroma quente, intenso e envolvente, inspirado na força da proteção e da firmeza espiritual. Notas especiadas e profundas que convidam à presença, à sustentação e ao resguardo energético, evocando a força ancestral do Guardião.',
      palavrasChave: ['guardião', 'proteção', 'proteger', 'firmeza', 'força', 'coragem', 'ancestral', 'ancestralidade', 'resguardo', 'quente', 'intenso', 'amadeirado'],
      essencias: 'cravo, canela, patchouli e lavanda',
    },
  ],
  observacoesDasLinhas: [
    'As quatro linhas são defumadores líquidos de ambiente (borrifar no espaço). Produto de uso ambiental: não ingerir nem aplicar na pele.',
    'Composição, volume e textos técnicos estão marcados como provisórios pela marca; não confirme fórmula final nem volume.',
    'Descrições de proteção, limpeza e harmonização são linguagem ritual e simbólica da marca, não promessa de efeito.',
  ],
  termosDaFamilia: ['defumador', 'defumadores', 'linha', 'linhas', 'portal', 'aroma', 'fragrância', 'ambiente', 'energia', 'recomenda', 'indica', 'indicação', 'diferença'],
  // Situação conforme docs/ai/ASSISTENTE_ORBITA.md §6 (23/11/2026): nenhuma
  // política comercial tem fonte aprovada. Nada aqui pode virar fato até o
  // Portal aprovar o texto, com fonte, responsável e vigência.
  politicas: [
    politica('haux.pagamento', 'formas de pagamento', 'pendente',
      ['pagamento', 'pagar', 'pix', 'boleto', 'cartao', 'credito', 'debito', 'parcel', 'juros', 'a vista', 'aceitam'],
      ['quais formas de pagamento vocês aceitam', 'posso pagar no pix', 'vocês parcelam no cartão']),
    politica('haux.frete', 'frete e entrega', 'pendente',
      ['frete', 'entrega', 'entregam', 'correios', 'sedex', 'pac', 'transportadora', 'retirada', 'gratis'],
      ['quanto custa o frete', 'vocês entregam na minha cidade', 'o frete é grátis']),
    politica('haux.prazo-postagem', 'prazo de preparação e postagem', 'pendente',
      ['prazo', 'postagem', 'postam', 'despach', 'envio', 'enviam', 'quando chega', 'demora'],
      ['qual o prazo de envio', 'em quantos dias vocês postam', 'quando meu pedido chega']),
    politica('haux.trocas', 'trocas e devoluções', 'pendente',
      ['troca', 'trocar', 'devolu', 'devolver', 'arrependimento', 'defeito'],
      ['como faço uma troca', 'posso devolver o produto', 'qual o prazo para troca']),
    politica('haux.cancelamento', 'cancelamento e reembolso', 'pendente',
      ['cancel', 'reembols', 'estorn', 'dinheiro de volta'],
      ['como cancelo meu pedido', 'quero meu dinheiro de volta', 'quando sai o reembolso']),
    politica('haux.promocoes', 'promoções e descontos', 'indisponivel',
      ['promoc', 'desconto', 'cupo', 'liquidacao', 'black friday', 'oferta'],
      ['tem cupom de desconto', 'vocês têm promoção', 'qual o desconto à vista']),
    politica('haux.rastreamento', 'rastreamento de pedidos pelo assistente', 'indisponivel',
      ['rastre', 'codigo de rastreio', 'onde esta meu pedido', 'status do pedido'],
      ['onde está meu pedido', 'me passa o código de rastreio', 'qual o status do meu pedido']),
  ],
  produtosOcultos: [/^\s*demo\b/iu, /\bteste\b/iu, /\bpremium orbita\b/iu],
};
