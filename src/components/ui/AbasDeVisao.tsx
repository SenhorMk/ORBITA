import responsive from '@/components/ui/Responsive.module.css';

/**
 * Abas de visão de uma lista (Catálogo × Arquivados, Ativos × Cancelados):
 * troca o recorte da tabela, com o rótulo já trazendo a contagem.
 */
export function AbasDeVisao<T extends string>({ rotulo, abas, ativa, onMudar }: {
  readonly rotulo: string;
  readonly abas: ReadonlyArray<{ readonly id: T; readonly rotulo: string }>;
  readonly ativa: T;
  readonly onMudar: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={rotulo}
      className={`flex ${responsive.pills}`}
      style={{ gap: 3, padding: 4, borderRadius: 14, background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      {abas.map((aba) => {
        const selecionada = aba.id === ativa;
        return (
          <button
            key={aba.id}
            type="button"
            role="tab"
            aria-selected={selecionada}
            onClick={() => onMudar(aba.id)}
            className="cursor-pointer"
            style={{
              height: 30,
              padding: '0 13px',
              borderRadius: 11,
              font: '600 12px/1 var(--font-archivo), sans-serif',
              background: selecionada ? 'var(--txt)' : 'transparent',
              color: selecionada ? 'var(--invTxt)' : 'var(--txt2)',
            }}
          >
            {aba.rotulo}
          </button>
        );
      })}
    </div>
  );
}
