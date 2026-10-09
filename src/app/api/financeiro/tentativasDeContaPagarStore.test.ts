import { beforeAll, describe, expect, it, vi } from 'vitest';

/** SAFETY: carregado depois do env; o tipo vem do próprio módulo. */
let lerReivindicacao: typeof import('./tentativasDeContaPagarStore').lerReivindicacao;

beforeAll(async () => {
  // O módulo importa o cliente Supabase do servidor, que valida o env ao carregar.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://unit-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'unit-test-service-role-key-000000');
  ({ lerReivindicacao } = await import('./tentativasDeContaPagarStore'));
});

const vazia = {
  tentativa_id: null,
  estado: null,
  epoca: null,
  bling_conta_id: null,
  titulo_id: null,
  contato_bling_id: null,
  chave_pendente: null,
};

describe('lerReivindicacao — a linha da migration 73 decide se o Bling é chamado', () => {
  it('nova e reaberta: a tentativa é de quem chamou, com a época', () => {
    for (const desfecho of ['nova', 'reaberta']) {
      expect(lerReivindicacao({ ...vazia, desfecho, tentativa_id: 't1', estado: 'em_voo', epoca: 2 }))
        .toEqual({ _tag: 'TentativaPropria', tentativaId: 't1', epoca: 2 });
    }
  });

  it('repetida devolve o estado gravado e o que a recuperação precisa', () => {
    expect(lerReivindicacao({
      ...vazia, desfecho: 'repetida', tentativa_id: 't1', estado: 'confirmada', epoca: 1,
      bling_conta_id: '88123', titulo_id: null, contato_bling_id: 7001,
    })).toEqual({
      _tag: 'TentativaRepetida', tentativaId: 't1', estado: 'confirmada',
      blingContaId: '88123', tituloId: null, contatoBlingId: 7001,
    });
  });

  it('conflito e pendência idêntica', () => {
    expect(lerReivindicacao({ ...vazia, desfecho: 'conflito_de_conteudo' })).toEqual({ _tag: 'ConflitoDeConteudo' });
    expect(lerReivindicacao({ ...vazia, desfecho: 'pendencia_identica', chave_pendente: 'c1' }))
      .toEqual({ _tag: 'PendenciaIdentica', chavePendente: 'c1' });
  });

  it.each([
    ['linha ausente', undefined],
    ['desfecho desconhecido', { ...vazia, desfecho: 'outro' }],
    ['nova sem época', { ...vazia, desfecho: 'nova', tentativa_id: 't1', estado: 'em_voo' }],
    ['nova fora de em_voo', { ...vazia, desfecho: 'nova', tentativa_id: 't1', estado: 'confirmada', epoca: 1 }],
    ['repetida nao_enviada (a migration reabre esse caso)', { ...vazia, desfecho: 'repetida', tentativa_id: 't1', estado: 'nao_enviada', epoca: 1 }],
    ['pendência sem chave', { ...vazia, desfecho: 'pendencia_identica' }],
  ])('%s: indisponível — na dúvida, o Bling não é chamado', (_nome, linha) => {
    expect(lerReivindicacao(linha)).toEqual({ _tag: 'TentativaIndisponivel' });
  });
});
