'use client';

import { useEffect, useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { Aviso } from './Aviso';
import { useControle, type AcaoDoAtendimento, type ControleVisto } from './useControle';
import type { Mensageria } from './useMensageria';

const ROTULO_DO_MODO = {
  AI: 'Automação responde',
  HUMAN_REQUIRED: 'Aguardando atendente',
} as const;

function rotuloDoControle(controle: ControleVisto): string {
  if (controle.modo !== 'HUMAN') return ROTULO_DO_MODO[controle.modo];
  if (controle.souResponsavel) return 'Com você';
  return controle.responsavelId === null ? 'Sem responsável' : 'Com outro atendente';
}

/**
 * Quem responde esta conversa (MSG-009). Assumir pausa a automação e cancela a
 * fila de quem respondia; devolver exige um resumo, que vai como nota privada.
 * Os botões só pedem: o servidor confere versão, dono e permissão.
 */
export function BarraDoAtendimento({
  fetchWithAuth,
  mensageria,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly mensageria: Mensageria;
}) {
  const controle = useControle(fetchWithAuth, mensageria.selecionada?.id_local ?? null);
  const [resumo, setResumo] = useState<string | null>(null);
  const { recarregar } = controle;

  // Responder uma conversa sem dono a assume no servidor: o estado é relido
  // quando um envio muda de estado.
  const estadosDosEnvios = mensageria.otimistas.map((o) => o.estado).join(',');
  useEffect(() => {
    if (estadosDosEnvios !== '') void recarregar();
  }, [estadosDosEnvios, recarregar]);

  const atual = controle.controle;
  const agir = (acao: AcaoDoAtendimento, nota?: string) => {
    void controle.agir(acao, nota).then((ok) => {
      if (ok) setResumo(null);
    });
  };

  return (
    <div className="flex flex-col flex-none" style={{ gap: 8, padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
      <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
        <span className="orbita-eyebrow" style={{ color: 'var(--txt3)' }}>Atendimento</span>
        <output aria-label="Quem atende" style={{ fontSize: 12, color: 'var(--txt)' }}>
          {atual === null ? (controle.carregando ? 'Lendo…' : '—') : rotuloDoControle(atual)}
        </output>
        {atual !== null && !(atual.modo === 'HUMAN' && atual.souResponsavel) && (
          <button type="button" disabled={controle.agindo} onClick={() => agir('assumir')}
            className="orbita-chip cursor-pointer" style={{ height: 28, fontSize: 11 }}>
            Assumir atendimento
          </button>
        )}
        {atual?.modo === 'AI' && (
          <button type="button" disabled={controle.agindo} onClick={() => agir('exigir_humano')}
            className="orbita-chip cursor-pointer" style={{ height: 28, fontSize: 11 }}>
            Pedir atendente
          </button>
        )}
        {atual?.modo === 'HUMAN' && atual.souResponsavel && resumo === null && (
          <button type="button" disabled={controle.agindo} onClick={() => setResumo('')}
            className="orbita-chip cursor-pointer" style={{ height: 28, fontSize: 11 }}>
            Devolver à automação
          </button>
        )}
      </div>

      {resumo !== null && (
        <form
          className="flex items-center"
          style={{ gap: 8 }}
          onSubmit={(evento) => {
            evento.preventDefault();
            agir('devolver', resumo.trim());
          }}
        >
          <input
            type="text"
            aria-label="Resumo para a nota privada"
            placeholder="Resumo do atendimento (vai como nota privada)"
            value={resumo}
            maxLength={2000}
            onChange={(evento) => setResumo(evento.target.value)}
            className="orbita-campo flex-1 min-w-0"
          />
          <button type="submit" disabled={controle.agindo || resumo.trim() === ''} className="orbita-acao shrink-0 cursor-pointer">
            Devolver
          </button>
          <button type="button" onClick={() => setResumo(null)} className="orbita-chip cursor-pointer shrink-0" style={{ height: 28, fontSize: 11 }}>
            Cancelar
          </button>
        </form>
      )}

      {controle.erro !== null && <Aviso tom="erro">{controle.erro}</Aviso>}
      {controle.aviso !== null && <Aviso tom="atencao">{controle.aviso}</Aviso>}
    </div>
  );
}
