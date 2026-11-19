import { describe, expect, it, vi } from 'vitest';

import { gerarResposta } from './gerarResposta';
import { modeloDaResposta } from './modeloDaResposta';

const primeira = {
  marca: 'caso-versao-1',
  intencao: 'rastrear_pedido',
  mensagens: [{ conteudo: 'Preciso acompanhar o meu pedido. Meu e-mail é sintese@example.test.', criadaEm: '2026-11-17T10:00:00Z' }],
};

describe('rascunho do atendimento', () => {
  it('usa a mensagem sanitizada e gera texto revisável com o fake explícito', async () => {
    const fake = modeloDaResposta({ SAC_RESPOSTA_PROVEDOR: 'fake' })!;
    const gerar = vi.fn(fake.gerar);
    await expect(gerarResposta(async () => primeira, { ...fake, gerar })).resolves.toMatchObject({
      estado: 'rascunho', provedor: 'fake', texto: expect.stringContaining('pedido'),
    });
    expect(gerar.mock.calls[0]?.[1]).toContain('[EMAIL]');
    expect(gerar.mock.calls[0]?.[1]).not.toContain('sintese@example.test');
  });

  it('descarta resposta cuja versão mudou enquanto o modelo trabalhava', async () => {
    const ler = vi.fn().mockResolvedValueOnce(primeira).mockResolvedValueOnce({ ...primeira, marca: 'caso-versao-2' });
    const gerar = vi.fn(async () => ({ texto: 'Resposta anterior' }));
    expect(await gerarResposta(ler, { provedor: 'fake', gerar })).toEqual({ estado: 'contexto_mudou' });
  });

  it('não envia credenciais ao provedor', async () => {
    const gerar = vi.fn();
    const mensagens = [{ ...primeira.mensagens[0]!, conteudo: 'Minha senha: 123abc456' }];
    expect(await gerarResposta(async () => ({ ...primeira, mensagens }), { provedor: 'fake', gerar }))
      .toEqual({ estado: 'entrada_bloqueada' });
    expect(gerar).not.toHaveBeenCalled();
  });

  it('desliga por padrão e exige autorização explícita para criar o modelo real', () => {
    expect(modeloDaResposta({})).toBeNull();
    expect(modeloDaResposta({
      SAC_RESPOSTA_PROVEDOR: 'google', SAC_RESPOSTA_MODELO: 'gemini-2.5-flash',
      GOOGLE_GENERATIVE_AI_API_KEY: 'fixture-sintetico',
    })).toBeNull();
  });
});
