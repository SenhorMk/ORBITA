'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, RefreshCw, Search } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import { EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { ChatwootConversation } from '@/types';
import type { EspelhoDaMensageria } from './espelhoDaMensageria';
import { useMensageria, type Mensageria } from './useMensageria';
import { Aviso } from './Aviso';
import { Avatar, horaCurta } from './Avatar';
import { AvisosDoAtendimento, useAtendimento } from './BarraDoAtendimento';
import { CabecalhoDaConversa } from './CabecalhoDaConversa';
import { Compositor } from './Compositor';
import { Historico } from './Historico';
import { PainelLateral, type AbaDoPainel } from './PainelLateral';
import { useModoDoLayout, type ModoDoLayout } from './useModoDoLayout';
import { HelpInfo } from '@/components/help/HelpInfo';
import estilos from './mensageria.module.css';
import { estaResolvida, passaNoFiltro, rotuloDoStatus } from './statusDaConversa';

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

/** Hora para hoje; dia e mês para os outros dias. */
function quandoNaLista(iso: string | undefined): string {
  if (!iso) return '';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  return data.toDateString() === new Date().toDateString()
    ? horaCurta(iso)
    : data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/**
 * O indicador de tempo real — que só diz "tempo real" quando **há** tempo real.
 * A afirmação acompanha o estado confirmado do canal: `SUBSCRIBED` ou nada.
 */
function Conexao({ ativo, rotulo }: { readonly ativo: boolean; readonly rotulo: string }) {
  return (
    <Pilula
      rotulo={ativo ? `${rotulo} ao vivo` : `${rotulo} sem tempo real`}
      cor={ativo ? 'var(--accent)' : 'var(--txt3)'}
    />
  );
}

/** Uma conversa na lista: contato, telefone e hora; marca "Resolvida" ou "Pendente" só quando é. */
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
    <button type="button" onClick={aoAbrir} aria-current={aberta ? 'true' : undefined} className={estilos.linha}>
      <Avatar nome={conversa.contact?.name} tamanho={38} />
      <span className="flex flex-col min-w-0 flex-1" style={{ gap: 4 }}>
        <span className={estilos.linhaTopo}>
          <span className={estilos.linhaNome}>{conversa.contact?.name || 'Contato sem nome'}</span>
          <span className={estilos.linhaHora}>{quandoNaLista(conversa.updated_at)}</span>
        </span>
        <span className={estilos.linhaBase}>
          <span className={estilos.linhaDetalhe}>{conversa.contact?.phone_number || 'Sem telefone'}</span>
          {rotuloDoStatus(conversa.status) !== 'Aberta' && <span className={estilos.marca}>{rotuloDoStatus(conversa.status)}</span>}
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
  const abertas = (mensageria.conversas ?? []).filter((c) => !estaResolvida(c.status)).length;
  return (
    <header className={estilos.cabecalhoDaLista}>
      <div className="flex items-center" style={{ gap: 6 }}>
        <h2 className={estilos.tituloDaLista}>
          <MessageCircle className="w-4 h-4" aria-hidden />
          Atendimento
        </h2>
        <HelpInfo ajudaId="sac.lista" />
        <button
          type="button"
          onClick={mensageria.sincronizar}
          disabled={mensageria.sincronizando}
          className={estilos.botaoIcone}
          aria-label={mensageria.sincronizando ? 'Sincronizando…' : 'Sincronizar'}
          title="Sincronizar com o Chatwoot"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${mensageria.sincronizando ? 'animate-spin' : ''}`} aria-hidden />
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

      <fieldset className={estilos.filtros} style={{ border: '1px solid var(--line)' }} aria-label="Filtro de conversas">
        {(Object.keys(ROTULO_DO_FILTRO) as Filtro[]).map((opcao) => (
          <button
            key={opcao}
            type="button"
            onClick={() => aoFiltrar(opcao)}
            aria-pressed={filtro === opcao}
            className={estilos.filtro}
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
  aoAbrir,
  oculta,
}: {
  readonly mensageria: Mensageria;
  readonly busca: string;
  readonly aoBuscar: (texto: string) => void;
  readonly filtro: Filtro;
  readonly aoFiltrar: (filtro: Filtro) => void;
  readonly visiveis: readonly ChatwootConversation[];
  readonly aoAbrir: (conversa: ChatwootConversation) => void;
  readonly oculta: boolean;
}) {
  const { conversas, carregandoConversas, erroDeConversas, selecionada } = mensageria;

  return (
    <section aria-label="Conversas" className={`${estilos.lista} ${oculta ? estilos.oculto : ''}`}>
      <CabecalhoDaLista mensageria={mensageria} busca={busca} aoBuscar={aoBuscar} filtro={filtro} aoFiltrar={aoFiltrar} />

      <div className={estilos.rolagem} style={{ scrollbarGutter: 'stable' }}>
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
            aoAbrir={() => aoAbrir(conversa)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A conversa aberta: cabeçalho compacto, histórico com quase toda a altura e o
 * compositor fixo no pé. As ferramentas ficam no ⋯ e abrem no painel lateral,
 * que nunca empurra o compositor para fora.
 */
function Conversa({ mensageria, fetchWithAuth, modo, painel, setPainel, oculta, aoVoltar }: {
  readonly mensageria: Mensageria;
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly modo: ModoDoLayout;
  readonly painel: AbaDoPainel | null;
  readonly setPainel: (aba: AbaDoPainel | null) => void;
  readonly oculta: boolean;
  readonly aoVoltar: (() => void) | null;
}) {
  const { selecionada } = mensageria;
  const atendimento = useAtendimento(fetchWithAuth, mensageria);
  const secao = useRef<HTMLElement | null>(null);

  // O painel é aberto por um item do ⋯, que já saiu da tela quando ele fecha.
  // Sem destino, o foco cairia no <body>: devolve-o ao ⋯ que abriu o menu.
  const fecharPainel = () => {
    setPainel(null);
    requestAnimationFrame(() => {
      secao.current?.querySelector<HTMLButtonElement>('button[aria-label="Mais ações da conversa"]')?.focus();
    });
  };

  if (selecionada === null) {
    return (
      <section className={`${estilos.conversa} items-center justify-center ${oculta ? estilos.oculto : ''}`}>
        <EstadoVazio
          titulo="Nenhuma conversa selecionada"
          descricao="Escolha uma conversa na lista para ver o histórico espelhado e responder."
        />
      </section>
    );
  }

  return (
    <>
      <section ref={secao} aria-label="Conversa aberta" className={`${estilos.conversa} ${oculta ? estilos.oculto : ''}`}>
        <CabecalhoDaConversa
          mensageria={mensageria}
          selecionada={selecionada}
          atendimento={atendimento}
          abrirPainel={setPainel}
          aoVoltar={aoVoltar}
        />
        <AvisosDoAtendimento atendimento={atendimento} />
        <Historico key={selecionada.id_local} mensageria={mensageria} />
        <Compositor mensageria={mensageria} />
      </section>
      {painel !== null && (
        <PainelLateral
          aba={painel}
          aoTrocar={setPainel}
          aoFechar={fecharPainel}
          comoFolha={modo === 'compacto'}
          fetchWithAuth={fetchWithAuth}
          mensageria={mensageria}
          atendimento={atendimento}
        />
      )}
    </>
  );
}

/**
 * A central de mensagens do Orbita.
 *
 * Lista à esquerda, conversa no centro e ferramentas sob demanda à direita,
 * dentro da altura da `AppWindow`, sem altura fixa: cada coluna rola por
 * dentro. Em larguras menores a lista cede lugar ao painel, e no celular lista
 * e conversa se alternam, com voltar. O modo vem da largura da própria central.
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
  const [painel, setPainel] = useState<AbaDoPainel | null>(null);
  // No celular, voltar mostra a lista sem fechar a conversa: o rascunho fica.
  const [listaNoCelular, setListaNoCelular] = useState(false);
  const [modo, medir] = useModoDoLayout();

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
      if (!passaNoFiltro(conversa.status, filtro)) return false;
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

  const aberta = mensageria.selecionada !== null;
  const compacto = modo === 'compacto';
  const listaOculta = compacto ? aberta && !listaNoCelular : modo === 'medio' && aberta && painel !== null;
  const conversaOculta = compacto && (!aberta || listaNoCelular);

  return (
    <div ref={medir} className={estilos.raiz} data-modo={modo}>
      <ListaDeConversas
        mensageria={mensageria}
        busca={busca}
        aoBuscar={setBusca}
        filtro={filtro}
        aoFiltrar={setFiltro}
        visiveis={visiveis}
        aoAbrir={(conversa) => {
          setListaNoCelular(false);
          selecionar(conversa);
        }}
        oculta={listaOculta}
      />
      <Conversa
        mensageria={mensageria}
        fetchWithAuth={fetchWithAuth}
        modo={modo}
        painel={aberta ? painel : null}
        setPainel={setPainel}
        oculta={conversaOculta}
        aoVoltar={compacto ? () => { setPainel(null); setListaNoCelular(true); } : null}
      />
    </div>
  );
}
