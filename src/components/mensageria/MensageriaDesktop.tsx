'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, MessageCircle, RefreshCw, Search, Send } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import { EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { ChatwootConversation, ChatwootMessage } from '@/types';
import type { EspelhoDaMensageria } from './espelhoDaMensageria';
import type { MensagemOtimista } from './estadoDaConversa';
import { useMensageria, type Mensageria } from './useMensageria';
import { Aviso } from './Aviso';
import { BarraDoAtendimento } from './BarraDoAtendimento';

type Filtro = 'open' | 'resolved' | 'all';

const ROTULO_DO_FILTRO: Record<Filtro, string> = {
  open: 'Abertos',
  resolved: 'Resolvidos',
  all: 'Todos',
};

/** Os últimos oito dígitos de um telefone — o casamento frouxo que o produto já usava. */
function finalDoTelefone(telefone: string | undefined): string {
  return (telefone ?? '').replace(/\D/g, '').slice(-8);
}

/** As iniciais de um contato, ou o marcador de atendimento quando não há nome. */
function Avatar({ nome, tamanho }: { readonly nome: string | undefined; readonly tamanho: number }) {
  return (
    <span
      className="flex items-center justify-center shrink-0"
      aria-hidden
      style={{
        width: tamanho,
        height: tamanho,
        borderRadius: Math.round(tamanho / 3),
        background: 'var(--chip)',
        border: '1px solid var(--line)',
        font: `600 ${Math.round(tamanho / 3)}px/1 var(--font-archivo), sans-serif`,
        color: 'var(--txt2)',
      }}
    >
      {nome && nome.trim() ? nome.trim().substring(0, 2).toUpperCase() : 'SA'}
    </span>
  );
}

function horaCurta(iso: string | undefined): string {
  if (!iso) return '';
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '' : data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * O indicador de tempo real — que só diz "tempo real" quando **há** tempo real.
 *
 * O compositor anterior trazia o texto "Digite sua resposta em tempo real…"
 * escrito fixo no `placeholder`, independentemente de existir subscription. A
 * afirmação agora acompanha o estado confirmado do canal: `SUBSCRIBED` ou nada.
 */
function Conexao({ ativo, rotulo }: { readonly ativo: boolean; readonly rotulo: string }) {
  return (
    <Pilula
      rotulo={ativo ? `${rotulo} ao vivo` : `${rotulo} sem tempo real`}
      cor={ativo ? 'var(--accent)' : 'var(--txt3)'}
    />
  );
}

/** Uma conversa na lista: contato, telefone, hora e estado. */
function LinhaDeConversa({
  conversa,
  aberta,
  aoAbrir,
}: {
  readonly conversa: ChatwootConversation;
  readonly aberta: boolean;
  readonly aoAbrir: () => void;
}) {
  return (
    <button
      type="button"
    onClick={aoAbrir}
      aria-current={aberta ? 'true' : undefined}
      className="w-full flex items-center gap-3 text-left cursor-pointer"
      style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--line)',
        borderLeft: `3px solid ${aberta ? 'var(--accent)' : 'transparent'}`,
        background: aberta ? 'var(--chip)' : 'transparent',
      }}
    >
      <Avatar nome={conversa.contact?.name} tamanho={36} />
      <span className="flex flex-col min-w-0 flex-1" style={{ gap: 3 }}>
        <span className="flex items-center justify-between gap-2">
          <span
            className="truncate"
            style={{ font: '600 12.5px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
          >
            {conversa.contact?.name || 'Contato sem nome'}
          </span>
          <span
            className="shrink-0"
            style={{ fontFamily: 'var(--font-jetbrains-mono), monospace', fontSize: 10, color: 'var(--txt3)' }}
          >
            {horaCurta(conversa.updated_at)}
          </span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate" style={{ fontSize: 11, color: 'var(--txt3)' }}>
            {conversa.contact?.phone_number || 'Sem telefone'}
          </span>
          <Pilula
            rotulo={conversa.status === 'open' ? 'Aberta' : 'Resolvida'}
            cor={conversa.status === 'open' ? 'var(--info)' : 'var(--accent)'}
          />
        </span>
      </span>
    </button>
  );
}

