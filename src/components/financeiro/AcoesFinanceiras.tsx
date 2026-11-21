'use client';

import { AlertTriangle, Plus, RefreshCw } from 'lucide-react';
import { HelpContext } from '@/components/help/HelpContext';

/**
 * As duas ações do Financeiro: sincronizar e lançar uma saída.
 *
 * São as mesmas de antes, com os mesmos rótulos e o mesmo estado de
 * `syncing`. O que mudou é a forma: chip do Design System, acento lime na
 * primária, sem degradê.
 */
export function AcoesFinanceiras({
  syncing,
  onSync,
  onNovaDespesa,
}: {
  syncing: boolean;
  onSync: () => void;
  onNovaDespesa: () => void;
}) {
  return (
    <div className="flex items-center flex-none" style={{ gap: 8 }}>
      <HelpContext ajudaId="integracoes.sync"><button type="button" onClick={onSync} disabled={syncing} className="orbita-chip cursor-pointer">
        <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Sincronizando...' : 'Sincronizar'}
      </button></HelpContext>
      <button
        type="button"
        onClick={onNovaDespesa}
        className="orbita-chip cursor-pointer"
        style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
      >
        <Plus className="w-4 h-4" />
        Nova Despesa
      </button>
    </div>
  );
}

/**
 * Aviso de falha ou parcialidade da sincronização.
 *
 * Existe porque `fetchWithAuth` devolve a `Response` sem lançar em não-2xx:
 * um 502 e um `200 { success: false }` seguiam o mesmo caminho do sucesso, e a
 * tela recarregava dado velho como se estivesse em dia. O texto vem pronto do
 * servidor, que já o monta genérico (CWE-209).
 */
export function AvisoSincronizacao({ mensagem }: { mensagem: string }) {
  if (!mensagem) return null;
  return (
    <output
      className="flex items-start gap-2 px-4 py-2.5 rounded-xl text-xs flex-none"
      style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--warning)' }}
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
      <span>{mensagem}</span>
    </output>
  );
}
