'use client';

import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  Bot,
  CheckCircle,
  ClipboardList,
  Hand,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Undo2,
  UserRound,
  UsersRound,
} from 'lucide-react';

import type { ChatwootConversation } from '@/types';
import { Avatar } from './Avatar';
import { AssumirAtendimento, EstadoDoAtendimento, type Atendimento } from './BarraDoAtendimento';
import type { AbaDoPainel } from './PainelLateral';
import type { Mensageria } from './useMensageria';
import estilos from './mensageria.module.css';
import { estaResolvida, rotuloDoStatus } from './statusDaConversa';

/**
 * O canal da conversa, só quando o espelho o trouxe. O nome conhecido é
 * traduzido; o desconhecido aparece como veio, sem o prefixo do Chatwoot.
 */
export function rotuloDoCanal(canal: string | null | undefined): string | null {
  const bruto = canal?.trim();
  if (!bruto) return null;
  const nome = bruto.replace(/^Channel::/u, '');
  if (/^web_?widget$/iu.test(nome)) return 'WebWidget';
  if (/^whatsapp$/iu.test(nome)) return 'WhatsApp';
  return nome;
}

function ItemDoMenu({ icone, children, aoEscolher, desativado = false }: {
  readonly icone: React.ReactNode;
  readonly children: React.ReactNode;
  readonly aoEscolher: () => void;
  readonly desativado?: boolean;
}) {
  return (
    <Menu.Item className={estilos.menuItem} onSelect={aoEscolher} disabled={desativado}>
      {icone}
      {children}
    </Menu.Item>
  );
}

/**
 * As ações da conversa, num lugar só, conforme o que existe agora e o que o
 * servidor permite: resolver ou reabrir, recarregar, e as ferramentas, que
 * abrem no painel lateral. O que só o servidor pode decidir (devolver, pedir
 * atendente) só aparece quando ele disse que pode.
 */
function MenuDaConversa({ mensageria, selecionada, atendimento, abrirPainel }: {
  readonly mensageria: Mensageria;
  readonly selecionada: ChatwootConversation;
  readonly atendimento: Atendimento;
  readonly abrirPainel: (aba: AbaDoPainel) => void;
}) {
  const icone = 'w-4 h-4';
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className={estilos.botaoIcone} aria-label="Mais ações da conversa">
          <MoreHorizontal className="w-4 h-4" aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} collisionPadding={12} className={estilos.menu}>
          <Menu.Label className={estilos.menuGrupo}>Conversa</Menu.Label>
          <ItemDoMenu
            icone={!estaResolvida(selecionada.status) ? <CheckCircle className={icone} aria-hidden /> : <RotateCcw className={icone} aria-hidden />}
            aoEscolher={mensageria.alternarStatus}
            desativado={mensageria.alterandoStatus}
          >
            {mensageria.alterandoStatus ? 'Alterando…' : !estaResolvida(selecionada.status) ? 'Marcar resolvida' : 'Reabrir conversa'}
          </ItemDoMenu>
          <ItemDoMenu icone={<RefreshCw className={icone} aria-hidden />} aoEscolher={() => { mensageria.recarregarHistorico(); void atendimento.recarregar(); }}>
            Atualizar conversa
          </ItemDoMenu>

          <Menu.Separator className={estilos.menuSeparador} />
          <Menu.Label className={estilos.menuGrupo}>Atendimento</Menu.Label>
          {atendimento.podePedirAtendente && (
            <ItemDoMenu icone={<Hand className={icone} aria-hidden />} aoEscolher={atendimento.pedirAtendente} desativado={atendimento.agindo}>
              Pedir atendente
            </ItemDoMenu>
          )}
          {atendimento.podeDevolver && (
            <ItemDoMenu
              icone={<Undo2 className={icone} aria-hidden />}
              desativado={atendimento.agindo}
              aoEscolher={() => {
                if (atendimento.resumo === null) atendimento.escreverResumo('');
                abrirPainel('atendimento');
              }}
            >
              Devolver à automação…
            </ItemDoMenu>
          )}
          <ItemDoMenu icone={<UsersRound className={icone} aria-hidden />} aoEscolher={() => abrirPainel('atendimento')}>
            Detalhes do atendimento
          </ItemDoMenu>

          <Menu.Separator className={estilos.menuSeparador} />
          <Menu.Label className={estilos.menuGrupo}>Ferramentas</Menu.Label>
          <ItemDoMenu icone={<Bot className={icone} aria-hidden />} aoEscolher={() => abrirPainel('triagem')}>
            Triagem da IA
          </ItemDoMenu>
          <ItemDoMenu icone={<Sparkles className={icone} aria-hidden />} aoEscolher={() => abrirPainel('resposta')}>
            Resposta sugerida
          </ItemDoMenu>
          <ItemDoMenu icone={<UserRound className={icone} aria-hidden />} aoEscolher={() => abrirPainel('cliente')}>
            Identidade do cliente
          </ItemDoMenu>
          <ItemDoMenu icone={<ClipboardList className={icone} aria-hidden />} aoEscolher={() => abrirPainel('cliente')}>
            Pedidos e informações comerciais
          </ItemDoMenu>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * O cabeçalho da conversa aberta: quem é, por qual canal (quando se sabe),
 * quem atende agora, assumir quando cabe, e o menu ⋯ com o resto.
 */
