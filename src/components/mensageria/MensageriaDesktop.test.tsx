/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MensageriaDesktop } from './MensageriaDesktop';
import type { EspelhoDaMensageria } from './espelhoDaMensageria';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { ChatwootConversation, ChatwootMessage } from '@/types';

/**
 * A Mensageria pertence a um tenant, e cada leitura pertence a uma conversa.
 *
 * Estes testes existem para os defeitos que a superfície anterior tinha de
 * verdade, e não para hipóteses: conversas das duas organizações de um membro
 * misturadas na mesma lista, histórico da conversa anterior sob o cabeçalho da
 * nova, resposta atrasada gravando por cima do contexto novo, falha de leitura
 * desenhada como "não há mensagens", mensagem otimista com aparência de
 * entregue, texto do lojista perdido no envio falho e mensagens legítimas
 * repetidas descartadas por uma comparação de conteúdo.
 */

/*
 * O espelho de verdade nunca é usado aqui — todo teste injeta o seu. O dublê do
 * cliente Supabase existe só para o módulo poder ser importado: o singleton de
 * `supabaseClient` lê configuração no topo do arquivo e lança sem ela.
 */
vi.mock('@/lib/supabaseClient', () => ({ supabase: {} }));

const ORG_A: SelecaoDeOrganizacao = { id: 'org-a', versao: 1 };
const ORG_B: SelecaoDeOrganizacao = { id: 'org-b', versao: 2 };

function conversa(id: number, nome: string, status = 'open'): ChatwootConversation {
  return {
    id,
    display_id: id,
    contact_id: id,
    status,
    updated_at: '2026-09-10T12:00:00.000Z',
    contact: { id, name: nome, phone_number: `+551199999${1000 + id}` },
  };
}

function mensagem(id: number, conversationId: number, content: string, criadaEm: string): ChatwootMessage {
  return {
    id,
    conversation_id: conversationId,
    content,
    message_type: 'incoming',
    sender_name: 'Cliente',
    created_at: criadaEm,
  };
}

interface LeituraPendente<T> {
  readonly organizacaoId: string;
  readonly conversaId?: number;
  readonly responder: (valor: T) => void;
  readonly falhar: (mensagem: string) => void;
}

interface Assinatura {
  readonly tipo: 'conversas' | 'mensagens';
  readonly organizacaoId: string;
  readonly conversaId?: number;
  readonly aoInserir?: (mensagem: ChatwootMessage) => void;
  readonly aoEstado: (ativo: boolean) => void;
  ativa: boolean;
}

/**
 * Um espelho que não responde sozinho.
 *
 * Segurar cada leitura em voo é o que permite provar as duas metades do
 * isolamento: que a leitura de A não é **exibida** sob B, e que a resposta
 * atrasada de A não é **gravada** depois da troca.
 */
function criarEspelho() {
  const conversas: LeituraPendente<ChatwootConversation[]>[] = [];
  const mensagens: LeituraPendente<ChatwootMessage[]>[] = [];
  const assinaturas: Assinatura[] = [];

  const espelho: EspelhoDaMensageria = {
    lerConversas: (organizacaoId) =>
      new Promise((resolver, rejeitar) => {
        conversas.push({ organizacaoId, responder: resolver, falhar: (m) => rejeitar(new Error(m)) });
      }),
    lerMensagens: (organizacaoId, conversaId) =>
      new Promise((resolver, rejeitar) => {
        mensagens.push({ organizacaoId, conversaId, responder: resolver, falhar: (m) => rejeitar(new Error(m)) });
      }),
    assinarMensagens: (organizacaoId, conversaId, aoInserir, aoEstado) => {
      const assinatura: Assinatura = { tipo: 'mensagens', organizacaoId, conversaId, aoInserir, aoEstado, ativa: true };
      assinaturas.push(assinatura);
      return () => {
        assinatura.ativa = false;
      };
    },
    assinarConversas: (organizacaoId, _aoMudar, aoEstado) => {
      const assinatura: Assinatura = { tipo: 'conversas', organizacaoId, aoEstado, ativa: true };
      assinaturas.push(assinatura);
      return () => {
        assinatura.ativa = false;
      };
    },
  };

  return { espelho, conversas, mensagens, assinaturas };
}

