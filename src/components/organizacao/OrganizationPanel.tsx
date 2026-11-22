'use client';

import { HelpContext, helpPageHeader } from '@/components/help/HelpContext';
import { HelpInfo } from '@/components/help/HelpInfo';

import { useState, type ReactNode } from 'react';
import { Building2, RefreshCw, Ticket, UserPlus, Users } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import { EstadoVazio } from '@/components/ui/estados';
import { OrganizationList } from './OrganizationList';
import { MembersList } from './MembersList';
import { ListaDeConvites } from './ListaDeConvites';
import { CriarConviteModal } from './CriarConviteModal';
import { AceitarConviteModal } from './AceitarConviteModal';
import { NovaOrganizacaoModal } from './NovaOrganizacaoModal';
import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';
import { useOrganizationPanel, type AuthenticatedFetch, type ListaDeOrganizacoes } from './useOrganizationPanel';

/** Como cada papel se chama na tela, e a cor que o acompanha. */
const PAPEL: Record<'owner' | 'admin' | 'member', { readonly rotulo: string; readonly cor: string }> = {
  owner: { rotulo: 'Dono', cor: 'var(--accent)' },
  admin: { rotulo: 'Administrador', cor: 'var(--info)' },
  member: { rotulo: 'Membro', cor: 'var(--txt2)' },
};

export interface OrganizationPanelProps {
  /** Authenticated fetch boundary (Supabase bearer token attached by the caller). */
  fetchWithAuth: AuthenticatedFetch;
  /**
   * O estado de organizações, criado uma única vez pelo topo da aplicação.
   *
   * O shell mostra e troca a organização ativa; se o painel
   * criasse o seu próprio estado, uma troca feita pelo topo deixaria esta aba
   * anunciando a organização anterior.
   */
  lista: ListaDeOrganizacoes;
  /**
   * Notified whenever the server-confirmed active organization changes, so
   * sibling panels (billing, integrations) can scope their own requests — and
   * so the screen's own authority over role can be invalidated at the switch.
   *
   * Carries the selection **version** alongside the id: switching away and back
   * are different selections, and only the version tells them apart.
   */
  onActiveOrgChange?: (selecao: SelecaoDeOrganizacao | null) => void;
}

