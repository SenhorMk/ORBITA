'use client';

import { useCallback, useEffect, useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import {
  RespostaDaTriagemSchema,
  type ExecucaoDaTriagem,
  type MotivoSemTriagem,
  type RespostaDaTriagem,
  type TriagemV1,
} from '@/lib/integrations/contratoDaTriagem';
import { Aviso } from './Aviso';

const CHIP = { height: 28, fontSize: 11 } as const;
const NOTA = { fontSize: 11, color: 'var(--txt3)' } as const;
const TEXTO = { fontSize: 12, color: 'var(--txt)' } as const;
const ERRO_DE_LEITURA = 'Não foi possível ler a triagem deste caso.';

const INTENCAO: Record<TriagemV1['intencao'], string> = {
  rastrear_pedido: 'Onde está o pedido',
  status_do_pagamento: 'Situação do pagamento',
  troca_ou_devolucao: 'Troca ou devolução',
  produto_com_defeito: 'Produto com defeito',
  produto_errado_ou_faltando: 'Produto errado ou faltando',
  cancelamento: 'Cancelamento',
  duvida_sobre_produto: 'Dúvida sobre produto',
  reclamacao: 'Reclamação',
  elogio_ou_agradecimento: 'Elogio ou agradecimento',
  outro: 'Outro assunto',
};

const SEM_TRIAGEM: Record<MotivoSemTriagem, string> = {
  schema_invalido: 'A IA respondeu fora do formato duas vezes. Leia a conversa.',
  recusa: 'A IA se recusou a classificar esta conversa. Leia a conversa.',
  entrada_bloqueada: 'A mensagem tinha dado sensível (como senha ou chave) ou não tinha texto; não foi enviada à IA.',
  sem_orcamento: 'Limite diário de triagens da organização atingido. Leia a conversa.',
  limite_do_provedor: 'O provedor de IA pediu para esperar. A triagem volta a ser tentada sozinha.',
  timeout: 'A IA demorou demais. A triagem volta a ser tentada sozinha.',
  erro_do_provedor: 'O provedor de IA falhou. A triagem volta a ser tentada sozinha.',
  caso_mudou: 'Chegou mensagem nova durante a triagem; uma nova triagem foi pedida.',
  interrompida: 'A triagem foi interrompida e será refeita.',
};

type Estado = { readonly caso: RespostaDaTriagem['caso'] } | { readonly erro: string };

async function lerTriagem(fetchWithAuth: AuthenticatedFetch, conversaId: string): Promise<Estado> {
  try {
    const resposta = await fetchWithAuth(`/api/sac/triagem?conversaId=${conversaId}`);
    if (!resposta?.ok) return { erro: ERRO_DE_LEITURA };
    const lido = RespostaDaTriagemSchema.safeParse(await resposta.json().catch(() => null));
    return lido.success ? { caso: lido.data.caso } : { erro: ERRO_DE_LEITURA };
  } catch {
    return { erro: ERRO_DE_LEITURA };
  }
}

function Resultado({ triagem, execucao }: { readonly triagem: TriagemV1; readonly execucao: ExecucaoDaTriagem }) {
  return (
    <>
      <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
        <output aria-label="Intenção" style={TEXTO}>{INTENCAO[triagem.intencao]}</output>
        <span style={NOTA}>confiança {triagem.confianca}</span>
        {triagem.numeroDoPedido !== null && <span style={NOTA}>citou o pedido {triagem.numeroDoPedido} (não verificado)</span>}
      </div>
      <span style={TEXTO}>{triagem.motivo}</span>
      {triagem.precisaDeHumano && (
        <Aviso tom="atencao">Precisa de atendimento humano{triagem.motivoDoHumano ? `: ${triagem.motivoDoHumano}` : '.'}</Aviso>
      )}
      {triagem.informacoesFaltando.length > 0 && <span style={NOTA}>Falta saber: {triagem.informacoesFaltando.join('; ')}.</span>}
      {triagem.proximaPergunta !== null && <span style={NOTA}>Pergunta sugerida: “{triagem.proximaPergunta}”</span>}
      <span style={NOTA}>
        Hipótese da IA ({execucao.provedor === 'fake' ? 'modelo falso, sem IA real' : execucao.modelo}). Confira na conversa antes de agir.
      </span>
    </>
  );
}

/**
 * A triagem por IA do caso desta conversa (MSG-013). Só mostra: é hipótese,
 * nunca é enviada à cliente nem muda o caso. Falhas aparecem com o motivo.
 */
export function PainelDaTriagem({ fetchWithAuth, conversaId }: { readonly fetchWithAuth: AuthenticatedFetch; readonly conversaId: string | null }) {
  const [guardado, setGuardado] = useState<{ readonly conversa: string; readonly estado: Estado } | null>(null);
  const [geracao, setGeracao] = useState(0);

  useEffect(() => {
    if (conversaId === null) return undefined;
    let vivo = true;
    void lerTriagem(fetchWithAuth, conversaId).then((estado) => {
      if (vivo) setGuardado({ conversa: conversaId, estado });
    });
    return () => {
      vivo = false;
    };
  }, [fetchWithAuth, conversaId, geracao]);

  const recarregar = useCallback(() => setGeracao((g) => g + 1), []);
  if (conversaId === null) return null;
  const estado = guardado?.conversa === conversaId ? guardado.estado : null;
  if (estado !== null && 'caso' in estado && estado.caso === null) return null;
  const execucao = estado !== null && 'caso' in estado ? estado.caso?.execucao ?? null : null;
  const pendente = estado !== null && 'caso' in estado ? estado.caso?.pendente ?? false : false;

  return (
    <section aria-label="Triagem do caso" className="flex flex-col flex-none"
      style={{ gap: 6, padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span className="orbita-eyebrow flex-1" style={{ color: 'var(--txt3)' }}>Triagem</span>
        <button type="button" onClick={recarregar} className="orbita-chip cursor-pointer" style={CHIP} aria-label="Atualizar triagem">
          Atualizar
        </button>
      </div>
      {estado === null && <span style={NOTA}>Lendo…</span>}
      {estado !== null && 'erro' in estado && <Aviso tom="erro">{estado.erro}</Aviso>}
      {estado !== null && 'caso' in estado && execucao === null && (
        <span style={NOTA}>{pendente ? 'Triagem na fila.' : 'Ainda sem triagem para este caso.'}</span>
      )}
      {execucao?.status === 'em_andamento' && <span style={NOTA}>Triagem em andamento…</span>}
      {execucao?.status === 'concluida' && execucao.triagem !== null && <Resultado triagem={execucao.triagem} execucao={execucao} />}
      {execucao !== null && execucao.status !== 'concluida' && execucao.motivo !== null && (
        <output style={TEXTO}>{SEM_TRIAGEM[execucao.motivo]}{pendente ? ' Há outra triagem na fila.' : ''}</output>
      )}
    </section>
  );
}