function respostaJson(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

/** Solta a última leitura pendente de um tipo, dentro de `act`. */
async function responder<T>(fila: LeituraPendente<T>[], valor: T) {
  const pendente = fila[fila.length - 1];
  await act(async () => {
    pendente.responder(valor);
  });
}

function montar(
  espelho: EspelhoDaMensageria,
  selecao: SelecaoDeOrganizacao | null,
  fetchWithAuth: AuthenticatedFetch = vi.fn(),
) {
  const resultado = render(
    <MensageriaDesktop fetchWithAuth={fetchWithAuth} selecao={selecao} espelho={espelho} />,
  );
  const trocar = (nova: SelecaoDeOrganizacao | null) =>
    resultado.rerender(<MensageriaDesktop fetchWithAuth={fetchWithAuth} selecao={nova} espelho={espelho} />);
  return { ...resultado, trocar, fetchWithAuth };
}

/** Abre uma conversa já listada e devolve a leitura de histórico que isso disparou. */
async function abrir(nome: string) {
  await userEvent.click(screen.getByText(nome));
}

describe('MensageriaDesktop — tenant', () => {
  it('lê e assina somente a organização ativa, e mostra só as conversas dela', async () => {
    const { espelho, conversas, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);

    expect(conversas.map((c) => c.organizacaoId)).toEqual(['org-a']);
    await responder(conversas, [conversa(1, 'Ana de A')]);

    expect(screen.getByText('Ana de A')).toBeInTheDocument();
    expect(assinaturas.filter((a) => a.ativa).map((a) => a.organizacaoId)).toEqual(['org-a']);
  });

  it('A → B limpa conversa selecionada, histórico, rascunho e subscriptions no mesmo passo', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    await responder(conversas, [conversa(1, 'Ana de A')]);
    await abrir('Ana de A');
    await responder(mensagens, [mensagem(10, 1, 'Segredo de A', '2026-09-10T12:00:00.000Z')]);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'rascunho de A');

    expect(screen.getByText('Segredo de A')).toBeInTheDocument();
    expect(screen.getByLabelText('Mensagem')).toHaveValue('rascunho de A');

    await act(async () => {
      trocar(ORG_B);
    });

    // Nada de A sobrevive à troca: nem o histórico, nem o cabeçalho da conversa,
    // nem o rascunho — e o compositor nem existe, porque não há seleção em B.
    expect(screen.queryByText('Segredo de A')).not.toBeInTheDocument();
    expect(screen.queryByText('Ana de A')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Mensagem')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma conversa selecionada')).toBeInTheDocument();

    // As subscriptions de A foram desmontadas e as de B criadas no tenant certo.
    expect(assinaturas.filter((a) => a.ativa && a.organizacaoId === 'org-a')).toHaveLength(0);
    expect(assinaturas.filter((a) => a.ativa).map((a) => a.organizacaoId)).toEqual(['org-b']);
    expect(conversas[conversas.length - 1].organizacaoId).toBe('org-b');
  });

  it('resposta atrasada de A não entra em B', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    const leituraDeA = conversas[0];
    await act(async () => {
      trocar(ORG_B);
    });

    // A resposta de A chega depois da troca. Ela não pode ser gravada nem
    // exibida, e também não pode apagar a leitura boa de B.
    await act(async () => {
      leituraDeA.responder([conversa(1, 'Ana de A')]);
    });
    await responder(conversas, [conversa(2, 'Bruno de B')]);

    expect(screen.queryByText('Ana de A')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno de B')).toBeInTheDocument();
    expect(mensagens).toHaveLength(0);
  });

  it('A → B → A não aceita a resposta da primeira visita a A', async () => {
    const { espelho, conversas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    const primeiraVisita = conversas[0];
    await act(async () => {
      trocar(ORG_B);
    });
    await act(async () => {
      trocar({ id: 'org-a', versao: 3 });
    });

    await act(async () => {
      primeiraVisita.responder([conversa(1, 'Ana antiga')]);
    });
    await responder(conversas, [conversa(4, 'Ana atual')]);

    expect(screen.queryByText('Ana antiga')).not.toBeInTheDocument();
    expect(screen.getByText('Ana atual')).toBeInTheDocument();
  });

  it('logout descarta o estado anterior, e o login seguinte começa limpo', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    await responder(conversas, [conversa(1, 'Ana de A')]);
    await abrir('Ana de A');
    await responder(mensagens, [mensagem(10, 1, 'Segredo de A', '2026-09-10T12:00:00.000Z')]);

    await act(async () => {
      trocar(null);
    });

    expect(screen.getByText('Nenhuma organização ativa')).toBeInTheDocument();
    expect(screen.queryByText('Segredo de A')).not.toBeInTheDocument();
    expect(assinaturas.filter((a) => a.ativa)).toHaveLength(0);

    await act(async () => {
      trocar({ id: 'org-a', versao: 5 });
    });
    expect(screen.queryByText('Ana de A')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma conversa selecionada')).toBeInTheDocument();
  });
});