/** Um dos números do topo. Ele só existe quando há uma leitura para resumir. */
function Resumo({ rotulo, valor, cor }: { rotulo: string; valor: number | null; cor: string }) {
  return (
    <div
      className="flex flex-col justify-between"
      style={{
        gap: 12,
        minHeight: 'var(--resumo-min)',
        padding: '12px 13px',
        borderRadius: 16,
        background: 'var(--glass2)',
        border: '1px solid var(--line)',
      }}
    >
      <span
        className="flex items-center"
        style={{ gap: 7, font: '400 10.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cor }} aria-hidden />
        {rotulo}
      </span>
      {/*
        O travessão não é enfeite: enquanto a leitura não vale, mostrar "0" ao
        lado de uma leitura que falhou ou que ainda não chegou seria o mesmo
        erro de confundir zero com "não sei", na posição mais visível da tela.
      */}
      <span className="orbita-numero" style={{ fontSize: 'var(--resumo-fs)', color: valor === null ? 'var(--txt3)' : cor }}>
        {valor === null ? '—' : valor}
      </span>
    </div>
  );
}

/** O título da tela e os três números que a resumem. */
function Cabecalho({
  totalDeOrganizacoes,
  totalDeMembros,
  convitesAguardando,
}: {
  totalDeOrganizacoes: number | null;
  totalDeMembros: number | null;
  convitesAguardando: number | null;
}) {
  return (
    <div className={`flex items-start gap-8 flex-none ${helpPageHeader}`}>
      <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
        <HelpContext ajudaId="org.visao">
          <h1
            className="m-0"
            style={{
              fontFamily: 'var(--font-space-grotesk), sans-serif',
              fontWeight: 500,
              fontSize: 'var(--titulo-fs)',
              lineHeight: 1.04,
              letterSpacing: '-0.03em',
              color: 'var(--txt)',
            }}
          >
            Organização &amp;<br />Membros
          </h1>
        </HelpContext>
        <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
          quem participa, e com qual autoridade
        </span>
      </div>

      <div className="flex-1 min-w-0 grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--resumo-gap)' }}>
        <Resumo rotulo="Suas organizações" valor={totalDeOrganizacoes} cor="var(--txt)" />
        <Resumo rotulo="Membros da organização ativa" valor={totalDeMembros} cor="var(--info)" />
        <Resumo rotulo="Convites aguardando" valor={convitesAguardando} cor="var(--warning)" />
      </div>
    </div>
  );
}

/**
 * A faixa que diz de quem é tudo o que vem abaixo.
 *
 * Nenhuma lista desta tela deve ser lida sem saber a que organização pertence,
 * e com qual papel quem olha está olhando. Esta faixa é o que torna isso
 * visível. É informação de interface, não autorização: o acesso é decidido
 * pelas rotas.
 */
function FaixaDeContexto({
  nome,
  papel,
}: {
  nome: string | null;
  papel: { readonly rotulo: string; readonly cor: string } | null;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 flex-none"
      style={{
        padding: '12px 16px',
        borderRadius: 16,
        background: 'var(--chip)',
        border: `1px solid ${nome ? 'var(--accent)' : 'var(--line)'}`,
      }}
    >
      <span className="flex items-center min-w-0" style={{ gap: 10 }}>
        <Building2 className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
        <span className="flex flex-col min-w-0" style={{ gap: 2 }}>
          <span className="orbita-eyebrow">Organização ativa</span>
          <span
            className="truncate"
            style={{ font: '600 14px/1.2 var(--font-archivo), sans-serif', color: nome ? 'var(--txt)' : 'var(--txt3)' }}
          >
            {nome ?? 'Nenhuma organização ativa'}
          </span>
        </span>
      </span>
      {papel && <Pilula rotulo={papel.rotulo} cor={papel.cor} />}
    </div>
  );
}

/** Uma coluna do corpo: cabeçalho com o escopo carimbado, e a lista embaixo. */
function Coluna({
  icone,
  titulo,
  escopo,
  children,
  ajuda,
}: {
  icone: ReactNode;
  titulo: string;
  /** De qual organização é o que está nesta coluna. Não é decoração. */
  escopo?: string;
  ajuda?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      // `overflow-hidden` é a última linha de defesa da coluna: o cartão tem
      // borda e fundo próprios, e conteúdo que passe da caixa desenharia por
      // cima do painel, fora do arredondamento. Ele nunca deveria ser
      // acionado — o corpo abaixo rola antes disso —, mas quando for, o que
      // some é o excesso, e não o formato da coluna.
      className="flex flex-col min-h-0 min-w-0 overflow-hidden"
      style={{ gap: 11, padding: 16, borderRadius: 20, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <header className="flex flex-col flex-none" style={{ gap: 3 }}>
        <div className="flex items-center gap-1">
        <h2
          className="flex items-center m-0"
          style={{ gap: 7, font: '600 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
        >
          {icone}
          {titulo}
        </h2>
        {ajuda}
        </div>
        {escopo && (
          <span className="orbita-eyebrow truncate" title={escopo}>
            {escopo}
          </span>
        )}
      </header>

      {/*
        O corpo da coluna, e o motivo de ele existir como elemento próprio.

        Antes o conteúdo era filho direto da `<section>`, sem `flex-1` nem
        `min-h-0`. Um item de flex não encolhe abaixo do próprio conteúdo, e o
        estado vazio (`EstadoVazio`, com `py-14` fixo) não encolhe de jeito
        nenhum: em altura reduzida ele passava da caixa e a borda dele saía
        desenhada por cima do painel, atravessando o cartão de Convites. A
        1366×720 sobravam **16px** — a tela não estava certa, estava por um fio.

        `flex-1 min-h-0` dá ao corpo a altura que sobra e a permissão de encolher
        até ela; `overflow-y-auto` garante que, quando o conteúdo ainda não
        couber, ele fique alcançável por rolagem em vez de ser cortado. As
        listas continuam com a rolagem interna delas — quem rola primeiro é
        sempre a lista, porque ela já sabe encolher.

        A correção é local, e é de propósito: `EstadoVazio` é o mesmo de Vendas,
        Estoque, Clientes e Financeiro, e mexer nele para consertar esta coluna
        mudaria cinco telas que não têm este problema.
      */}
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">{children}</div>
    </section>
  );
}

/**
 * Organização & Membros, na linguagem do produto novo.
 *
 * ## A regra que desenha esta tela
 *
 * Nunca apresentar dado ou autoridade de uma organização sob o contexto visual
 * de outra. Daí três decisões de composição que não são estéticas:
 *
 * - **a organização ativa é dita, com o papel real ao lado.** Não é um rodapé
 *   discreto: é a faixa que diz de quem é tudo o que vem abaixo;
 * - **cada coluna carimba o próprio escopo.** "Membros" e "Convites" repetem o
 *   nome da organização ativa no cabeçalho, porque é a lista *dela* que está
 *   ali — e se a seleção mudar, a lista some antes de qualquer resposta nova;
 * - **os três números só existem quando há leitura para resumi-los.** Um "0"
 *   ao lado de uma leitura que falhou mente na posição mais visível da tela.
 *
 * Os controles de gestão (criar convite, remover membro) aparecem por
 * `canManage`, que espelha `organizationCapabilitiesForRole`: owner e admin
 * administram, member não. Isso é aparência — a autorização de verdade fica no
 * servidor, que recusaria de novo, e a tela não é a última palavra sobre nada.
 */
export function OrganizationPanel({ fetchWithAuth, lista, onActiveOrgChange }: OrganizationPanelProps) {
  const painel = useOrganizationPanel(fetchWithAuth, lista, onActiveOrgChange);
  const [novaOrganizacaoAberta, setNovaOrganizacaoAberta] = useState(false);
  const [novoConviteAberto, setNovoConviteAberto] = useState(false);
  const [aceitarConviteAberto, setAceitarConviteAberto] = useState(false);
  const [codigoNaTela, setCodigoNaTela] = useState(false);

  const ativa = painel.activeOrg;
  const papel = ativa ? PAPEL[ativa.papel] : null;
  const nomeDaAtiva = ativa?.organizacao.nome ?? null;

  const convitesAguardando = painel.convites?.filter((convite) => convite.status === 'pending').length ?? null;
  // Um zero verdadeiro é um número, e aparece. O que não pode aparecer é o zero
  // de uma leitura que não chegou (`isLoading`) ou que falhou sem deixar lista
  // boa — aí o resumo mostra "—", e a própria lista abaixo diz qual dos dois foi.
  const houveLeituraDeOrganizacoes =
    !painel.isLoading && (painel.organizacoes.length > 0 || painel.erroDeOrganizacoes === null);
  const totalDeOrganizacoes = houveLeituraDeOrganizacoes ? painel.organizacoes.length : null;

  // A troca de organizacao fica suspensa em duas janelas, e pela mesma razao:
  // o token de um convite volta UMA vez e nao pode ser recuperado. Enquanto a
  // criacao esta em voo, a resposta chegaria sob outro contexto; enquanto o
  // codigo esta na tela, ele passaria a ser lido ao lado de outro tenant. Sao
  // segundos de espera para nao ter nem token perdido nem token no lugar errado.
  const motivoParaNaoTrocar = painel.criacaoDeConviteEmVoo
    ? 'Aguarde a criacao do convite terminar para trocar de organizacao.'
    : codigoNaTela
      ? 'Feche o codigo do convite antes de trocar de organizacao — ele nao volta a aparecer.'
      : null;

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ gap: 'var(--conteudo-gap)' }}>
      <Cabecalho
        totalDeOrganizacoes={totalDeOrganizacoes}
        totalDeMembros={painel.membros?.length ?? null}
        convitesAguardando={convitesAguardando}
      />

      <FaixaDeContexto nome={nomeDaAtiva} papel={papel} />

      <div className="orbita-acoes flex-none flex-wrap">
        <button type="button" onClick={() => setAceitarConviteAberto(true)} className="orbita-chip cursor-pointer">
          <Ticket className="w-4 h-4" />
          Aceitar convite
        </button>
        <button
          type="button"
          onClick={() => { void painel.loadOrganizacoes(); void painel.recarregarMembros(); void painel.recarregarConvites(); }}
          className="orbita-chip cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          Atualizar
        </button>
        {painel.canManage && (
          <button
            type="button"
            onClick={() => setNovoConviteAberto(true)}
            className="orbita-acao"
            style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            <UserPlus className="w-4 h-4" />
            Criar convite
          </button>
        )}
        <button type="button" onClick={() => setNovaOrganizacaoAberta(true)} className="orbita-acao">
          <Building2 className="w-4 h-4" />
          Nova organização
        </button>
      </div>

      <div
        className="flex-1 min-h-0 grid"
        style={{ gridTemplateColumns: painel.canManage ? 'repeat(3, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))', gap: 12 }}
      >
        <Coluna icone={<Building2 className="w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />} titulo="Suas organizações" ajuda={<HelpInfo ajudaId="org.troca" />}>
          <OrganizationList
            organizacoes={painel.organizacoes}
            activeOrgId={ativa?.organizacao.id ?? null}
            switchingOrgId={painel.switchingOrgId}
            motivoParaNaoTrocar={motivoParaNaoTrocar}
            carregando={painel.isLoading}
            erroDeLeitura={painel.erroDeOrganizacoes}
            onSwitch={painel.handleSwitchOrganization}
            onRecarregar={() => { void painel.loadOrganizacoes(); }}
          />
        </Coluna>

        <Coluna
          icone={<Users className="w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />}
          titulo="Membros"
          ajuda={<HelpInfo ajudaId="org.membros" />}
          escopo={nomeDaAtiva ?? undefined}
        >
          {ativa ? (
            <MembersList
              membros={painel.membros}
              carregando={painel.membrosCarregando}
              erroDeLeitura={painel.erroDeMembros}
              erroDeAcao={painel.erroAoRemoverMembro}
              canManage={painel.canManage}
              onRemove={painel.handleRemoveMember}
              onRecarregar={() => { void painel.recarregarMembros(); }}
            />
          ) : (
            <EstadoVazio
              titulo="Nenhuma organização ativa"
              descricao="Torne uma organização ativa para ver quem participa dela."
            />
          )}
        </Coluna>

        {painel.canManage && (
          <Coluna
            icone={<Ticket className="w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />}
            titulo="Convites"
            ajuda={<HelpInfo ajudaId="org.convites" />}
            escopo={nomeDaAtiva ?? undefined}
          >
            <ListaDeConvites
              convites={painel.convites}
              carregando={painel.convitesCarregando}
              erroDeLeitura={painel.erroDeConvites}
              onRecarregar={() => { void painel.recarregarConvites(); }}
            />
          </Coluna>
        )}
      </div>

      <NovaOrganizacaoModal
        aberto={novaOrganizacaoAberta}
        onAbertoChange={setNovaOrganizacaoAberta}
        onCriar={painel.handleCreateOrganization}
        erro={painel.erroDeOrganizacoes}
      />
      <CriarConviteModal
        aberto={novoConviteAberto}
        onAbertoChange={setNovoConviteAberto}
        onCriar={painel.handleInvite}
        erro={painel.erroAoCriarConvite}
        organizacaoNome={nomeDaAtiva}
        onCodigoNaTela={setCodigoNaTela}
      />
      <AceitarConviteModal
        aberto={aceitarConviteAberto}
        onAbertoChange={setAceitarConviteAberto}
        onAceitar={painel.handleAcceptInvite}
        erro={painel.erroAoAceitarConvite}
      />
    </div>
  );
}
