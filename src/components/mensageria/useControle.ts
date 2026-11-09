'use client';

/**
 * Quem responde a conversa aberta (MSG-009): lê o controle e pede as mudanças.
 *
 * A regra é do servidor. Esta tela só mostra o estado que ele devolveu e manda
 * a versão que viu: se outra aba ou pessoa mudou antes, o servidor responde
 * conflito com o estado atual, e é ele que aparece. Cada clique é um comando
 * novo; repetir depois de uma resposta perdida devolve conflito e o estado real.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';

export type ModoDoAtendimento = 'AI' | 'HUMAN_REQUIRED' | 'HUMAN';
export type AcaoDoAtendimento = 'assumir' | 'devolver' | 'exigir_humano';

export interface ControleVisto {
  readonly modo: ModoDoAtendimento;
  readonly responsavelId: string | null;
  readonly souResponsavel: boolean;
  readonly versao: number;
}

/** O estado guardado leva a conversa de onde veio: o de outra conversa não aparece. */
interface EstadoCarimbado {
  readonly conversa: string | null;
  readonly controle: ControleVisto | null;
  readonly agindo: boolean;
  /** Erro de leitura ou de ação: nada mudou. */
  readonly erro: string | null;
  /** O que a última mudança causou (respostas canceladas ou já em voo). */
  readonly aviso: string | null;
}

const MODOS: readonly ModoDoAtendimento[] = ['AI', 'HUMAN_REQUIRED', 'HUMAN'];
const ERRO_DE_LEITURA = 'Não foi possível ler quem atende esta conversa.';

function controleValido(valor: unknown): ControleVisto | null {
  const c = valor as Partial<ControleVisto> | null;
  if (!c || !MODOS.includes(c.modo as ModoDoAtendimento) || typeof c.versao !== 'number' || typeof c.souResponsavel !== 'boolean') {
    return null;
  }
  return { modo: c.modo as ModoDoAtendimento, responsavelId: c.responsavelId ?? null, souResponsavel: c.souResponsavel, versao: c.versao };
}

function plural(n: number, um: string, varios: string): string {
  return n === 1 ? um : varios.replace('#', String(n));
}

function avisoDaMudanca(invalidados: number, emVoo: number): string | null {
  const partes: string[] = [];
  if (invalidados > 0) {
    partes.push(plural(invalidados, '1 resposta na fila foi cancelada.', '# respostas na fila foram canceladas.'));
  }
  if (emVoo > 0) {
    partes.push(plural(emVoo, '1 resposta já estava sendo enviada e pode chegar à cliente.',
      '# respostas já estavam sendo enviadas e podem chegar à cliente.'));
  }
  return partes.length > 0 ? partes.join(' ') : null;
}

function vazio(conversa: string | null): EstadoCarimbado {
  return { conversa, controle: null, agindo: false, erro: null, aviso: null };
}

/** Parte do estado guardado se ele é desta conversa; senão, do zero. */
function daConversa(anterior: EstadoCarimbado, conversa: string): EstadoCarimbado {
  return anterior.conversa === conversa ? anterior : vazio(conversa);
}

export function useControle(fetchWithAuth: AuthenticatedFetch, conversaId: string | null) {
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
    let controle: ControleVisto | null = null;
    try {
      const resposta = await fetchWithAuth(`/api/chatwoot/controle?conversaId=${alvo}`);
      const corpo = await resposta.json().catch(() => null);
      controle = resposta.ok ? controleValido(corpo?.controle) : null;
    } catch {
      controle = null;
    }
    if (atual.current !== alvo) return;
    setGuardado((anterior) => {
      const base = daConversa(anterior, alvo);
      return { ...base, controle: controle ?? base.controle, erro: controle ? null : ERRO_DE_LEITURA };
    });
  }, [conversaId, fetchWithAuth]);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  const versaoVista = estado.controle?.versao;
  const agir = useCallback(async (acao: AcaoDoAtendimento, nota?: string): Promise<boolean> => {
    const alvo = conversaId;
    if (alvo === null || versaoVista === undefined) return false;
    setGuardado((anterior) => ({ ...daConversa(anterior, alvo), agindo: true, erro: null, aviso: null }));
    try {
      const resposta = await fetchWithAuth('/api/chatwoot/controle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversaId: alvo, commandId: crypto.randomUUID(), acao, versaoEsperada: versaoVista, ...(nota ? { nota } : {}) }),
      });
      const corpo = await resposta.json().catch(() => null);
      if (atual.current !== alvo) return false;
      const controle = controleValido(corpo?.controle);
      const aplicado = resposta.ok && corpo?.success === true && controle !== null;
      setGuardado((anterior) => {
        const base = daConversa(anterior, alvo);
        if (aplicado) {
          return { ...base, agindo: false, controle, aviso: avisoDaMudanca(Number(corpo.invalidados) || 0, Number(corpo.emVoo) || 0) };
        }
        return {
          ...base,
          agindo: false,
          controle: controle ?? base.controle,
          erro: typeof corpo?.error === 'string' ? corpo.error : 'Não foi possível mudar o atendimento. Nada foi alterado.',
        };
      });
      return aplicado;
    } catch {
      // Sem resposta: não se sabe se mudou. Ler de novo mostra o estado real.
      if (atual.current === alvo) {
        setGuardado((anterior) => ({
          ...daConversa(anterior, alvo), agindo: false, erro: 'Sem resposta do servidor. Confira o estado antes de agir de novo.',
        }));
        void recarregar();
      }
      return false;
    }
  }, [conversaId, fetchWithAuth, recarregar, versaoVista]);

  return {
    controle: estado.controle,
    carregando: estado.controle === null && estado.erro === null,
    agindo: estado.agindo,
    erro: estado.erro,
    aviso: estado.aviso,
    agir,
    recarregar,
  };
}