describe('MensageriaDesktop — leitura do histórico', () => {
  it('lê o histórico uma vez por seleção, e não duas', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);

    await abrir('Ana');

    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ organizacaoId: 'org-a', conversaId: 1 });
  });

  it('trocar de conversa some com o histórico anterior antes de o novo chegar', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    await responder(mensagens, [mensagem(10, 1, 'Mensagem da Ana', '2026-09-10T12:00:00.000Z')]);
    expect(screen.getByText('Mensagem da Ana')).toBeInTheDocument();

    await abrir('Bruno');

    expect(screen.queryByText('Mensagem da Ana')).not.toBeInTheDocument();
    expect(screen.getByText('Lendo o histórico desta conversa…')).toBeInTheDocument();
  });

  it('resposta atrasada da conversa 1 não entra na conversa 2', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    const leituraDaAna = mensagens[0];
    await abrir('Bruno');

    await act(async () => {
      leituraDaAna.responder([mensagem(10, 1, 'Mensagem da Ana', '2026-09-10T12:00:00.000Z')]);
    });
    await responder(mensagens, [mensagem(20, 2, 'Mensagem do Bruno', '2026-09-10T12:01:00.000Z')]);

    expect(screen.queryByText('Mensagem da Ana')).not.toBeInTheDocument();
    expect(screen.getByText('Mensagem do Bruno')).toBeInTheDocument();
  });

  it('a subscription de mensagens acompanha a conversa aberta', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    await responder(mensagens, []);
    await abrir('Bruno');

    const vivas = assinaturas.filter((a) => a.ativa && a.tipo === 'mensagens');
    expect(vivas).toHaveLength(1);
    expect(vivas[0]).toMatchObject({ organizacaoId: 'org-a', conversaId: 2 });
  });
});

describe('MensageriaDesktop — estados honestos', () => {
  it('falha de leitura do histórico não vira histórico vazio', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');

    await act(async () => {
      mensagens[0].falhar('Não foi possível ler o histórico: rede indisponível');
    });

    expect(screen.getByText('Não foi possível ler o histórico')).toBeInTheDocument();
    expect(screen.queryByText('Conversa sem mensagens')).not.toBeInTheDocument();
  });

  it('conversa realmente sem mensagens é dita como vazia, e não como erro', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');
    await responder(mensagens, []);

    expect(screen.getByText('Conversa sem mensagens')).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível ler o histórico')).not.toBeInTheDocument();
  });

  it('separa "nenhuma conversa" de "a busca não encontrou nada"', async () => {
    const { espelho, conversas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);
    await responder(conversas, []);
    expect(screen.getByText('Nenhuma conversa nesta organização')).toBeInTheDocument();

    await act(async () => {
      trocar({ id: 'org-a', versao: 2 });
    });
    await responder(conversas, [conversa(1, 'Ana')]);
    await userEvent.type(screen.getByLabelText('Buscar conversa'), 'zzz');

    expect(screen.getByText('Nenhuma conversa encontrada')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma conversa nesta organização')).not.toBeInTheDocument();
  });

  it('só afirma tempo real quando a subscription está confirmada', async () => {
    const { espelho, conversas, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);

    expect(screen.getByText('LISTA SEM TEMPO REAL')).toBeInTheDocument();

    await act(async () => {
      assinaturas.find((a) => a.tipo === 'conversas')!.aoEstado(true);
    });
    expect(screen.getByText('LISTA AO VIVO')).toBeInTheDocument();
  });
});