/** O cabeçalho da coluna esquerda: sincronização, estado do canal, busca e filtros. */
function CabecalhoDaLista({
  mensageria,
  busca,
  aoBuscar,
  filtro,
  aoFiltrar,
}: {
  readonly mensageria: Mensageria;
  readonly busca: string;
  readonly aoBuscar: (texto: string) => void;
  readonly filtro: Filtro;
  readonly aoFiltrar: (filtro: Filtro) => void;
}) {
  const abertas = (mensageria.conversas ?? []).filter((c) => c.status === 'open').length;
  return (
    <header className="flex flex-col flex-none gap-3" style={{ padding: 14, borderBottom: '1px solid var(--line)' }}>
      <div className="flex items-center justify-between gap-2">
        <h2
          className="flex items-center m-0"
          style={{ gap: 7, font: '600 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
        >
          <MessageCircle className="w-4 h-4" aria-hidden />
          Atendimento
        </h2>
        <button
          type="button"
          onClick={mensageria.sincronizar}
          disabled={mensageria.sincronizando}
          className="orbita-chip cursor-pointer"
          style={{ height: 30 }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${mensageria.sincronizando ? 'animate-spin' : ''}`} aria-hidden />
          {mensageria.sincronizando ? 'Sincronizando…' : 'Sincronizar'}
        </button>
      </div>

      <Conexao ativo={mensageria.tempoRealDeConversas} rotulo="Lista" />

      {mensageria.avisoDaSincronizacao && <Aviso tom="erro">{mensageria.avisoDaSincronizacao}</Aviso>}

      <div className="relative">
        <Search
          className="absolute w-3.5 h-3.5"
          style={{ left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--txt3)' }}
          aria-hidden
        />
        <input
          type="search"
          aria-label="Buscar conversa"
          placeholder="Buscar por nome ou telefone"
          value={busca}
          onChange={(evento) => aoBuscar(evento.target.value)}
          className="orbita-campo w-full"
          style={{ paddingLeft: 32 }}
        />
      </div>

      <fieldset className="flex gap-1.5 m-0 p-0" style={{ border: 0 }} aria-label="Filtro de conversas">
        {(Object.keys(ROTULO_DO_FILTRO) as Filtro[]).map((opcao) => (
          <button
            key={opcao}
            type="button"
            onClick={() => aoFiltrar(opcao)}
            aria-pressed={filtro === opcao}
            className="orbita-chip cursor-pointer flex-1 justify-center"
            style={{
              height: 30,
              fontSize: 11,
              color: filtro === opcao ? 'var(--txt)' : 'var(--txt3)',
              borderColor: filtro === opcao ? 'var(--bar)' : 'var(--line)',
            }}
          >
            {opcao === 'open' ? `${ROTULO_DO_FILTRO[opcao]} (${abertas})` : ROTULO_DO_FILTRO[opcao]}
          </button>
        ))}
      </fieldset>
    </header>
  );
}

/** A coluna da esquerda: pesquisa, filtros e a lista de conversas do tenant ativo. */
function ListaDeConversas({
  mensageria,
  busca,
  aoBuscar,
  filtro,
  aoFiltrar,
  visiveis,
}: {
  readonly mensageria: Mensageria;
  readonly busca: string;
  readonly aoBuscar: (texto: string) => void;
  readonly filtro: Filtro;
  readonly aoFiltrar: (filtro: Filtro) => void;
  readonly visiveis: readonly ChatwootConversation[];
}) {
  const { conversas, carregandoConversas, erroDeConversas, selecionada } = mensageria;

  return (
    <section
      className="flex flex-col min-h-0 overflow-hidden"
      style={{ width: 340, flex: 'none', borderRadius: 22, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <CabecalhoDaLista mensageria={mensageria} busca={busca} aoBuscar={aoBuscar} filtro={filtro} aoFiltrar={aoFiltrar} />

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        {carregandoConversas && <EstadoCarregando mensagem="Lendo as conversas desta organização…" />}

        {!carregandoConversas && erroDeConversas !== null && (
          <EstadoDeErro
            titulo="Não foi possível ler as conversas"
            detalhe={erroDeConversas}
            onTentarDeNovo={mensageria.recarregarConversas}
          />
        )}

        {!carregandoConversas && erroDeConversas === null && conversas !== null && conversas.length === 0 && (
          <EstadoVazio
            titulo="Nenhuma conversa nesta organização"
            descricao="O espelho não tem nenhuma conversa ainda. Sincronize para trazer o que houver no Chatwoot."
          />
        )}

        {!carregandoConversas && erroDeConversas === null && (conversas?.length ?? 0) > 0 && visiveis.length === 0 && (
          <EstadoVazio
            titulo="Nenhuma conversa encontrada"
            descricao="Nenhuma conversa desta organização corresponde à busca e ao filtro atuais."
          />
        )}

        {visiveis.map((conversa) => (
          <LinhaDeConversa
            key={conversa.id_local}
            conversa={conversa}
            aberta={selecionada?.id_local === conversa.id_local}
            aoAbrir={() => mensageria.selecionar(conversa)}
          />
        ))}
      </div>
    </section>
  );
}

/** O cabeçalho da conversa aberta: quem é, se há tempo real, e resolver/reabrir. */
function CabecalhoDaConversa({
  mensageria,
  selecionada,
}: {
  readonly mensageria: Mensageria;
  readonly selecionada: ChatwootConversation;
}) {
  return (
    <header
      className="flex items-center justify-between flex-none gap-3"
      style={{ padding: 14, borderBottom: '1px solid var(--line)' }}
    >
      <div className="flex items-center min-w-0" style={{ gap: 10 }}>
        <Avatar nome={selecionada.contact?.name} tamanho={38} />
        <div className="flex flex-col min-w-0" style={{ gap: 3 }}>
          <h2
            className="m-0 truncate"
            style={{ font: '600 14px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
          >
            {selecionada.contact?.name || 'Contato sem nome'}
          </h2>
          <span className="truncate" style={{ fontSize: 11, color: 'var(--txt3)' }}>
            {selecionada.contact?.phone_number || selecionada.contact?.email || 'Sem telefone'}
          </span>
        </div>
      </div>

      <div className="flex items-center flex-none" style={{ gap: 10 }}>
        <Conexao ativo={mensageria.tempoRealDeMensagens} rotulo="Histórico" />
        <button
          type="button"
          onClick={mensageria.alternarStatus}
          disabled={mensageria.alterandoStatus}
          className="orbita-chip cursor-pointer"
        >
          <CheckCircle className="w-3.5 h-3.5" aria-hidden />
          {mensageria.alterandoStatus
            ? 'Alterando…'
            : selecionada.status === 'open'
              ? 'Marcar resolvida'
              : 'Reabrir conversa'}
        </button>
      </div>
    </header>
  );
}

/** Uma mensagem do espelho — histórico de verdade, já registrado. */
function Bolha({ mensagem }: { readonly mensagem: ChatwootMessage }) {
  const nossa = mensagem.message_type === 'outgoing' || mensagem.message_type === '1';
  return (
    <article
      className="flex flex-col max-w-[min(560px,78%)]"
      style={{
        gap: 4,
        alignSelf: nossa ? 'flex-end' : 'flex-start',
        padding: '10px 13px',
        borderRadius: 16,
        background: nossa ? 'var(--chip)' : 'var(--glass2)',
        border: `1px solid ${nossa ? 'var(--bar)' : 'var(--line)'}`,
      }}
    >
      <span className="orbita-eyebrow">{nossa ? 'Você' : mensagem.sender_name || 'Contato'}</span>
      <p className="m-0" style={{ font: '400 12.5px/1.5 var(--font-archivo), sans-serif', color: 'var(--txt)' }}>
        {mensagem.content}
      </p>
      <span
        className="self-end"
        style={{ fontFamily: 'var(--font-jetbrains-mono), monospace', fontSize: 9.5, color: 'var(--txt3)' }}
      >
        {horaCurta(mensagem.created_at)}
      </span>
    </article>
  );
}

/** O rótulo, a cor e a frase de cada estado de um envio que ainda não é histórico. */
const APRESENTACAO_DO_ENVIO: Readonly<Record<MensagemOtimista['estado'], { readonly rotulo: string; readonly cor: string; readonly nota: string | null }>> = {
  enviando: { rotulo: 'Enviando…', cor: 'var(--line)', nota: null },
  pendente: { rotulo: 'Na fila de envio', cor: 'var(--line)', nota: 'Registrada. Aparece como enviada quando o Chatwoot confirmar.' },
  sem_resposta: { rotulo: 'Sem resposta do servidor', cor: 'var(--warning)', nota: 'Tentar de novo repete o mesmo pedido: não cria uma segunda mensagem.' },
  falhou: { rotulo: 'Não enviada', cor: 'var(--danger)', nota: 'O servidor recusou o pedido: nada foi registrado nem enviado.' },
  incerta: { rotulo: 'Entrega não confirmada', cor: 'var(--warning)', nota: null },
  recusada: { rotulo: 'Recusada pelo Chatwoot', cor: 'var(--danger)', nota: 'O Chatwoot não aplicou esta mensagem. Corrija a causa antes de enviar de novo.' },
  invalidada: { rotulo: 'Não enviada', cor: 'var(--danger)', nota: 'O atendimento mudou de responsável antes do envio; nada saiu.' },
};

/**
 * Uma mensagem que ainda não é histórico — e que não pode parecer que é.
 *
 * O contorno tracejado e o rótulo dizem o estado real. Ela só vira histórico
 * quando o worker grava o recibo do Chatwoot (MSG-008); até lá, nenhum estado
 * afirma entrega. Só aparece botão onde agir é seguro: repetir o mesmo comando
 * (sem resposta) ou reescrever o que comprovadamente não saiu (falhou,
 * recusada). Desconhecida não tem botão: pode ter chegado.
 */
function BolhaNaoConfirmada({
  otimista,
  aoTentarDeNovo,
  aoRecuperar,
}: {
  readonly otimista: MensagemOtimista;
  readonly aoTentarDeNovo: () => void;
  readonly aoRecuperar: () => void;
}) {
  const { rotulo, cor, nota } = APRESENTACAO_DO_ENVIO[otimista.estado];
  const emAndamento = otimista.estado === 'enviando' || otimista.estado === 'pendente';
  return (
    <article
      className="flex flex-col max-w-[min(560px,78%)] self-end"
      style={{
        gap: 4,
        padding: '10px 13px',
        borderRadius: 16,
        background: 'transparent',
        border: `1px dashed ${cor}`,
      }}
    >
      <span className="orbita-eyebrow" style={{ color: emAndamento ? 'var(--txt3)' : cor }}>
        {rotulo}
      </span>
      <p className="m-0" style={{ font: '400 12.5px/1.5 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}>
        {otimista.conteudo}
      </p>
      {otimista.erro !== null && (
        <output className="m-0 block" role={otimista.estado === 'falhou' ? 'alert' : undefined} style={{ fontSize: 11, color: 'var(--txt2)' }}>
          {otimista.erro}
        </output>
      )}
      {nota !== null && (
        <p className="m-0" style={{ fontSize: 10.5, color: 'var(--txt3)' }}>
          {nota}
        </p>
      )}
      {otimista.estado === 'sem_resposta' && (
        <button type="button" onClick={aoTentarDeNovo} className="orbita-chip cursor-pointer self-start" style={{ height: 28, fontSize: 11 }}>
          Tentar de novo
        </button>
      )}
      {(otimista.estado === 'falhou' || otimista.estado === 'recusada' || otimista.estado === 'invalidada') && (
        <button type="button" onClick={aoRecuperar} className="orbita-chip cursor-pointer self-start" style={{ height: 28, fontSize: 11 }}>
          Recuperar texto
        </button>
      )}
    </article>
  );
}

/** O histórico rolável, com carregando, erro e vazio distintos entre si. */
function Historico({ mensageria }: { readonly mensageria: Mensageria }) {
  const area = useRef<HTMLDivElement | null>(null);
  const { historico, otimistas } = mensageria;

  // Rolar pelo `scrollTop` da própria área, e não por `scrollIntoView` no fim:
  // é a mesma rolagem, sem depender de uma API que o jsdom não implementa nem
  // de um nó vazio só para servir de âncora.
  useEffect(() => {
    if (area.current) area.current.scrollTop = area.current.scrollHeight;
  }, [historico.length, otimistas.length]);

  const vazio =
    !mensageria.carregandoHistorico &&
    mensageria.erroDeHistorico === null &&
    historico.length === 0 &&
    otimistas.length === 0;

  return (
    <div ref={area} className="flex-1 min-h-0 overflow-y-auto flex flex-col" style={{ padding: 18, gap: 10 }}>
      {mensageria.carregandoHistorico && <EstadoCarregando mensagem="Lendo o histórico desta conversa…" />}

      {mensageria.erroDeHistorico !== null && (
        <EstadoDeErro
          titulo="Não foi possível ler o histórico"
          detalhe={mensageria.erroDeHistorico}
          onTentarDeNovo={mensageria.recarregarHistorico}
        />
      )}

      {vazio && (
        <EstadoVazio
          titulo="Conversa sem mensagens"
          descricao="Esta conversa existe no espelho, mas não tem nenhuma mensagem registrada."
        />
      )}

      {historico.map((mensagem) => (
        <Bolha key={mensagem.id_local} mensagem={mensagem} />
      ))}

      {otimistas.map((otimista) => (
        <BolhaNaoConfirmada
          key={otimista.id}
          otimista={otimista}
          aoTentarDeNovo={() => mensageria.tentarDeNovo(otimista.id)}
          aoRecuperar={() => mensageria.recuperarRascunho(otimista.id)}
        />
      ))}
    </div>
  );
}

/** O compositor, e o bloqueio honesto quando o provedor se disse indisponível. */
function Compositor({ mensageria }: { readonly mensageria: Mensageria }) {
  const bloqueado = mensageria.integracaoIndisponivel !== null;
  return (
    <div className="flex flex-col flex-none" style={{ gap: 8, padding: 14, borderTop: '1px solid var(--line)' }}>
      {bloqueado && (
        <Aviso tom="atencao">
          Integração Chatwoot indisponível para esta organização — {mensageria.integracaoIndisponivel}. O histórico
          espelhado continua legível; o envio volta quando a conexão estiver configurada.
        </Aviso>
      )}

      <form
        className="flex items-center"
        style={{ gap: 10 }}
        onSubmit={(evento) => {
          evento.preventDefault();
          mensageria.enviar();
        }}
      >
        <input
          type="text"
          aria-label="Mensagem"
          placeholder={bloqueado ? 'Envio indisponível nesta organização' : 'Escreva sua resposta'}
          value={mensageria.rascunho}
          onChange={(evento) => mensageria.escreverRascunho(evento.target.value)}
          disabled={bloqueado}
          className="orbita-campo flex-1 min-w-0"
        />
        <button
          type="submit"
          disabled={mensageria.enviando || mensageria.rascunho.trim() === '' || bloqueado}
          className="orbita-acao shrink-0 cursor-pointer"
        >
          <Send className="w-4 h-4" aria-hidden />
          {mensageria.enviando ? 'Enviando…' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}

/** A coluna da direita: cabeçalho, histórico e compositor da conversa aberta. */
function Conversa({ mensageria, fetchWithAuth }: { readonly mensageria: Mensageria; readonly fetchWithAuth: AuthenticatedFetch }) {
  const { selecionada } = mensageria;

  if (selecionada === null) {
    return (
      <section
        className="flex flex-col flex-1 min-w-0 items-center justify-center"
        style={{ borderRadius: 22, background: 'var(--glass2)', border: '1px solid var(--line)' }}
      >
        <EstadoVazio
          titulo="Nenhuma conversa selecionada"
          descricao="Escolha uma conversa na lista à esquerda para ver o histórico espelhado e responder."
        />
      </section>
    );
  }

  return (
    <section
      className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{ borderRadius: 22, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <CabecalhoDaConversa mensageria={mensageria} selecionada={selecionada} />
      <Historico mensageria={mensageria} />
      <BarraDoAtendimento fetchWithAuth={fetchWithAuth} mensageria={mensageria} />
      <Compositor mensageria={mensageria} />
    </section>
  );
}

/**
 * A Mensageria desktop do Orbita.
 *
 * Duas colunas dentro da altura da `AppWindow`, sem altura fixa nenhuma: a
 * versão anterior forçava `h-[720px]`, o que sobrava da janela em 1366×768 —
 * empurrando o compositor para fora da área visível e obrigando a rolar a
 * página inteira — e faltava em 1920×1080, deixando uma faixa vazia embaixo.
 * Aqui as duas colunas ocupam o espaço que existe e rolam por dentro.
 *
 * O escopo é a organização ativa verificada, e ela vem de fora, dos Tickets
 * 06/07 (`SelecaoDeOrganizacao`). Esta tela não é uma segunda fonte de tenant.
 *
 * @param telefoneParaAbrir - O contato que a aba de Clientes pediu para abrir.
 *   A seleção acontece uma vez por telefone pedido, quando a lista já tiver sido
 *   lida — e não sobrescreve o que o atendente escolher depois.
 */
export function MensageriaDesktop({
  fetchWithAuth,
  selecao,
  telefoneParaAbrir,
  espelho,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly selecao: SelecaoDeOrganizacao | null;
  readonly telefoneParaAbrir?: string | null;
  readonly espelho?: EspelhoDaMensageria;
}) {
  const mensageria = useMensageria(fetchWithAuth, selecao, espelho);
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('open');

  const { conversas, selecionar } = mensageria;
  const atendidoRef = useRef<string | null>(null);
  useEffect(() => {
    const alvo = finalDoTelefone(telefoneParaAbrir ?? undefined);
    if (alvo === '' || conversas === null || atendidoRef.current === alvo) return;
    atendidoRef.current = alvo;
    const encontrada = conversas.find((c) => finalDoTelefone(c.contact?.phone_number ?? undefined) === alvo);
    if (encontrada) selecionar(encontrada);
  }, [conversas, selecionar, telefoneParaAbrir]);

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const digitos = termo.replace(/\D/g, '');
    return (conversas ?? []).filter((conversa) => {
      if (filtro !== 'all' && conversa.status !== filtro) return false;
      if (termo === '') return true;
      const nome = conversa.contact?.name?.toLowerCase() ?? '';
      const telefone = conversa.contact?.phone_number ?? '';
      return nome.includes(termo) || (digitos !== '' && telefone.replace(/\D/g, '').includes(digitos));
    });
  }, [busca, conversas, filtro]);

  if (selecao === null) {
    return (
      <EstadoVazio
        titulo="Nenhuma organização ativa"
        descricao="Abra a aba Organização e selecione uma organização para ver o atendimento dela."
      />
    );
  }

  return (
    <div className="flex flex-1 min-h-0" style={{ gap: 16 }}>
      <ListaDeConversas
        mensageria={mensageria}
        busca={busca}
        aoBuscar={setBusca}
        filtro={filtro}
        aoFiltrar={setFiltro}
        visiveis={visiveis}
      />
      <Conversa mensageria={mensageria} fetchWithAuth={fetchWithAuth} />
    </div>
  );
}