export function CabecalhoDaConversa({ mensageria, selecionada, atendimento, abrirPainel, aoVoltar }: {
  readonly mensageria: Mensageria;
  readonly selecionada: ChatwootConversation;
  readonly atendimento: Atendimento;
  readonly abrirPainel: (aba: AbaDoPainel) => void;
  /** Só no celular: volta para a lista sem fechar a conversa. */
  readonly aoVoltar: (() => void) | null;
}) {
  const canal = rotuloDoCanal(selecionada.channel);
  const contato = selecionada.contact?.phone_number || selecionada.contact?.email || 'Sem telefone';
  const aoVivo = mensageria.tempoRealDeMensagens;
  return (
    <header className={estilos.cabecalho}>
      {aoVoltar !== null && (
        <button type="button" onClick={aoVoltar} className={estilos.botaoIcone} aria-label="Voltar para as conversas">
          <ArrowLeft className="w-4 h-4" aria-hidden />
        </button>
      )}
      <div className={estilos.contato}>
        <Avatar nome={selecionada.contact?.name} tamanho={36} />
        <div className={estilos.contatoTexto}>
          <h2 className={estilos.contatoNome}>{selecionada.contact?.name || 'Contato sem nome'}</h2>
          <p className={estilos.contatoMeta} style={{ margin: 0 }}>
            <span>{contato}</span>
            {canal !== null && (
              <>
                <span className={estilos.separadorMeta} aria-hidden />
                <span>{canal}</span>
              </>
            )}
            <span className={estilos.separadorMeta} aria-hidden />
            <span>{rotuloDoStatus(selecionada.status)}</span>
            <span className={estilos.separadorMeta} aria-hidden />
            <span className={estilos.aoVivo} title={aoVivo ? 'O histórico se atualiza sozinho.' : 'Sem tempo real: use Atualizar conversa no menu.'}>
              <span className={estilos.ponto} style={{ background: aoVivo ? 'var(--accent)' : 'var(--txt3)' }} aria-hidden />
              {aoVivo ? 'Ao vivo' : 'Sem tempo real'}
            </span>
          </p>
        </div>
      </div>
      <div className={estilos.acoesDoCabecalho}>
        <EstadoDoAtendimento atendimento={atendimento} />
        <AssumirAtendimento atendimento={atendimento} />
        <MenuDaConversa mensageria={mensageria} selecionada={selecionada} atendimento={atendimento} abrirPainel={abrirPainel} />
      </div>
    </header>
  );
}