describe('MensageriaDesktop — envio', () => {
  const CONVERSA = [conversa(1, 'Ana')];

  async function abrirComposer(fetchWithAuth: AuthenticatedFetch) {
    const espelhoDublado = criarEspelho();
    montar(espelhoDublado.espelho, ORG_A, fetchWithAuth);
    await responder(espelhoDublado.conversas, CONVERSA);
    await abrir('Ana');
    await responder(espelhoDublado.mensagens, []);
    return espelhoDublado;
  }

  it('a falha deixa a mensagem não confirmada, o erro visível e o texto recuperável', async () => {
    const fetchWithAuth = vi.fn().mockResolvedValue(
      respostaJson({ success: false, error: 'Falha ao enviar mensagem no Chatwoot (Unauthorized)' }, 502),
    );
    await abrirComposer(fetchWithAuth);

    await userEvent.type(screen.getByLabelText('Mensagem'), 'preciso confirmar o pedido');
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(screen.getByText('Não enviada')).toBeInTheDocument());
    expect(screen.getByText('Falha ao enviar mensagem no Chatwoot (Unauthorized)')).toBeInTheDocument();
    // Não confirmada é o ponto: o texto está na tela, mas nunca como histórico.
    expect(screen.getByText(/Nada foi reenviado automaticamente/)).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Recuperar texto' }));
    expect(screen.getByLabelText('Mensagem')).toHaveValue('preciso confirmar o pedido');
    expect(screen.queryByText('Não enviada')).not.toBeInTheDocument();
  });

  it('o envio bem-sucedido confirma a mensagem uma vez só', async () => {
    const fetchWithAuth = vi.fn().mockResolvedValue(
      respostaJson({ success: true, message: { id: 55, created_at: '2026-09-10T12:05:00.000Z' } }),
    );
    await abrirComposer(fetchWithAuth);

    await userEvent.type(screen.getByLabelText('Mensagem'), 'já está a caminho');
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(screen.queryByText('Enviando…')).not.toBeInTheDocument());
    expect(screen.getAllByText('já está a caminho')).toHaveLength(1);
    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
  });

  it('a indisponibilidade da integração bloqueia o envio e é dita como tal', async () => {
    const fetchWithAuth = vi.fn().mockResolvedValue(
      respostaJson({ success: false, error: 'Integração Chatwoot não configurada' }, 409),
    );
    await abrirComposer(fetchWithAuth);

    await userEvent.type(screen.getByLabelText('Mensagem'), 'alguém aí?');
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(screen.getByText(/Integração Chatwoot indisponível/)).toBeInTheDocument());
    expect(screen.getByLabelText('Mensagem')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Enviar/ })).toBeDisabled();
  });

  it('a falha tardia de A não devolve texto nenhum em B', async () => {
    let responderEnvio: (resposta: Response) => void = () => {};
    const fetchWithAuth = vi.fn().mockImplementation(
      () => new Promise<Response>((resolver) => { responderEnvio = resolver; }),
    );
    const { espelho, conversas, mensagens } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, CONVERSA);
    await abrir('Ana');
    await responder(mensagens, []);

    await userEvent.type(screen.getByLabelText('Mensagem'), 'texto de A');
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await act(async () => {
      trocar(ORG_B);
    });
    await act(async () => {
      responderEnvio(respostaJson({ success: false, error: 'deu ruim' }, 502));
    });
    await responder(conversas, [conversa(9, 'Bruno de B')]);
    await abrir('Bruno de B');
    await responder(mensagens, []);

    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
    expect(screen.queryByText('texto de A')).not.toBeInTheDocument();
    expect(screen.queryByText('deu ruim')).not.toBeInTheDocument();
  });
});

describe('MensageriaDesktop — deduplicação', () => {
  it('mensagens legítimas de mesmo texto e ids distintos aparecem as duas', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');
    await responder(mensagens, [mensagem(10, 1, 'ok', '2026-09-10T12:00:00.000Z')]);

    // Mesmo conteúdo, um segundo depois: a heurística anterior (conteúdo igual
    // dentro de 5 s) descartava esta segunda mensagem para sempre.
    await act(async () => {
      assinaturas
        .find((a) => a.tipo === 'mensagens' && a.ativa)!
        .aoInserir!(mensagem(11, 1, 'ok', '2026-09-10T12:00:01.000Z'));
    });

    expect(screen.getAllByText('ok')).toHaveLength(2);
  });

  it('a mesma mensagem chegando duas vezes pelo id aparece uma vez só', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');
    await responder(mensagens, [mensagem(10, 1, 'bom dia', '2026-09-10T12:00:00.000Z')]);

    await act(async () => {
      assinaturas
        .find((a) => a.tipo === 'mensagens' && a.ativa)!
        .aoInserir!(mensagem(10, 1, 'bom dia', '2026-09-10T12:00:00.000Z'));
    });

    expect(screen.getAllByText('bom dia')).toHaveLength(1);
  });
});

describe('MensageriaDesktop — resolver e reabrir', () => {
  it('a resposta de status altera só a conversa que a iniciou', async () => {
    let responderStatus: (resposta: Response) => void = () => {};
    const fetchWithAuth = vi.fn().mockImplementation(
      () => new Promise<Response>((resolver) => { responderStatus = resolver; }),
    );
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    await responder(mensagens, []);
    await userEvent.click(screen.getByRole('button', { name: 'Marcar resolvida' }));

    await abrir('Bruno');
    await responder(mensagens, []);
    await act(async () => {
      responderStatus(respostaJson({ success: true }));
    });

    // O cabeçalho aberto é o do Bruno, e ele continua aberto.
    const cabecalho = screen.getByRole('heading', { name: 'Bruno' }).closest('header')!;
    expect(within(cabecalho).getByRole('button', { name: 'Marcar resolvida' })).toBeInTheDocument();
  });
});
