/**
 * Ticket 30, fatia 3 — 8ª rodada de revisão.
 *
 * A rota de reconciliação pela ROTA REAL, com `supabaseServer` e o cliente do
 * Bling dublados. Três coisas que só se provam aqui:
 *
 * 1. **Autorização.** `resolveVerifiedOrganizationScope` prova vínculo e
 *    papel, mas provar vínculo não é autorizar ação. Quem não administra a
 *    organização não pode disparar efeito no ERP nem override nenhum — e a
 *    recusa tem de acontecer ANTES de qualquer leitura de ledger, claim ou
 *    chamada ao provedor.
 * 2. **A quebra UI × rota.** O schema aceitava só `conferir` e
 *    `cancelar-no-bling`, então `encerrar-como-nao-criada` morria em `400`
 *    antes de chegar à máquina de reconciliação.
 * 3. **O override não aprovado.** Encerrar uma tentativa que a API não
 *    conseguiu provar inexistente é decisão de produto da proprietária, e ela
 *    não foi tomada — a ação é reconhecida e recusada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const REFERENCIA = '55555555-5555-4555-8555-555555555555';

/** Papel do escopo verificado, trocado por teste. */
let papel: 'owner' | 'admin' | 'member' = 'owner';

vi.mock('@/lib/requestOrganizationContext', async () => {
  const real = await vi.importActual<typeof import('@/lib/requestOrganizationContext')>(
    '@/lib/requestOrganizationContext',
  );
  return {
    // `escopoTemCapacidade` vem do módulo REAL de propósito: é a autoridade de
    // capacidade do projeto, e dublá-la esvaziaria o teste.
    escopoTemCapacidade: real.escopoTemCapacidade,
    resolveVerifiedOrganizationScope: vi.fn(async () => ({
      _tag: 'RequestScopeResolved' as const,
      scope: { organizationId: ORG_ID, actorId: ACTOR_ID, role: papel },
    })),
  };
});

const rpcsChamadas: string[] = [];
const cancelamentosNoBling: string[] = [];
/** Estado da tentativa lida pela rota; `null` simula "não existe nesta organização". */
let tentativaArmazenada: Record<string, unknown> | null = null;

