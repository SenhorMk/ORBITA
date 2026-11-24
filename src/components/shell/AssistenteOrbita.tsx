'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronRight, X } from 'lucide-react';

import { respostaAssistenteSchema, type RespostaAssistente } from '@/services/assistenteAdministrativo/contratoAssistenteOrbita';

type Turno = { readonly pergunta: string; readonly resposta?: RespostaAssistente; readonly falha?: string; readonly chave?: string; readonly confirmacaoIniciada?: boolean };

interface Props {
  readonly organizacaoId: string;
  readonly fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

const sugestoes = ['Quanto vendemos nos últimos 30 dias?', 'Quais produtos estão com estoque baixo?', 'Defina o estoque do SKU X em 5'];

const estadosDoResultado = {
  aplicado: 'Alteração aceita no Bling e registrada no ORBITA',
  recusado: 'O Bling recusou a alteração',
  alterado_apos_previa: 'O produto mudou após a prévia; prepare outra seleção',
  indeterminado: 'Resultado desconhecido; confira no Bling antes de repetir',
  nao_enviado: 'Nenhuma alteração enviada para este produto',
} as const;

export function AssistenteOrbita({ organizacaoId, fetchWithAuth }: Props) {
  const regiaoId = useId();
  const campoId = useId();
  const botao = useRef<HTMLButtonElement>(null);
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState('');
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [carregando, setCarregando] = useState(false);
  const temProposta = turnos.some(t => t.resposta?.proposta);

  async function confirmar(indice: number) {
    const proposta = turnos[indice].resposta?.proposta;
    if (!proposta || carregando) return;
    setCarregando(true);
    setTurnos(anteriores => anteriores.map((turno, i) => i !== indice ? turno : { ...turno, confirmacaoIniciada: true }));
    try {
      const response = await fetchWithAuth('/api/assistente/orbita/confirmar', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chave: proposta.chave, organizacaoEsperada: organizacaoId }),
        signal: AbortSignal.timeout(270_000),
      });
      const parsed = respostaAssistenteSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Resposta inválida.');
      const dados = parsed.data;
      setTurnos(anteriores => anteriores.map((turno, i) => i !== indice ? turno
        : response.ok ? { pergunta: turno.pergunta, resposta: dados.emAndamento ? { ...dados, proposta } : dados,
          chave: proposta.chave, confirmacaoIniciada: true }
          : { ...turno, falha: dados.mensagem }));
    } catch {
      setTurnos(anteriores => anteriores.map((turno, i) => i !== indice ? turno : {
        ...turno, falha: 'A resposta da confirmação não chegou. Use o mesmo botão para conferir; não prepare outra operação.',
      }));
    } finally {
      setCarregando(false);
    }
  }

  function cancelar(indice: number) {
    if (turnos[indice].confirmacaoIniciada) return;
    setTurnos(anteriores => anteriores.map((turno, i) => i !== indice ? turno : {
      pergunta: turno.pergunta, resposta: { mensagem: 'Proposta descartada. Nenhum comando de alteração foi enviado.' },
    }));
  }

  function fechar() {
    setAberto(false);
    botao.current?.focus();
  }

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const pergunta = texto.trim();
    if (carregando || temProposta || pergunta.length < 4) return;
    setTexto('');
    setCarregando(true);
    const anteriores = turnos.slice(-15);
    setTurnos([...anteriores, { pergunta }]);
    try {
      const resposta = await fetchWithAuth('/api/assistente/orbita', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pergunta, organizacaoEsperada: organizacaoId }),
        signal: AbortSignal.timeout(270_000),
      });
      const parsed = respostaAssistenteSchema.safeParse(await resposta.json());
      if (!parsed.success) throw new Error('Resposta inválida.');
      const dados = parsed.data;
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
                    {turno.resposta.proposta && <section aria-label="Prévia de alteração" className="space-y-2">
                      <p>Válida até {new Date(turno.resposta.proposta.expiraEm).toLocaleTimeString('pt-BR')}.</p>
                      {turno.resposta.proposta.deposito && <p>Saldo físico no depósito: {turno.resposta.proposta.deposito.nome}. Este valor substitui o saldo atual.</p>}
                      <ul className="space-y-2">
                        {turno.resposta.proposta.itens.map(item => <li key={item.produtoId} className="rounded border p-2" style={{ borderColor: 'var(--line)' }}>
                          <p className="font-semibold">{item.nome}{item.codigo ? ' · SKU ' + item.codigo : ''}</p>
                          <p>{item.campo === 'descricao' ? 'Descrição curta' : item.campo === 'estoque' ? 'Estoque físico' : 'Nome'}</p>
                          <p className="whitespace-pre-wrap">Antes: {item.anterior === '' ? '(vazio)' : item.anterior}</p>
                          <p className="whitespace-pre-wrap">Depois: {item.valor}</p>
                        </li>)}
                      </ul>
                      <div className="flex gap-2">
                        <button type="button" className="orbita-chip" disabled={carregando} onClick={() => confirmar(indice)}>{turno.confirmacaoIniciada ? 'Conferir confirmação' : 'Confirmar alterações'}</button>
                        <button type="button" className="orbita-chip" disabled={carregando || turno.confirmacaoIniciada} onClick={() => cancelar(indice)}>Cancelar</button>
                      </div>
                    </section>}
                    {turno.resposta.resultados && <ul className="space-y-1">
                      {turno.resposta.resultados.map(resultado => <li key={resultado.produtoId}>{resultado.nome}: {estadosDoResultado[resultado.estado]}.</li>)}
                    </ul>}
                    {turno.chave && <p className="text-xs">Confirmação: {turno.chave}</p>}
                  </>
                )}
                {turno.falha && <p role="alert">{turno.falha}</p>}
              </article>
            ))}
            {carregando && <output>Processando… Aguarde a conferência dos produtos.</output>}
          </div>
          <form onSubmit={enviar} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={campoId} className="sr-only">Pergunta para o Assistente ORBITA</label>
              <textarea id={campoId} rows={2} value={texto} onChange={e => setTexto(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') fechar(); }}
                maxLength={4500} placeholder="Consulte dados ou peça uma alteração de produto"
                className="w-full rounded-lg border bg-transparent px-2 py-2" style={{ borderColor: 'var(--line)' }} />
            </div>
            <button type="submit" disabled={carregando || temProposta || texto.trim().length < 4}
              aria-label="Enviar pergunta" className="orbita-chip p-2">
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </aside>
      )}
    </>
  );
}
