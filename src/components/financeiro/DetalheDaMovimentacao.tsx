'use client';

import { useState, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { mensagemDaCorrecao, type DesfechoDaCorrecao } from '@/lib/config/correcaoOperacionalContract';
import { DrawerDoPedido } from '@/components/vendas/DrawerDoPedido';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { Pilula } from '@/components/ui/StatusPill';
import { APARENCIA_DA_SITUACAO, ehTerminal, formatarVencimento, tituloVisivel } from './Movimentacoes';
import type { TituloFinanceiro } from './useLeituraFinanceira';
import { HelpInfo } from '@/components/help/HelpInfo';
import { HelpContext } from '@/components/help/HelpContext';

/**
 * O detalhe de uma movimentação que **não** é um pedido.
 *
 * O detalhe de uma entrada vinculada a pedido não mora aqui: ele é o
 * `DrawerDoPedido` de Vendas & Pedidos, o mesmo componente, com o mesmo fetch e
 * a mesma transformação — abrir Financeiro → entrada → Detalhes tem de mostrar
 * a mesma representação do pedido que a outra tela mostra, e uma segunda
 * implementação disso seria uma segunda verdade. Quem decide entre os dois é
 * `FinanceiroTab`, pelo vínculo estrutural `pedido_id`, e não pelo texto da
 * descrição.
 *
 * Aqui ficam as saídas e os títulos importados que não pertencem a pedido
 * nenhum. O que é mostrado é o que existe:
 *
 * - `Título` e `Descrição` são campos distintos desde a migration 62. Num
 *   registro anterior a ela o `titulo` é nulo, e a linha do título exibe a
 *   descrição — o campo Descrição então some, em vez de repetir a mesma frase
 *   duas vezes fingindo dois dados.
 * - `Fornecedor` só aparece quando a despesa registrou um. Toda despesa
 *   lançada antes da migration 62 não registrou, e dizer "Fornecedor Diverso"
 *   por padrão seria inventar de quem era a saída.
 * - `Origem` distingue o que foi lançado no Bling do que é interno do ORBITA,
 *   pela ausência de `bling_id` — o mesmo critério que o lançamento usa.
 *
 * ## Correção de uma saída lançada por engano
 *
 * As ações moram aqui, no detalhe, e não em cada linha da tabela:
 *
 * - saída **interna** → "Excluir lançamento" (remoção definitiva);
 * - saída **do Bling**, aberta aqui → "Cancelar despesa". O servidor lê a
 *   situação real no Bling antes de agir; o que esta tela sabe é só um palpite
 *   de apresentação;
 * - saída do Bling **paga** → nenhuma ação: o estorno automático não é
 *   suportado com segurança, e a tela diz isso;
 * - cancelada ou estornada, ou pertencente a um pedido → nenhuma ação.
 *
 * A confirmação troca o corpo do mesmo modal. Só um desfecho que encerra
 * (`Deleted`, `Cancelled`, `AlreadyTerminal`, `NotFound`) fecha o detalhe e
 * relê o Financeiro; os outros ficam aqui, com a frase do contrato.
 */

type AcaoDeCorrecao = 'excluir' | 'cancelar';

/** Que ação esta saída oferece, pelos mesmos critérios estruturais do servidor. */
function acaoDisponivel(titulo: TituloFinanceiro): AcaoDeCorrecao | 'pago_no_bling' | null {
  if (titulo.tipo !== 'pagar' || titulo.pedido_id || ehTerminal(titulo.situacao)) return null;
  if (!(Number(titulo.bling_id) > 0)) return 'excluir';
  return titulo.situacao === 'pago' ? 'pago_no_bling' : 'cancelar';
}

const TEXTO_DA_CONFIRMACAO: Record<AcaoDeCorrecao, { titulo: string; corpo: string; botao: string }> = {
  excluir: {
    titulo: 'Excluir este lançamento?',
    corpo: 'Esta despesa existe apenas no ORBITA. Ao excluir, o lançamento será removido definitivamente.',
    botao: 'Excluir lançamento',
  },
  cancelar: {
    titulo: 'Cancelar esta despesa?',
    corpo: 'Esta despesa também existe no Bling. O ORBITA verificará a situação atual e, se ela estiver aberta, '
      + 'removerá a conta no Bling e manterá o lançamento no histórico como cancelado.',
    botao: 'Cancelar despesa',
  },
};

const DESFECHOS_QUE_ENCERRAM = new Set(['Deleted', 'Cancelled', 'AlreadyTerminal', 'NotFound']);

function Aviso({ children, alerta = false }: { children: ReactNode; alerta?: boolean }) {
  return (
    <p
      role={alerta ? 'alert' : undefined}
      className="m-0 px-4 py-2.5 text-xs"
      style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
    >
      {children}
    </p>
  );
}

function Campo({ rotulo, children, ajuda }: { rotulo: string; children: ReactNode; ajuda?: ReactNode }) {
  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      <div className="flex items-center gap-1 min-h-8"><span className="orbita-eyebrow">{rotulo}</span>{ajuda}</div>
      <span style={{ font: '400 13px/1.45 var(--font-archivo), sans-serif', color: 'var(--txt)' }}>
        {children}
      </span>
    </div>
  );
}

