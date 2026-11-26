'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronRight, X } from 'lucide-react';

import {
  LIMITES_DO_HISTORICO, respostaAssistenteSchema, type RespostaAssistente, type TurnoAnterior,
} from '@/services/assistenteAdministrativo/contratoAssistenteOrbita';

type Proposta = NonNullable<RespostaAssistente['proposta']>;
type Escolha = NonNullable<RespostaAssistente['escolha']>;
type FetchComAuth = (url: string, options?: RequestInit) => Promise<Response>;

type Turno = {
  readonly pergunta: string; readonly resposta?: RespostaAssistente; readonly falha?: string; readonly chave?: string;
  readonly confirmacaoIniciada?: boolean; readonly selecionados?: readonly string[];
};

/** "confirmo"/"cancelar" digitados equivalem aos botões da prévia pendente. */
const CONFIRMAR_DIGITADO = /^(?:sim|ok|confirmo|confirmar|confirma|pode confirmar|confirmado)[.!\s]*$/iu;
const CANCELAR_DIGITADO = /^(?:n[aã]o|cancelar|cancela|cancelo|desisto)[.!\s]*$/iu;

/** Memória curta enviada ao servidor: só trocas respondidas, já cortadas no limite do contrato. */
function memoriaCurta(turnos: readonly Turno[]): TurnoAnterior[] {
  return turnos.filter(t => t.resposta).slice(-LIMITES_DO_HISTORICO.turnos).map(t => ({
    pergunta: t.pergunta.slice(0, LIMITES_DO_HISTORICO.pergunta),
    resposta: [t.resposta!.mensagem, ...(t.resposta!.detalhes ?? [])].join('\n').slice(0, LIMITES_DO_HISTORICO.resposta),
  }));
}

interface Props {
  readonly organizacaoId: string;
  readonly fetchWithAuth: FetchComAuth;
}

const sugestoes = ['Quanto vendemos nos últimos 30 dias?', 'Quais produtos estão com estoque baixo?', 'Defina o estoque do SKU X em 5'];

const estadosDoResultado = {
  aplicado: 'Alteração aceita no Bling e registrada no ORBITA',
  recusado: 'O Bling recusou a alteração',
  alterado_apos_previa: 'O produto mudou após a prévia; prepare outra seleção',
  indeterminado: 'Resultado desconhecido; confira no Bling antes de repetir',
  nao_enviado: 'Nenhuma alteração enviada para este produto',
} as const;

/** POST JSON ao assistente; lança se a resposta não seguir o contrato. */
async function postarAssistente(fetchWithAuth: FetchComAuth, url: string, corpo: unknown) {
  const response = await fetchWithAuth(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(270_000),
  });
  const parsed = respostaAssistenteSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Resposta inválida.');
  return { ok: response.ok, dados: parsed.data };
}

function EscolhaDeProdutos({ escolha, selecionados, carregando, onAlternar, onPreparar, onCancelar }: {
  readonly escolha: Escolha; readonly selecionados: readonly string[]; readonly carregando: boolean;
  readonly onAlternar: (produtoId: string) => void; readonly onPreparar: () => void; readonly onCancelar: () => void;
}) {
  return (
    <fieldset aria-label="Produtos parecidos" className="space-y-2">
      <legend className="sr-only">Escolha os produtos para alterar</legend>
      <ul className="space-y-1">
        {escolha.candidatos.map(c => <li key={c.produtoId}>
          <label className="flex cursor-pointer items-start gap-2 rounded border p-2" style={{ borderColor: 'var(--line)' }}>
            <input type="checkbox" className="mt-1" disabled={carregando}
              checked={selecionados.includes(c.produtoId)}
              onChange={() => onAlternar(c.produtoId)} />
            <span>{c.nome}{c.codigo ? ' · SKU ' + c.codigo : ''}</span>
          </label>
        </li>)}
      </ul>
      <div className="flex gap-2">
        <button type="button" className="orbita-chip" disabled={carregando || !selecionados.length} onClick={onPreparar}>
          Preparar prévia{selecionados.length ? ' (' + selecionados.length + ')' : ''}
        </button>
        <button type="button" className="orbita-chip" disabled={carregando} onClick={onCancelar}>Cancelar</button>
      </div>
    </fieldset>
  );
}

