'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronRight, X } from 'lucide-react';

import type { RespostaAssistente } from '@/services/assistenteAdministrativo/contratoAssistenteOrbita';

type Turno = { readonly pergunta: string; readonly resposta?: RespostaAssistente; readonly falha?: string };

interface Props {
  readonly organizacaoId: string;
  readonly fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

const sugestoes = ['Quanto vendemos nos últimos 30 dias?', 'Quais os produtos mais vendidos?', 'Quais produtos estão com estoque baixo?'];

export function AssistenteOrbita({ organizacaoId, fetchWithAuth }: Props) {
  const regiaoId = useId();
  const campoId = useId();
  const botao = useRef<HTMLButtonElement>(null);
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState('');
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [carregando, setCarregando] = useState(false);

  function fechar() {
    setAberto(false);
    botao.current?.focus();
  }

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const pergunta = texto.trim();
    if (carregando || pergunta.length < 4) return;
    setTexto('');
    setCarregando(true);
    const anteriores = turnos.slice(-15);
    setTurnos([...anteriores, { pergunta }]);
    try {
      const resposta = await fetchWithAuth('/api/assistente/orbita', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pergunta, organizacaoEsperada: organizacaoId }),
        signal: AbortSignal.timeout(15_000),
      });
      const dados = await resposta.json() as RespostaAssistente;
      if (!resposta.ok) {
        setTurnos([...anteriores, { pergunta, falha: dados.mensagem || 'Não foi possível consultar o assistente.' }]);
        return;
      }
      setTurnos([...anteriores, { pergunta, resposta: dados }]);
    } catch {
      setTurnos([...anteriores, { pergunta, falha: 'Não consegui consultar os dados. Confira a conexão e tente novamente.' }]);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <>
      <button ref={botao} type="button" className="orbita-acao" aria-expanded={aberto}
        aria-controls={regiaoId} onClick={() => setAberto(anterior => !anterior)}>
        <Bot className="h-4 w-4" aria-hidden /> Assistente ORBITA
      </button>
      {aberto && (
        <aside id={regiaoId} aria-label="Assistente ORBITA"
          className="fixed inset-x-3 bottom-3 z-[70] flex max-h-[min(70dvh,42rem)] flex-col gap-3 rounded-2xl border p-3 text-sm shadow-xl sm:left-auto sm:right-5 sm:w-[min(26rem,calc(100vw-2rem))]"
          style={{ background: 'var(--modal)', borderColor: 'var(--line)', color: 'var(--txt)' }}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Assistente ORBITA</h2>
            <button type="button" onClick={fechar} aria-label="Fechar assistente" className="orbita-chip">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div role="log" aria-label="Conversa" className="min-h-16 space-y-3 overflow-y-auto overscroll-contain">
            {turnos.length === 0 && sugestoes.map(sugestao => (
              <button type="button" key={sugestao} className="orbita-chip mr-2 mb-1" onClick={() => setTexto(sugestao)}>
                {sugestao}
              </button>
            ))}
            {turnos.map((turno, indice) => (
              <article key={indice} className="space-y-1 break-words rounded-lg border p-2" style={{ borderColor: 'var(--line)' }}>
                <p className="font-semibold">{turno.pergunta}</p>
                {turno.resposta && (
                  <>
                    <p>{turno.resposta.mensagem}</p>
                    {!!turno.resposta.detalhes?.length && (
                      <ul className="ml-4 list-disc">
                        {turno.resposta.detalhes.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    )}
                    {turno.resposta.fonte && <p className="text-xs" style={{ color: 'var(--txt2)' }}>{turno.resposta.fonte}</p>}
                  </>
                )}
                {turno.falha && <p role="alert">{turno.falha}</p>}
              </article>
            ))}
            {carregando && <output>Consultando…</output>}
          </div>
          <form onSubmit={enviar} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={campoId} className="sr-only">Pergunta para o Assistente ORBITA</label>
              <input id={campoId} value={texto} onChange={e => setTexto(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') fechar(); }}
                maxLength={400} placeholder="Pergunte sobre vendas, estoque ou pedidos"
                className="w-full rounded-lg border bg-transparent px-2 py-2" style={{ borderColor: 'var(--line)' }} />
            </div>
            <button type="submit" disabled={carregando || texto.trim().length < 4}
              aria-label="Enviar pergunta" className="orbita-chip p-2">
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
