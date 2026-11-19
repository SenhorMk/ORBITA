import { describe, expect, it } from 'vitest';
import { finalizarRespostaHaux, lerConfiguracaoHaux, lerConfiguracaoDeParadaHaux, avaliarEntradaHaux } from './respostaAutomaticaHaux';

describe('resposta automática do Portal do Haux', () => {
  it('identifica uma resposta natural como atendimento automatizado', () => {
    expect(finalizarRespostaHaux({ acao: 'responder', abertura: 'ola', pergunta: 'como_ajudar' }))
      .toEqual({ texto: 'Atendimento automatizado do Portal do Haux.\n\nOlá! Como posso ajudar você hoje?' });
  });
  it.each([
    'Custa R$ 25 e temos em estoque.', 'Seu pedido foi enviado.',
    'O produto cura ansiedade.', 'A entrega chega amanhã.', 'Pode fazer o pagamento.',
    'Os óleos estão disponíveis e chegam amanhã.', 'Esse banho alivia a depressão.', 'Aceitamos devoluções sem custo.',
  ])('encaminha afirmação comercial ou terapêutica sem fonte: %s', (texto) => {
    expect(finalizarRespostaHaux({ acao: 'responder', abertura: 'ola', pergunta: 'como_ajudar', texto })).toBeNull();
  });
  it('não reativa um pedido antigo de humano depois da devolução e de mensagem nova', () => {
    expect(avaliarEntradaHaux('<mensagens_do_cliente><mensagem ordem="1">Quero atendente humano.</mensagem><mensagem ordem="2">Olá! Boa tarde!</mensagem></mensagens_do_cliente>')).toBe('elegivel');
    expect(avaliarEntradaHaux('<mensagem ordem="2">Quero atendente humano.</mensagem>')).toBe('humano');
  });
  it('encaminha a decisão incerta para humano', () => {
    expect(finalizarRespostaHaux({ acao: 'humano', texto: 'Vou chamar a equipe.' })).toBeNull();
    expect(finalizarRespostaHaux({ texto: 'Sem decisão explícita' })).toBeNull();
  });
  it('recusa modelo falso e configuração sem chave, sem expor o valor', () => {
    expect(lerConfiguracaoHaux({})).toMatchObject({ _tag: 'ConfiguracaoInvalida' });
    expect(lerConfiguracaoHaux({ HAUX_BOT_ENABLED: 'false' })).toEqual({ _tag: 'Desligado' });
  });
  it('permite desligar mesmo sem chave Gemini', () => {
    expect(lerConfiguracaoDeParadaHaux({ NEXT_PUBLIC_SUPABASE_URL: 'https://etqjqeqqbjrzyyxodntv.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'ci-test-service-role-not-a-secret',
      CHATWOOT_AI_FIRST_EXECUTOR: 'c75eb92d-9222-49cc-ac0f-6aebaf8fa69f' })).toMatchObject({ _tag: 'Configurada' });
  });
});
