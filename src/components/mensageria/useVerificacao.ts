'use client';

/**
 * Quem é a pessoa da conversa aberta (MSG-010): lê a verificação, pede a
 * confirmação ou a revogação e, só com cliente confirmado, lê os pedidos dele.
 *
 * A regra é do servidor. A tela valida o que recebe pelo contrato e, diante de
 * qualquer resposta que não entenda, não mostra candidato nem pedido.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import {
  RespostaDaVerificacaoSchema,
  RespostaDosPedidosSchema,
  type Candidato,
  type PedidoDoCliente,
  type Verificacao,
} from '@/lib/integrations/contratoDaVerificacao';

/** O estado guardado leva a conversa de onde veio: o de outra conversa não aparece. */
interface EstadoCarimbado {
  readonly conversa: string | null;
  readonly verificacao: Verificacao | null;
  readonly candidatos: readonly Candidato[];
  /** `null`: não lidos (sem cliente confirmado ou leitura falhou). */
  readonly pedidos: readonly PedidoDoCliente[] | null;
  readonly busca: { readonly pedidos: readonly PedidoDoCliente[] } | { readonly mensagem: string } | null;
  readonly agindo: boolean;
  readonly erro: string | null;
}

const ERRO_DE_LEITURA = 'Não foi possível ler a verificação do cliente.';
const ERRO_DE_PEDIDOS = 'Não foi possível ler os pedidos deste cliente.';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function vazio(conversa: string | null): EstadoCarimbado {
  return { conversa, verificacao: null, candidatos: [], pedidos: null, busca: null, agindo: false, erro: null };
}

const mensagemDoServidor = (corpo: unknown, padrao: string): string => {
  const erro = (corpo as { error?: unknown } | null)?.error;
  return typeof erro === 'string' ? erro : padrao;
};

async function lerJson(resposta: Response): Promise<unknown> {
  return resposta.json().catch(() => null);
}

export function useVerificacao(fetchWithAuth: AuthenticatedFetch, conversaId: string | null) {
  const [guardado, setGuardado] = useState<EstadoCarimbado>(() => vazio(conversaId));
  // Uma resposta de outra conversa não pode cair nesta.
  const atual = useRef<string | null>(conversaId);
  useEffect(() => {
    atual.current = conversaId;
  }, [conversaId]);

  const estado = guardado.conversa === conversaId ? guardado : vazio(conversaId);

  const recarregar = useCallback(async () => {
    const alvo = conversaId;
    if (alvo === null) return;
    const gravar = (parte: Partial<EstadoCarimbado>) => {
      if (atual.current === alvo) setGuardado({ ...vazio(alvo), ...parte });
    };
    // A prova pode vencer entre a leitura e a consulta: nesse caso o estado é lido mais uma vez.
    for (let tentativa = 0; tentativa < 2; tentativa += 1) {
      let lida;
      try {
        const resposta = await fetchWithAuth(`/api/sac/verificacao?conversaId=${alvo}`);
        lida = resposta.ok ? RespostaDaVerificacaoSchema.safeParse(await lerJson(resposta)) : null;
      } catch {
        lida = null;
      }
      if (atual.current !== alvo) return;
      if (!lida?.success) return gravar({ erro: ERRO_DE_LEITURA });
      const { verificacao, candidatos } = lida.data;
      if (verificacao.estado !== 'verificado') return gravar({ verificacao, candidatos });

      try {
        const resposta = await fetchWithAuth(`/api/sac/pedidos?conversaId=${alvo}`);
        if (resposta.status === 409) continue;
        const pedidos = resposta.ok ? RespostaDosPedidosSchema.safeParse(await lerJson(resposta)) : null;
        return gravar(pedidos?.success
          ? { verificacao, candidatos, pedidos: pedidos.data.pedidos }
          : { verificacao, candidatos, erro: ERRO_DE_PEDIDOS });
      } catch {
        return gravar({ verificacao, candidatos, erro: ERRO_DE_PEDIDOS });
      }
    }
    gravar({ erro: ERRO_DE_LEITURA });
  }, [conversaId, fetchWithAuth]);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  /** Confirmar ou revogar: depois do comando, o estado vem sempre de uma leitura nova. */
  const alterar = useCallback(async (corpo: Record<string, unknown>) => {
    const alvo = conversaId;
    if (alvo === null) return;
    setGuardado((anterior) => ({ ...(anterior.conversa === alvo ? anterior : vazio(alvo)), agindo: true, erro: null, busca: null }));
    let erro: string | null = null;
    try {
      const resposta = await fetchWithAuth('/api/sac/verificacao', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...corpo, conversaId: alvo }),
      });
      if (!resposta.ok) erro = mensagemDoServidor(await lerJson(resposta), 'Não foi possível alterar a verificação. Nada foi alterado.');
    } catch {
      erro = 'Sem resposta do servidor. Confira o estado antes de agir de novo.';
    }
    if (atual.current !== alvo) return;
    if (erro === null) return recarregar();
    setGuardado((anterior) => ({ ...(anterior.conversa === alvo ? anterior : vazio(alvo)), agindo: false, erro }));
  }, [conversaId, fetchWithAuth, recarregar]);

  const confirmar = useCallback((clienteId: string) => alterar({ acao: 'confirmar', clienteId, commandId: crypto.randomUUID() }), [alterar]);
  const revogar = useCallback(() => alterar({ acao: 'revogar' }), [alterar]);

  const localizar = useCallback(async (numero: string) => {
    const alvo = conversaId;
    if (alvo === null) return;
    let busca: EstadoCarimbado['busca'];
    try {
      const resposta = await fetchWithAuth('/api/sac/pedidos', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ conversaId: alvo, numero }),
      });
      const corpo = await lerJson(resposta);
      const pedidos = resposta.ok ? RespostaDosPedidosSchema.safeParse(corpo) : null;
      busca = pedidos?.success ? { pedidos: pedidos.data.pedidos } : { mensagem: mensagemDoServidor(corpo, 'Não foi possível buscar o pedido.') };
    } catch {
      busca = { mensagem: 'Não foi possível buscar o pedido.' };
    }
    if (atual.current !== alvo) return;
    setGuardado((anterior) => (anterior.conversa === alvo ? { ...anterior, busca } : anterior));
  }, [conversaId, fetchWithAuth]);

  return {
    ...estado,
    carregando: estado.verificacao === null && estado.erro === null,
    confirmar,
    revogar,
    localizar,
  };
}
