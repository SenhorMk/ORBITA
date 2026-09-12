'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';

/**
 * O cancelamento de um pedido.
 *
 * A lógica veio de `TransactionList`: ler as situações do Bling, achar a de
 * cancelamento e chamar `POST /api/pedidos/status`. Inclusive a conferência da
 * forma da resposta — a rota devolve lista no sucesso e `{ error }` na falha, e
 * presumir lista virava "(intermediate value).find is not a function", uma
 * mensagem que não diz nada sobre a causa.
 *
 * ## O `window.location.reload()` saiu
 *
 * Ele veio junto na herança e era o defeito: cancelar um pedido recarregava a
 * aplicação inteira. Com isso voltavam o `page.tsx`, o shell, a resolução da
 * organização ativa, o `StartupLoader` e todas as leituras — e quando a
 * inicialização do ERP não concluía, quem só quis cancelar um pedido terminava
 * olhando "Erro na Inicialização" e caindo em modo offline. Um recarregamento
 * de página não é atualizar uma lista: é reiniciar o produto para trocar uma
 * linha de uma tabela.
 *
 * Agora o cancelamento avisa quem chamou (`onCancelado`), e quem chamou relê o
 * que já sabe reler. Nenhuma navegação, nenhum reload, nenhuma inicialização
 * refeita — o estado da sessão e da organização continua exatamente onde estava.
 */
export function CancelamentoDePedido({
  pedido,
  onFechar,
  onCancelado,
}: {
  pedido: PedidoEnriquecido | null;
  onFechar: () => void;
  /**
   * O cancelamento foi confirmado pelo servidor.
   *
   * Quem recebe decide o que reler — em Vendas & Pedidos é o `onRecarregar` que
   * a tela já tinha. Opcional porque o `DrawerDoPedido` monta este mesmo
   * diálogo por outro caminho, e um fluxo sem releitura é melhor que um fluxo
   * que recarrega a aplicação.
   */
  onCancelado?: () => void;
}) {
  const [cancelando, setCancelando] = useState(false);

  const confirmar = async () => {
    if (!pedido) return;
    setCancelando(true);
    try {
      const sitRes = await fetchWithAuth('/api/bling/situacoes');
      const sitCorpo: unknown = await sitRes.json();

      if (!sitRes.ok || !Array.isArray(sitCorpo)) {
        const motivo = typeof sitCorpo === 'object' && sitCorpo !== null && 'error' in sitCorpo
          ? String((sitCorpo as { error: unknown }).error)
          : `HTTP ${sitRes.status}`;
        throw new Error(`Não foi possível ler as situações do Bling: ${motivo}`);
      }

      const situacoes = sitCorpo as Array<{ id: number; nome: string }>;
      const situacaoCancelado = situacoes.find(
        (s) => s.nome.toLowerCase() === 'cancelado' || s.nome.toLowerCase() === 'cancelada',
      );

      if (!situacaoCancelado) {
        throw new Error('Situação "Cancelado" não encontrada no Bling.');
      }

      const cancelRes = await fetchWithAuth('/api/pedidos/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pedidoId: pedido.id,
          novaSituacaoId: situacaoCancelado.id,
          novaSituacaoNome: situacaoCancelado.nome,
        }),
      });

      const cancelData = await cancelRes.json();
      if (!cancelRes.ok) throw new Error(cancelData.error || 'Falha ao cancelar');

      alert('Pedido cancelado e estoque alinhado com sucesso!');
      // Releitura, não recarregamento: a pessoa continua na aba Vendas &
      // Pedidos, com a mesma sessão e a mesma organização ativa.
      onCancelado?.();
    } catch (err: unknown) {
      alert(`Erro: ${descreverErro(err)}`);
    } finally {
      setCancelando(false);
      onFechar();
    }
  };

  return (
    <Modal
      aberto={pedido !== null}
      onAbertoChange={(aberto) => {
        if (!aberto && !cancelando) onFechar();
      }}
      tamanho="sm"
      destrutivo
      eyebrow="Ação irreversível"
      titulo={`Cancelar o pedido #${pedido?.numero ?? ''}?`}
      descricao="Confirmação de cancelamento de pedido."
      rodape={
        <RodapeDeModal
          secundaria={
            <button
              type="button"
              onClick={onFechar}
              disabled={cancelando}
              className="orbita-chip cursor-pointer"
            >
              Voltar
            </button>
          }
          primaria={
            <button
              type="button"
              onClick={confirmar}
              disabled={cancelando}
              className="orbita-chip cursor-pointer"
              style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
            >
              {cancelando && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {cancelando ? 'Processando…' : 'Cancelar pedido'}
            </button>
          }
        />
      }
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--txt2)' }}>
        O cancelamento é propagado ao Bling e o estoque é realinhado de acordo com as regras do ERP.
        O pedido continua no histórico do Orbita, e deixa de contar como venda.
      </p>
    </Modal>
  );
}
