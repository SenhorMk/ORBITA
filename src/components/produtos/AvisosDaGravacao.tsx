import { AlertTriangle } from 'lucide-react';

const FAIXA = 'flex items-start gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold';

/**
 * Os dois estados da gravação do produto que ficam na tela até a pessoa agir:
 *
 * - `reconciliacao`: resultado indeterminado; salvar está bloqueado;
 * - `avisos`: salvo pela metade (o saldo não foi confirmado, por exemplo).
 */
export function AvisosDaGravacao({ reconciliacao, avisos }: {
  readonly reconciliacao: string | null;
  readonly avisos: readonly string[] | null;
}) {
  return (
    <>
      {reconciliacao !== null && (
        <div role="alert" className={FAIXA} style={{ background: 'var(--chip)', border: '1px solid var(--danger)', color: 'var(--danger)' }}>
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span>
            {reconciliacao} Salvar fica bloqueado nesta sessão até a conferência:
            sincronize o catálogo e recarregue a página.
          </span>
        </div>
      )}
      {avisos && (
        <output className={FAIXA} style={{ background: 'var(--chip)', border: '1px solid var(--warning)', color: 'var(--warning)' }}>
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span>Produto salvo, com pendência: {avisos.join(' ')}</span>
        </output>
      )}
    </>
  );
}
