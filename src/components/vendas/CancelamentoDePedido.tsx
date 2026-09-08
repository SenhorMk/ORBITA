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
 * A lógica veio inteira de `TransactionList`, sem alteração: ler as situações do
 * Bling, achar a de cancelamento, chamar `POST /api/pedidos/status` e recarregar
 * a tela. Inclusive a conferência da forma da resposta — a rota devolve lista no
 * sucesso e `{ error }` na falha, e presumir lista virava
 * "(intermediate value).find is not a function", uma mensagem que não diz nada
 * sobre a causa.
 *
 * O que mudou é a casca: agora é o `Modal sm` destrutivo do Design System, com a
 * ação de cancelar sozinha à esquerda, longe de "Voltar".
 */
export function CancelamentoDePedido({
  pedido,
  onFechar,
}: {
  pedido: PedidoEnriquecido | null;
  onFechar: () => void;
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
      window.location.reload();
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