vi.mock('@/lib/supabaseServer', () => ({
  supabaseServer: {
    rpc: (nome: string) => {
      rpcsChamadas.push(nome);
      if (nome === 'assumir_tentativa_para_reconciliacao') return Promise.resolve({ data: 2, error: null });
      if (nome === 'reivindicar_intervencao_venda_manual') return Promise.resolve({ data: 'intervencao-1', error: null });
      if (nome === 'resolver_intervencao_ambigua') return Promise.resolve({ data: 'resolucao-1', error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: (tabela: string) => {
      // `pedidos` (findVendaManualJaRegistrada) encadeia três `eq`;
      // `tentativas_venda_manual` encadeia dois. Um encadeamento que responde
      // a ambos evita um dublê por tabela.
      const encadeavel: Record<string, unknown> = {
        maybeSingle: () => Promise.resolve({
          data: tabela === 'tentativas_venda_manual' ? tentativaArmazenada : null,
          error: null,
        }),
      };
      encadeavel.eq = () => encadeavel;
      encadeavel.select = () => encadeavel;
      return encadeavel;
    },
  },
}));

vi.mock('@/services/bling', () => ({
  bling: {
    forVerifiedOrganization: () => ({
      buscarPedidoVendaPorNumeroLoja: () => Promise.resolve({
        _tag: 'BlingOk',
        value: {
          _tag: 'UmPedido',
          pedido: { id: '918273', numeroLoja: `ORBITA-${REFERENCIA}`, situacao: 'Em aberto' },
        },
      }),
      cancelarPedidoVenda: (id: string) => {
        cancelamentosNoBling.push(id);
        return Promise.resolve({ _tag: 'BlingOk', value: undefined });
      },
    }),
  },
}));

function requisicao(corpo: Record<string, unknown>) {
  return new Request('https://orbita.test/api/pedidos/manual/reconciliar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

/** Uma tentativa indeterminada, velha o bastante para ser reconciliável. */
function tentativaIndeterminada() {
  return {
    id: 'tentativa-1',
    estado: 'indeterminada',
    pedido_id: null,
    bling_pedido_id: null,
    updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    epoca: 1,
  };
}

describe('POST /api/pedidos/manual/reconciliar — autorização e ações (rota real)', () => {
  beforeEach(() => {
    rpcsChamadas.length = 0;
    cancelamentosNoBling.length = 0;
    papel = 'owner';
    tentativaArmazenada = tentativaIndeterminada();
  });

  describe('autorização por capacidade, nunca pelo corpo', () => {
    it('member NÃO pode cancelar no Bling: 403, sem claim e sem escrita no ERP', async () => {
      papel = 'member';
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'cancelar-no-bling' }));

      expect(resposta.status).toBe(403);
      // A recusa acontece ANTES de qualquer efeito: nenhuma RPC de claim,
      // nenhuma chamada ao Bling — e nem sequer a leitura do ledger.
      expect(rpcsChamadas).toEqual([]);
      expect(cancelamentosNoBling).toEqual([]);
    });

    it.each([['owner' as const], ['admin' as const]])('%s pode cancelar no Bling', async (papelDoTeste) => {
      papel = papelDoTeste;
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'cancelar-no-bling' }));

      expect(resposta.status).toBe(200);
      expect(cancelamentosNoBling).toEqual(['918273']);
      expect(rpcsChamadas).toContain('reivindicar_intervencao_venda_manual');
    });

    it('member PODE conferir — leitura não exige gestão', async () => {
      papel = 'member';
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'conferir' }));

      expect(resposta.status).not.toBe(403);
      // E conferir nunca escreve no ERP.
      expect(cancelamentosNoBling).toEqual([]);
    });

    it('a organização vem do escopo verificado — um id no corpo não muda nada', async () => {
      papel = 'member';
      const { POST } = await import('./route');

      const resposta = await POST(
        requisicao({
          referenciaLocal: REFERENCIA,
          acao: 'cancelar-no-bling',
          organizacaoId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          role: 'owner',
        }),
      );

      // O corpo tenta se promover a owner de outra organização e não consegue:
      // o papel vem do vínculo persistido.
      expect(resposta.status).toBe(403);
      expect(cancelamentosNoBling).toEqual([]);
    });

    it('tentativa de outra organização é indistinguível de inexistente', async () => {
      tentativaArmazenada = null;
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'conferir' }));

      expect(resposta.status).toBe(404);
    });
  });

  describe('encerrar-como-nao-criada: reconhecida pela rota, e recusada por decisão de produto', () => {
    it('a ação ATRAVESSA o schema — não morre mais em 400 de validação', async () => {
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'encerrar-como-nao-criada' }));
      const corpo = await resposta.json();

      // Com o schema anterior (`conferir | cancelar-no-bling`) isto seria 400
      // "Referência da venda inválida" — a UI já mandava a ação e a rota a
      // rejeitava antes de qualquer lógica.
      expect(resposta.status).not.toBe(400);
      expect(corpo.error).not.toContain('inválida');
    });

    it('mas NÃO executa: depende de decisão da proprietária', async () => {
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'encerrar-como-nao-criada' }));
      const corpo = await resposta.json();

      expect(resposta.status).toBe(403);
      expect(corpo.error).toContain('decisão da proprietária');
      // E nada foi gravado nem liberado.
      expect(rpcsChamadas).toEqual([]);
    });

    it('member também não passa — o override exigiria gestão de qualquer forma', async () => {
      papel = 'member';
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'encerrar-como-nao-criada' }));

      expect(resposta.status).toBe(403);
      expect(rpcsChamadas).toEqual([]);
    });
  });

  /**
   * 9ª rodada de revisão. A 8ª autorizava pelo NOME da ação: `conferir` era
   * "leitura" porque se chama assim. Só que ela tomava posse da tentativa e
   * escrevia no ledger — então um `member` com apenas `organization:access`
   * conseguia CERCAR um executor legítimo e mudar o desfecho de uma venda.
   */
  describe('B5 — autorização pelo EFEITO, não pelo nome da ação', () => {
    it('member conferindo uma tentativa EM ANDAMENTO é recusado: tomar posse é efeito', async () => {
      papel = 'member';
      tentativaArmazenada = { ...tentativaIndeterminada(), estado: 'em_andamento' };
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'conferir' }));

      expect(resposta.status).toBe(403);
      // O que prova o cerco impedido: a época NÃO foi avançada.
      expect(rpcsChamadas).not.toContain('assumir_tentativa_para_reconciliacao');
    });

    it('owner conferindo a MESMA tentativa assume normalmente — a diferença é a capacidade', async () => {
      papel = 'owner';
      tentativaArmazenada = { ...tentativaIndeterminada(), estado: 'em_andamento' };
      const { POST } = await import('./route');

      await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'conferir' }));

      expect(rpcsChamadas).toContain('assumir_tentativa_para_reconciliacao');
    });

    it('member conferindo uma indeterminada inspeciona, mas não escreve no ledger', async () => {
      papel = 'member';
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'conferir' }));
      const corpo = await resposta.json();

      expect(resposta.status).not.toBe(403);
      expect(rpcsChamadas).not.toContain('concluir_tentativa_venda_manual');
      expect(corpo.referenciaLiberada).toBe(false);
    });
  });

  /** 9ª rodada — B3: a ambiguidade deixa de ser um beco sem saída. */
  describe('B3 — resolver-ambiguidade', () => {
    it('member não pode: registrar a decisão muda o estado da venda', async () => {
      papel = 'member';
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({
        referenciaLocal: REFERENCIA,
        acao: 'resolver-ambiguidade',
        decisao: 'cancelado',
        evidencia: 'Conferido no Bling.',
      }));

      expect(resposta.status).toBe(403);
      expect(rpcsChamadas).toEqual([]);
    });

    it('sem decisão e evidência, nada é registrado', async () => {
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({ referenciaLocal: REFERENCIA, acao: 'resolver-ambiguidade' }));

      expect(resposta.status).toBe(400);
      expect(rpcsChamadas).toEqual([]);
    });

    it('com gestão, decisão e evidência: registra e NÃO repete o cancelamento no Bling', async () => {
      const { POST } = await import('./route');

      const resposta = await POST(requisicao({
        referenciaLocal: REFERENCIA,
        acao: 'resolver-ambiguidade',
        decisao: 'cancelado',
        evidencia: 'Pedido 918273 aparece como Cancelado no Bling.',
      }));
      const corpo = await resposta.json();

      expect(resposta.status).toBe(200);
      expect(corpo.referenciaLiberada).toBe(true);
      expect(rpcsChamadas).toContain('resolver_intervencao_ambigua');
      // O ponto do B3: a saída é uma DECISÃO registrada, não a repetição do PATCH.
      expect(cancelamentosNoBling).toEqual([]);
    });
  });
});
