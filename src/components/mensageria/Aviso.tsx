import { AlertCircle } from 'lucide-react';

/** Um aviso curto na cor do seu significado, sempre com texto e nunca só cor. */
export function Aviso({ tom, children }: { readonly tom: 'erro' | 'atencao'; readonly children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-xl text-xs"
      role="alert"
      style={{
        background: 'var(--chip)',
        border: '1px solid var(--line)',
        color: tom === 'erro' ? 'var(--danger)' : 'var(--warning)',
      }}
    >
      <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}