function PreviaDeAlteracao({ proposta, confirmacaoIniciada, carregando, onConfirmar, onCancelar }: {
  readonly proposta: Proposta; readonly confirmacaoIniciada: boolean; readonly carregando: boolean;
  readonly onConfirmar: () => void; readonly onCancelar: () => void;
}) {
  return (
    <section aria-label="Prévia de alteração" className="space-y-2">
      <p>Válida até {new Date(proposta.expiraEm).toLocaleTimeString('pt-BR')}.</p>
      {proposta.deposito && <p>Saldo físico no depósito: {proposta.deposito.nome}. Este valor substitui o saldo atual.</p>}
      <ul className="space-y-2">
        {proposta.itens.map(item => <li key={item.produtoId} className="rounded border p-2" style={{ borderColor: 'var(--line)' }}>
          <p className="font-semibold">{item.nome}{item.codigo ? ' · SKU ' + item.codigo : ''}</p>
          <p>{item.campo === 'descricao' ? 'Descrição curta' : item.campo === 'estoque' ? 'Estoque físico' : 'Nome'}</p>
          <p className="whitespace-pre-wrap">Antes: {item.anterior === '' ? '(vazio)' : item.anterior}</p>
          <p className="whitespace-pre-wrap">Depois: {item.valor}</p>
        </li>)}
      </ul>
      <div className="flex gap-2">
        <button type="button" className="orbita-chip" disabled={carregando} onClick={onConfirmar}>{confirmacaoIniciada ? 'Conferir confirmação' : 'Confirmar alterações'}</button>
        <button type="button" className="orbita-chip" disabled={carregando || confirmacaoIniciada} onClick={onCancelar}>Cancelar</button>
      </div>
    </section>
  );
}

interface AcoesDoTurno {
  readonly alternarCandidato: (indice: number, produtoId: string) => void;
  readonly escolher: (indice: number) => void;
  readonly descartarEscolha: (indice: number) => void;
  readonly confirmar: (indice: number) => void;
  readonly cancelar: (indice: number) => void;
}

