'use client';

import type { ReactNode } from 'react';

import { Modal } from '@/components/ui/modal';
import { DrawerDoPedido } from '@/components/vendas/DrawerDoPedido';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { Pilula } from '@/components/ui/StatusPill';
import { APARENCIA_DA_SITUACAO, ehTerminal, formatarVencimento, tituloVisivel } from './Movimentacoes';
import type { TituloFinanceiro } from './useLeituraFinanceira';

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
 */

function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      <span className="orbita-eyebrow">{rotulo}</span>
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
}: {
  titulo: TituloFinanceiro | null;
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  formatarDinheiro: (valor: number) => string;
}) {
  if (titulo === null) return null;

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
      descricao={`Detalhe da movimentação financeira de ${formatarDinheiro(titulo.valor)}`}
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
          <Campo rotulo="Pagamento">
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
}: {
  titulo: TituloFinanceiro | null;
  pedidoLocal: PedidoEnriquecido | null;
  onFechar: () => void;
  formatarDinheiro: (valor: number) => string;
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
      />
    </>
  );
}
