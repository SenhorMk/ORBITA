'use client';

import type { ResumoFinanceiro as Resumo } from './useLeituraFinanceira';

/**
 * Os três números do resumo — os mesmos de antes, com os mesmos rótulos.
 *
 * Eles vêm prontos de `GET /api/financeiro`: o servidor continua sendo a
 * autoridade sobre o que é receita, o que é despesa e o que entra no saldo.
 * Nada é recalculado aqui, nem completado com zero — o componente só é
 * renderizado quando existe uma leitura boa para mostrar.
 */

function Cartao({ rotulo, valor, cor }: { rotulo: string; valor: string; cor: string }) {
  return (
    <div
      className="flex flex-col justify-between"
      style={{
        gap: 12,
        minHeight: 'var(--resumo-min)',
        padding: '12px 13px',
        borderRadius: 16,
        background: 'var(--glass2)',
        border: '1px solid var(--line)',
      }}
    >
      <span
        className="flex items-center"
        style={{ gap: 7, font: '400 10.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cor }} aria-hidden />
        {rotulo}
      </span>
      <span className="orbita-numero truncate" style={{ fontSize: 'var(--resumo-fs)', color: cor }}>
        {valor}
      </span>
    </div>
  );
}

export function ResumoFinanceiro({
  resumo,
  formatarDinheiro,
}: {
  resumo: Resumo;
  formatarDinheiro: (valor: number) => string;
}) {
  return (
    <div
      className="flex-1 min-w-0 grid"
      style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--resumo-gap)' }}
    >
      <Cartao rotulo="Total Entradas" valor={formatarDinheiro(resumo.receitas)} cor="var(--accent)" />
      <Cartao rotulo="Total Saídas" valor={formatarDinheiro(resumo.despesas)} cor="var(--danger)" />
      <Cartao
        rotulo="Saldo Líquido"
        valor={formatarDinheiro(resumo.saldo)}
        cor={resumo.saldo >= 0 ? 'var(--accent)' : 'var(--danger)'}
      />
    </div>
  );
}
