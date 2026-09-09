'use client';

import type { ReactElement } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

import type { BarraDoDia, PontoDoFluxo } from './derivacoesDoFinanceiro';

/**
 * Os dois gráficos do Financeiro, na mesma casca.
 *
 * Eles partem do **mesmo** conjunto de títulos elegíveis do escopo ativo (ver
 * `derivacoesDoFinanceiro`): mesmo período, mesmo eixo de tempo
 * (`data_vencimento`), mesmo recorte de situação. Duas leituras da mesma
 * verdade, não duas agregações que podem discordar.
 *
 * Não há degradê em nenhum dos dois: ele é permitido no fundo da janela e em
 * nenhuma superfície do produto. As cores vêm dos tokens — lime para o que
 * entra, vermelho para o que sai —, então os gráficos acompanham o tema.
 *
 * Também não há "previsto × realizado": o ORBITA não tem essas duas semânticas,
 * e desenhar uma série que o dado não sustenta seria inventar número.
 */

const EIXO = {
  stroke: 'var(--txt3)',
  fontSize: 10.5,
  fontFamily: 'var(--font-jetbrains-mono), ui-monospace, monospace',
  tickLine: false,
  axisLine: false,
} as const;

function rotuloDoDia(valor: unknown): string {
  if (typeof valor !== 'string' || valor === '') return '';
  try {
    return format(parseISO(valor), 'dd/MM');
  } catch {
    return valor;
  }
}

function diaPorExtenso(valor: unknown): string {
  try {
    return format(parseISO(String(valor)), "dd 'de' MMMM", { locale: ptBR });
  } catch {
    return String(valor ?? '');
  }
}

function estiloDoTooltip() {
  return {
    background: 'var(--head)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    fontFamily: 'var(--font-archivo), system-ui, sans-serif',
    fontSize: 12,
    color: 'var(--txt)',
  } as const;
}

/**
 * A casca de um gráfico: painel, título e a área que encolhe.
 *
 * A altura é `flex: 1 1 0` com piso em `--grafico-min` — os dois dividem a
 * coluna esquerda e cedem juntos numa janela baixa, em vez de um deles empurrar
 * o outro para fora.
 */
function PainelDeGrafico({ titulo, children }: { titulo: string; children: ReactElement }) {
  return (
    <section
      className="flex flex-col min-h-0"
      style={{
        flex: '1 1 0',
        minHeight: 'var(--grafico-min)',
        padding: '13px 15px',
        borderRadius: 'var(--r-panel)',
        background: 'var(--glass2)',
        border: '1px solid var(--line)',
      }}
    >
      <h3
        className="m-0 flex-none"
        style={{
          font: '500 14px/1.2 var(--font-space-grotesk), sans-serif',
          letterSpacing: '-0.02em',
          color: 'var(--txt)',
        }}
      >
        {titulo}
      </h3>
      <div className="flex-1 min-h-0" style={{ marginTop: 8 }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 500, height: 160 }}>
          {children}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

/**
 * Entradas para cima, saídas para baixo, em torno do eixo zero.
 *
 * A saída chega negativa da derivação — é o sinal que a põe abaixo do eixo. Ele
 * é orientação, não valor: a formatação de moeda usa o módulo, e o que a
 * pessoa lê no tooltip é o mesmo número do extrato.
 */
export function EntradasESaidas({
  barras,
  formatarDinheiro,
}: {
  barras: readonly BarraDoDia[];
  formatarDinheiro: (valor: number) => string;
}) {
  return (
    <PainelDeGrafico titulo="Entradas e Saídas">
      <BarChart data={barras as BarraDoDia[]} margin={{ top: 4, right: 4, left: -18, bottom: 0 }} stackOffset="sign">
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis dataKey="date" {...EIXO} tickFormatter={rotuloDoDia} />
        <YAxis {...EIXO} tickFormatter={(v) => `R$${(Math.abs(Number(v)) / 1000).toFixed(0)}k`} />
        <ReferenceLine y={0} stroke="var(--bar)" />
        <Tooltip
          cursor={{ fill: 'var(--chip)' }}
          contentStyle={estiloDoTooltip()}
          labelStyle={{ color: 'var(--txt2)' }}
          labelFormatter={diaPorExtenso}
          formatter={(valor: unknown, nome: unknown) => [formatarDinheiro(Math.abs(Number(valor || 0))), String(nome)]}
        />
        <Bar dataKey="entradas" name="Entradas" fill="var(--accent)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="saidas" name="Saídas" fill="var(--danger)" radius={[0, 0, 3, 3]} />
      </BarChart>
    </PainelDeGrafico>
  );
}

/**
 * O fluxo de caixa — a mesma série de sempre, na superfície nova.
 *
 * A agregação não mudou de regra: soma por dia de vencimento e deixa
 * `cancelado` e `estornado` de fora. Os dois `linearGradient` decorativos
 * saíram; o preenchimento é uniforme e quem carrega o significado é a linha.
 */
export function FluxoDeCaixa({
  serie,
  formatarDinheiro,
}: {
  serie: readonly PontoDoFluxo[];
  formatarDinheiro: (valor: number) => string;
}) {
  return (
    <PainelDeGrafico titulo="Fluxo de Caixa">
      <AreaChart data={serie as PontoDoFluxo[]} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
        <XAxis dataKey="date" {...EIXO} tickFormatter={rotuloDoDia} />
        <YAxis {...EIXO} tickFormatter={(v) => `R$${(Number(v) / 1000).toFixed(0)}k`} />
        <Tooltip
          cursor={{ stroke: 'var(--bar)', strokeWidth: 1 }}
          contentStyle={estiloDoTooltip()}
          labelStyle={{ color: 'var(--txt2)' }}
          labelFormatter={diaPorExtenso}
          formatter={(valor: unknown, nome: unknown) => [formatarDinheiro(Number(valor || 0)), String(nome)]}
        />
        <Area type="monotone" dataKey="receitas" name="Entradas" stroke="var(--accent)" strokeWidth={2} fill="var(--accent)" fillOpacity={0.12} />
        <Area type="monotone" dataKey="despesas" name="Saídas" stroke="var(--danger)" strokeWidth={2} fill="var(--danger)" fillOpacity={0.1} />
      </AreaChart>
    </PainelDeGrafico>
  );
}
