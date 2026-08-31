import { Plus, RefreshCw, AlertTriangle } from 'lucide-react';

interface FinanceiroHeaderProps {
  syncing: boolean;
  onSync: () => void;
  onNovaDespesa: () => void;
}

/** Cabeçalho da aba financeira: título e ações (sincronizar / nova despesa). */
export function FinanceiroHeader({ syncing, onSync, onNovaDespesa }: FinanceiroHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-2xl font-bold text-white">Controle Financeiro</h2>
        <p className="text-slate-400 text-sm mt-0.5">Gestão simplificada de fluxo de caixa e saídas</p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={onSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition-all"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Sincronizando...' : 'Sincronizar'}
        </button>
        <button
          onClick={onNovaDespesa}
          className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-[#FF9F0A] to-[#FF6B00] text-zinc-900 text-sm font-bold shadow-lg hover:opacity-90 transition-all"
        >
          <Plus className="w-4 h-4" />
          Nova Despesa
        </button>
      </div>
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
    <output className="flex items-start gap-3 rounded-xl border border-[#FF9F0A]/40 bg-[#FF9F0A]/10 px-4 py-3 text-sm text-[#FFCF7A]">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{mensagem}</span>
    </output>
  );
}
