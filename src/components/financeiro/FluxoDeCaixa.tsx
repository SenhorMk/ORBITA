'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

import type { PontoDoFluxo } from './useLeituraFinanceira';

/**
 * O fluxo de caixa — a mesma série de antes, na superfície nova.
 *
 * A agregação **não** mudou de lugar nem de regra: continua em
 * `useLeituraFinanceira`, continua somando por data de vencimento e continua
 * deixando `cancelado` e `estornado` de fora. Aqui só se desenha.
 *
 * Os dois `linearGradient` decorativos saíram. Degradê é permitido no fundo da
 * janela e em nenhuma superfície do produto; o preenchimento agora é uniforme e
 * discreto, e quem carrega o significado é a linha. As cores vêm dos tokens —
 * lime para o que entra, vermelho para o que sai —, então o gráfico acompanha o
 * tema como o resto da tela.
 */

export function FluxoDeCaixa({
  chartData,
  formatarDinheiro,
}: {
  chartData: readonly PontoDoFluxo[];
  formatarDinheiro: (valor: number) => string;
}) {
  return (
    <section
      className="flex flex-col min-h-0"
      style={{
        // `--fluxo-h` é a altura desejada e `--fluxo-min` o piso. O gráfico
        // ENCOLHE (`flex: 0 1 auto`) e não cresce: numa janela baixa quem cede
        // espaço é ele, e não as movimentações, que ficavam com uma linha só.
        flex: '0 1 auto',
        height: 'var(--fluxo-h)',
        minHeight: 'var(--fluxo-min)',
        padding: '16px 18px',
        borderRadius: 'var(--r-panel)',
        background: 'var(--glass2)',
        border: '1px solid var(--line)',
      }}
    >
      <h3
        className="m-0 flex-none"
        style={{
          font: '500 15px/1.2 var(--font-space-grotesk), sans-serif',
          letterSpacing: '-0.02em',
          color: 'var(--txt)',
        }}
      >
        Fluxo de Caixa
      </h3>

      <div className="flex-1 min-h-0" style={{ marginTop: 10 }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 200 }}>
          <AreaChart data={chartData as PontoDoFluxo[]} margin={{ top: 5, right: 5, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="var(--txt3)"
              fontSize={11}
              fontFamily="var(--font-jetbrains-mono), ui-monospace, monospace"
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => { if (!val) return ''; try { return format(parseISO(val), 'dd/MM'); } catch { return val; } }}
            />
            <YAxis
              stroke="var(--txt3)"
              fontSize={11}
              fontFamily="var(--font-jetbrains-mono), ui-monospace, monospace"
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => `R$${(val / 1000).toFixed(0)}k`}
            />
            <Tooltip
              cursor={{ stroke: 'var(--bar)', strokeWidth: 1 }}
              contentStyle={{
                background: 'var(--head)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                fontFamily: 'var(--font-archivo), system-ui, sans-serif',
                fontSize: 12,
                color: 'var(--txt)',
              }}
              labelStyle={{ color: 'var(--txt2)' }}
              labelFormatter={(val) => { try { return format(parseISO(val as string), "dd 'de' MMMM", { locale: ptBR }); } catch { return val; } }}
              formatter={(value: unknown) => [formatarDinheiro(Number(value || 0)), '']}
            />
            <Area
              type="monotone"
              dataKey="receitas"
              name="Entradas"
              stroke="var(--accent)"
              strokeWidth={2}
              fill="var(--accent)"
              fillOpacity={0.12}
            />
            <Area
              type="monotone"
              dataKey="despesas"
              name="Saídas"
              stroke="var(--danger)"
              strokeWidth={2}
              fill="var(--danger)"
              fillOpacity={0.1}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