function CartaoDoTurno({ turno, indice, carregando, acoes }: {
  readonly turno: Turno; readonly indice: number; readonly carregando: boolean; readonly acoes: AcoesDoTurno;
}) {
  const { resposta } = turno;
  return (
    <article className="space-y-1 break-words rounded-lg border p-2" style={{ borderColor: 'var(--line)' }}>
      <p className="font-semibold">{turno.pergunta}</p>
      {resposta && (
        <>
          <p>{resposta.mensagem}</p>
          {!!resposta.detalhes?.length && (
            <ul className="ml-4 list-disc">
              {resposta.detalhes.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
          {resposta.fonte && <p className="text-xs" style={{ color: 'var(--txt2)' }}>{resposta.fonte}</p>}
          {resposta.escolha && <EscolhaDeProdutos escolha={resposta.escolha} selecionados={turno.selecionados ?? []}
            carregando={carregando} onAlternar={id => acoes.alternarCandidato(indice, id)}
            onPreparar={() => acoes.escolher(indice)} onCancelar={() => acoes.descartarEscolha(indice)} />}
          {resposta.proposta && <PreviaDeAlteracao proposta={resposta.proposta} confirmacaoIniciada={!!turno.confirmacaoIniciada}
            carregando={carregando} onConfirmar={() => acoes.confirmar(indice)} onCancelar={() => acoes.cancelar(indice)} />}
          {resposta.resultados && <ul className="space-y-1">
            {resposta.resultados.map(resultado => <li key={resultado.produtoId}>{resultado.nome}: {estadosDoResultado[resultado.estado]}.</li>)}
          </ul>}
          {turno.chave && <p className="text-xs">Confirmação: {turno.chave}</p>}
        </>
      )}
      {turno.falha && <p role="alert">{turno.falha}</p>}
    </article>
  );
}

function CampoDePergunta({ campoId, texto, setTexto, temProposta, carregando, onEnviar, onFechar }: {
  readonly campoId: string; readonly texto: string; readonly setTexto: (texto: string) => void;
  readonly temProposta: boolean; readonly carregando: boolean;
  readonly onEnviar: (evento: FormEvent<HTMLFormElement>) => void; readonly onFechar: () => void;
}) {
  const valor = texto.trim();
  const podeEnviar = temProposta ? CONFIRMAR_DIGITADO.test(valor) || CANCELAR_DIGITADO.test(valor) : valor.length >= 4;
  return (
    <form onSubmit={onEnviar} className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={campoId} className="sr-only">Pergunta para o Assistente ORBITA</label>
        <textarea id={campoId} rows={2} value={texto} onChange={e => setTexto(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') onFechar();
            // Enter envia, Shift+Enter quebra a linha (como no cockpit de atendimento).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
          }}
          maxLength={4500}
          placeholder={temProposta ? 'Escreva "confirmo" ou "cancelar", ou use os botões' : 'Consulte dados ou peça uma alteração de produto'}
          className="w-full rounded-lg border bg-transparent px-2 py-2" style={{ borderColor: 'var(--line)' }} />
      </div>
      <button type="submit" disabled={carregando || !podeEnviar} aria-label="Enviar pergunta" className="orbita-chip p-2">
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </form>
  );
}

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
      const { ok, dados } = await postarAssistente(fetchWithAuth, '/api/assistente/orbita/confirmar',
        { chave: proposta.chave, organizacaoEsperada: organizacaoId });
      setTurnos(anteriores => anteriores.map((turno, i) => i !== indice ? turno
        : ok ? { pergunta: turno.pergunta, resposta: dados.emAndamento ? { ...dados, proposta } : dados,
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

  function alternarCandidato(indice: number, produtoId: string) {
    setTurnos(anteriores => anteriores.map((turno, i) => {
      if (i !== indice) return turno;
      const atuais = new Set(turno.selecionados ?? []);
      if (atuais.has(produtoId)) atuais.delete(produtoId); else atuais.add(produtoId);
      return { ...turno, selecionados: [...atuais] };
    }));
  }

  /** Pede a prévia para os candidatos marcados (um ou vários); nada é enviado ao Bling aqui. */
  async function escolher(indice: number) {
    const turno = turnos[indice];
    const escolha = turno.resposta?.escolha;
    const produtoIds = turno.selecionados ?? [];
    if (!escolha || !produtoIds.length || carregando) return;
    setCarregando(true);
    try {
      const { ok, dados } = await postarAssistente(fetchWithAuth, '/api/assistente/orbita/escolher',
        { organizacaoEsperada: organizacaoId, pedido: escolha.pedido, produtoIds });
      setTurnos(anteriores => anteriores.map((t, i) => i !== indice ? t
        : ok ? { pergunta: t.pergunta, resposta: dados } : { ...t, falha: dados.mensagem }));
    } catch {
      setTurnos(anteriores => anteriores.map((t, i) => i !== indice ? t : {
        ...t, falha: 'Não consegui preparar a prévia. Tente de novo; nada foi alterado.',
      }));
    } finally {
      setCarregando(false);
    }
  }

  function descartarEscolha(indice: number) {
    setTurnos(anteriores => anteriores.map((turno, i) => i !== indice ? turno : {
      pergunta: turno.pergunta, resposta: { mensagem: 'Escolha descartada. Nenhum produto foi alterado.' },
    }));
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
    if (carregando) return;
    if (temProposta) {
      // Com uma prévia pendente, só "confirmo" ou "cancelar" digitados (ou os botões) seguem.
      const indice = turnos.findLastIndex(t => t.resposta?.proposta);
      if (indice >= 0 && CONFIRMAR_DIGITADO.test(pergunta)) { setTexto(''); void confirmar(indice); return; }
      if (indice >= 0 && CANCELAR_DIGITADO.test(pergunta) && !turnos[indice].confirmacaoIniciada) { setTexto(''); cancelar(indice); return; }
      return;
    }
    if (pergunta.length < 4) return;
    setTexto('');
    setCarregando(true);
    const anteriores = turnos.slice(-15);
    setTurnos([...anteriores, { pergunta }]);
    try {
      const { ok, dados } = await postarAssistente(fetchWithAuth, '/api/assistente/orbita',
        { pergunta, organizacaoEsperada: organizacaoId, historico: memoriaCurta(anteriores) });
      if (!ok) {
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
              <CartaoDoTurno key={indice} turno={turno} indice={indice} carregando={carregando}
                acoes={{ alternarCandidato, escolher, descartarEscolha, confirmar, cancelar }} />
            ))}
            {carregando && <output>Processando… Aguarde a conferência dos produtos.</output>}
          </div>
          <CampoDePergunta campoId={campoId} texto={texto} setTexto={setTexto} temProposta={temProposta}
            carregando={carregando} onEnviar={enviar} onFechar={fechar} />
        </aside>
      )}
    </>
  );
}
