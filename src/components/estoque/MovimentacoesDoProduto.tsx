'use client';

import { useEffect, useState } from 'react';

import { fetchWithAuth } from '@/lib/fetchWithAuth';

interface Movimentacao {
  id: string;
  tipo: 'ENTRADA' | 'SAIDA';
  origem: string | null;
  quantidade: number;
  created_at: string;
}

type Estado =
  | { _tag: 'Carregando' }
  | { _tag: 'Falhou' }
  | { _tag: 'Carregadas'; movimentacoes: Movimentacao[] };

/** O nome de cada origem gravada pelo banco, na língua de quem opera a loja. */
const ROTULO_DA_ORIGEM: Record<string, string> = {
  BAIXA_ORGANIZACAO_VERIFICADA: 'Baixa por venda',
  ALINHAMENTO_SITUACAO_BLING: 'Alinhamento com o Bling',
};

function rotuloDaOrigem(origem: string | null): string {
  if (origem === null) return 'Movimentação';
  return ROTULO_DA_ORIGEM[origem] ?? origem;
}

/** Histórico de estoque do produto, só leitura: o que o ORBITA registrou, mais recente primeiro. */
export function MovimentacoesDoProduto({ produtoId }: { produtoId: string }) {
  const [estado, setEstado] = useState<Estado>({ _tag: 'Carregando' });

  useEffect(() => {
    let montado = true;
    void (async () => {
      try {
        const resposta = await fetchWithAuth(`/api/produtos/movimentacoes?produto=${encodeURIComponent(produtoId)}`);
        const corpo = (await resposta.json()) as { success?: boolean; movimentacoes?: Movimentacao[] };
        if (!montado) return;
        setEstado(
          resposta.ok && corpo.success && Array.isArray(corpo.movimentacoes)
            ? { _tag: 'Carregadas', movimentacoes: corpo.movimentacoes }
            : { _tag: 'Falhou' },
        );
      } catch {
        if (montado) setEstado({ _tag: 'Falhou' });
      }
    })();
    return () => {
      montado = false;
    };
  }, [produtoId]);

  if (estado._tag === 'Carregando') {
    return <p className="text-[12px]" style={{ color: 'var(--txt3)' }}>Carregando movimentações…</p>;
  }
  if (estado._tag === 'Falhou') {
    return (
      <p role="alert" className="text-[12px]" style={{ color: 'var(--warning)' }}>
        Não foi possível ler as movimentações de estoque agora.
      </p>
    );
  }
  if (estado.movimentacoes.length === 0) {
    return (
      <p className="text-[12px]" style={{ color: 'var(--txt3)' }}>
        Nenhuma movimentação registrada no ORBITA para este produto.
      </p>
    );
  }

  return (
    <ul aria-label="Movimentações de estoque" className="flex flex-col gap-1.5">
      {estado.movimentacoes.map((m) => (
        <li key={m.id} className="flex items-center justify-between gap-3 text-[12px]">
          <span style={{ color: 'var(--txt2)' }}>
            {new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            {' · '}
            {rotuloDaOrigem(m.origem)}
          </span>
          <span
            className="font-mono tabular-nums"
            style={{ color: m.tipo === 'SAIDA' ? 'var(--danger)' : 'var(--accent)' }}
          >
            {m.tipo === 'SAIDA' ? '−' : '+'}
            {m.quantidade} un
          </span>
        </li>
      ))}
    </ul>
  );
}