function DetalheDeMovimentacaoAvulsa({
  titulo,
  aberto,
  onAbertoChange,
  formatarDinheiro,
  onCorrigir,
  onCorrigido,
}: {
  titulo: TituloFinanceiro | null;
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  formatarDinheiro: (valor: number) => string;
  onCorrigir?: (acao: AcaoDeCorrecao, tituloId: string) => Promise<DesfechoDaCorrecao>;
  onCorrigido?: () => void;
}) {
  /** A confirmação pertence a UM título: abrir outro volta ao detalhe. */
  const [confirmando, setConfirmando] = useState<{ readonly id: string; readonly acao: AcaoDeCorrecao } | null>(null);
  const [processando, setProcessando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  if (titulo === null) return null;

  const acao = onCorrigir && titulo.id ? acaoDisponivel(titulo) : null;
  const emConfirmacao = confirmando !== null && confirmando.id === titulo.id ? confirmando.acao : null;

  const voltar = () => {
    if (processando) return;
    setConfirmando(null);
    setAviso(null);
  };

  const confirmar = async () => {
    if (!emConfirmacao || !onCorrigir || !titulo.id || processando) return;
    setProcessando(true);
    setAviso(null);
    const desfecho = await onCorrigir(emConfirmacao, titulo.id);
    setProcessando(false);
    if (DESFECHOS_QUE_ENCERRAM.has(desfecho.resultado)) {
      setConfirmando(null);
      onCorrigido?.();
      return;
    }
    setAviso(mensagemDaCorrecao(desfecho));
  };

  if (emConfirmacao) {
    const texto = TEXTO_DA_CONFIRMACAO[emConfirmacao];
    return (
      <Modal
        aberto={aberto}
        onAbertoChange={(valor) => { if (!valor && !processando) { voltar(); onAbertoChange(false); } }}
        tamanho="sm"
        destrutivo
        dispensavel={!processando}
        eyebrow="Correção de lançamento"
        titulo={texto.titulo}
        ajuda={<HelpInfo ajudaId="financeiro.correcao" />}
        descricao={texto.corpo}
        rodape={
          <RodapeDeModal
            secundaria={
              <button type="button" onClick={voltar} disabled={processando} className="orbita-chip cursor-pointer">
                Voltar
              </button>
            }
            primaria={
              <button
                type="button"
                onClick={() => { void confirmar(); }}
                disabled={processando}
                aria-busy={processando}
                className="orbita-chip cursor-pointer"
                style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
              >
                {processando && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {processando ? 'Processando…' : texto.botao}
              </button>
            }
          />
        }
      >
        <div className="flex flex-col" style={{ gap: 12 }}>
          <p className="m-0 text-sm leading-relaxed" style={{ color: 'var(--txt2)' }}>{texto.corpo}</p>
          <p className="m-0 text-sm" style={{ color: 'var(--txt)' }}>
            {tituloVisivel(titulo)} · {formatarDinheiro(titulo.valor)}
          </p>
          {aviso && <Aviso alerta>{aviso}</Aviso>}
        </div>
      </Modal>
    );
  }

  const entrada = titulo.tipo === 'receber';
  const terminal = ehTerminal(titulo.situacao);
  const situacao = APARENCIA_DA_SITUACAO[titulo.situacao] ?? { rotulo: titulo.situacao, cor: 'var(--txt2)' };
  const nome = tituloVisivel(titulo);
  /** Só é descrição própria quando existe um `titulo` para ela não repetir. */
  const descricaoPropria = (titulo.titulo ?? '').trim() !== '' ? titulo.descricao : null;
  const noBling = Number(titulo.bling_id) > 0;

  return (
    <Modal
      aberto={aberto}
      onAbertoChange={onAbertoChange}
      tamanho="drawer"
      eyebrow={entrada ? 'Entrada' : 'Saída'}
      titulo={nome}
      ajuda={<HelpInfo ajudaId="financeiro.detalhe" />}
      descricao={`Detalhe da movimentação financeira de ${formatarDinheiro(titulo.valor)}`}
      rodape={acao === 'excluir' || acao === 'cancelar' ? (
        <RodapeDeModal
          destrutiva={
            <HelpContext ajudaId="financeiro.correcao"><button
              type="button"
              onClick={() => { setAviso(null); setConfirmando({ id: titulo.id, acao }); }}
              className="orbita-chip cursor-pointer"
              style={{ color: 'var(--danger)' }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {TEXTO_DA_CONFIRMACAO[acao].botao}
            </button></HelpContext>
          }
        />
      ) : undefined}
    >
      <div className="flex flex-col" style={{ gap: 18 }}>
        <div className="flex items-center" style={{ gap: 12 }}>
          <span
            className="orbita-numero"
            style={{
              fontSize: 30,
              color: terminal ? 'var(--txt3)' : entrada ? 'var(--accent)' : 'var(--txt)',
              textDecoration: terminal ? 'line-through' : undefined,
            }}
          >
            {entrada ? '+' : '-'}{formatarDinheiro(titulo.valor)}
          </span>
          <Pilula rotulo={situacao.rotulo} cor={situacao.cor} />
        </div>

        {acao === 'pago_no_bling' && (
          <Aviso>
            Esta despesa já foi paga no Bling. O estorno automático ainda não está disponível com segurança.
          </Aviso>
        )}

        {terminal && (
          <p
            className="m-0 px-4 py-2.5 text-xs"
            style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
          >
            Esta movimentação está em um estado terminal: ela continua no histórico e
            <strong style={{ color: 'var(--txt)' }}> não entra</strong> nos totais nem no fluxo de caixa.
          </p>
        )}

        <div className="grid grid-cols-2" style={{ gap: 16 }}>
          <Campo rotulo="Vencimento">{formatarVencimento(titulo.data_vencimento)}</Campo>
          <Campo rotulo="Pagamento" ajuda={<HelpInfo ajudaId="financeiro.baixa" />}>
            {titulo.data_pagamento ? formatarVencimento(titulo.data_pagamento) : '—'}
          </Campo>
          <Campo rotulo="Categoria">{titulo.categoria?.descricao || 'Sem categoria'}</Campo>
          <Campo rotulo="Origem">{noBling ? `Bling · ${titulo.bling_id}` : 'Interno (Orbita)'}</Campo>
        </div>

        {descricaoPropria && <Campo rotulo="Descrição">{descricaoPropria}</Campo>}

        {/*
          Uma entrada deveria ter nascido de um pedido. Quando o vínculo não
          existe, isso é dito — em vez de a linha simplesmente não aparecer, o
          que faria a ausência passar por "não se aplica". O vínculo é
          preenchido pela sincronização, a partir de `origem.id` da conta a
          receber; contas anteriores a ele ficam sem, e ninguém adivinha qual
          pedido era.
        */}
        {entrada && (
          <Campo rotulo="Pedido de origem">
            <span style={{ color: 'var(--txt3)' }}>Pedido de origem não vinculado.</span>
          </Campo>
        )}

        {titulo.fornecedor_bling_id ? (
          <Campo rotulo="Fornecedor">
            {titulo.fornecedor_nome || 'Contato sem nome registrado'}
            <span style={{ font: '400 11px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
              {' '}· contato {titulo.fornecedor_bling_id}
            </span>
          </Campo>
        ) : (
          <Campo rotulo="Fornecedor">
            <span style={{ color: 'var(--txt3)' }}>
              Não registrado nesta movimentação.
            </span>
          </Campo>
        )}
      </div>
    </Modal>
  );
}

/**
 * A porta única do detalhe: um título ou outro, nunca os dois.
 *
 * A escolha é pelo vínculo estrutural `pedido_id` (migration 61), que o
 * `select('*')` de `GET /api/financeiro` já traz, casado com os pedidos que o
 * painel leu. Não se olha o texto da descrição: foi exatamente isso —
 * `Venda manual <id>` dentro de `descricao` — que a migration 61 existiu para
 * substituir por um relacionamento de verdade.
 *
 * Vinculado a pedido, inclusive quando a origem é venda manual (que já produz
 * um pedido canônico), abre o `DrawerDoPedido` de Vendas & Pedidos: o mesmo
 * componente, o mesmo fetch, a mesma apresentação — em `somenteLeitura`. Daqui
 * o pedido é leitura: nem cancelar, nem emitir NF-e, nem editar.
 */
export function DetalhesDaMovimentacao({
  titulo,
  pedidoLocal,
  onFechar,
  formatarDinheiro,
  onCorrigir,
  onCorrigido,
}: {
  titulo: TituloFinanceiro | null;
  pedidoLocal: PedidoEnriquecido | null;
  onFechar: () => void;
  formatarDinheiro: (valor: number) => string;
  /** Pede ao servidor a correção; só o id local do título vai junto. */
  onCorrigir?: (acao: 'excluir' | 'cancelar', tituloId: string) => Promise<DesfechoDaCorrecao>;
  /** O servidor encerrou o lançamento: feche e releia o Financeiro. */
  onCorrigido?: () => void;
}) {
  // O pedido é o que o painel já leu e casou com `pedido_id`. Quando o título
  // aponta para um pedido que não está na leitura corrente, não há o que abrir
  // do lado de Vendas — e a movimentação abre o próprio detalhe, com o que
  // existe, em vez de um drawer vazio.
  const abrePedido = titulo !== null && pedidoLocal !== null;

  return (
    <>
      <DrawerDoPedido
        aberto={abrePedido}
        onAbertoChange={(aberto) => { if (!aberto) onFechar(); }}
        pedidoBlingId={pedidoLocal?.bling_id ?? null}
        pedidoLocal={pedidoLocal}
        somenteLeitura
      />

      <DetalheDeMovimentacaoAvulsa
        titulo={abrePedido ? null : titulo}
        aberto={!abrePedido && titulo !== null}
        onAbertoChange={(aberto) => { if (!aberto) onFechar(); }}
        formatarDinheiro={formatarDinheiro}
        onCorrigir={onCorrigir}
        onCorrigido={onCorrigido}
      />
    </>
  );
}
