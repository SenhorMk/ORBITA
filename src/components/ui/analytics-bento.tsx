'use client';

import type React from 'react';
import { useState, useRef } from 'react';
import { TrendingUp, Info } from 'lucide-react';

export interface ChartDayData {
  day: string;
  value: number;
  prevValue?: number;
}

interface AnalyticsBentoProps {
  title?: string;
  totalAmount?: number;
  costAmount?: number;
  data?: ChartDayData[];
}

const defaultChartData: ChartDayData[] = [
  { day: '02 Jul', value: 1200, prevValue: 800 },
  { day: '04 Jul', value: 1850, prevValue: 1100 },
  { day: '06 Jul', value: 1400, prevValue: 950 },
  { day: '08 Jul', value: 2400, prevValue: 1600 },
  { day: '10 Jul', value: 1950, prevValue: 1400 },
  { day: '12 Jul', value: 3100, prevValue: 2100 },
  { day: '14 Jul', value: 2800, prevValue: 1900 },
  { day: '16 Jul', value: 3600, prevValue: 2400 },
  { day: '18 Jul', value: 3200, prevValue: 2200 },
  { day: '20 Jul', value: 4100, prevValue: 2900 },
  { day: '22 Jul', value: 4850, prevValue: 3300 },
];

export function BudgetCard({
  title = 'Valor total de pedidos por dia',
  totalAmount = 30739,
  costAmount = 17828,
  data = defaultChartData
}: AnalyticsBentoProps) {
  const chartData = data && data.length > 0 ? data : defaultChartData;
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(chartData.length - 1);
  const chartRef = useRef<SVGSVGElement>(null);

  const rawMax = Math.max(...chartData.map((d) => Math.max(d.value, d.prevValue || 0)));
  const maxValue = rawMax === 0 ? 1000 : Math.ceil(rawMax / 500) * 500;

  const chartHeight = 220;
  const chartWidth = 800;
  const padding = { top: 30, bottom: 40, left: 75, right: 25 };

  const getY = (val: number) => {
    const normalized = val / maxValue;
    return chartHeight - padding.bottom - normalized * (chartHeight - padding.top - padding.bottom);
  };

  const getX = (index: number) => {
    if (chartData.length <= 1) return padding.left;
    return padding.left + (index / (chartData.length - 1)) * (chartWidth - padding.left - padding.right);
  };

  const generatePath = (key: 'value' | 'prevValue') => {
    if (chartData.length === 0) return '';
    const points = chartData.map((d, i) => ({ x: getX(i), y: getY(d[key] || 0) }));

    let path = `M ${points[0].x} ${points[0].y}`;

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;

      const tension = 0.35;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;

      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }

    return path;
  };

  const generateAreaPath = () => {
    const linePath = generatePath('value');
    const lastPoint = chartData.length - 1;
    return `${linePath} L ${getX(lastPoint)} ${chartHeight - padding.bottom} L ${getX(0)} ${chartHeight - padding.bottom} Z`;
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const relativeX = (x / rect.width) * chartWidth;

    let closestIndex = 0;
    let closestDist = Number.POSITIVE_INFINITY;
    chartData.forEach((_, i) => {
      const dist = Math.abs(getX(i) - relativeX);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = i;
      }
    });
    setHoveredIndex(closestIndex);
  };

  const handleMouseLeave = () => {
    setHoveredIndex(chartData.length - 1);
  };

  // Metrics Calculations
  const faturamentoSemFrete = totalAmount;
  const precoCusto = costAmount || totalAmount * 0.58;
  const margemBruta = totalAmount > 0 ? ((totalAmount - precoCusto) / totalAmount) * 100 : 0;
  const impostos = 0;
  const taxaVenda = 0;
  const lucro = totalAmount - precoCusto;

  // Y-Axis Ticks (5 levels)
  const yTicks = [
    maxValue,
    maxValue * 0.75,
    maxValue * 0.5,
    maxValue * 0.25,
    0,
  ];

  return (
    <div className="w-full rounded-3xl glass-panel border border-white/10 p-6 shadow-2xl select-none space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-[#30D158]" />
            <h3 className="text-base font-bold text-white tracking-tight">{title}</h3>
          </div>

          {/* Period Legend */}
          <div className="flex items-center gap-4 text-xs font-semibold pt-1">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#30D158]" />
              <span className="text-slate-300">Período Atual</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#0A84FF]/60" />
              <span className="text-slate-400">Período Anterior</span>
            </div>
          </div>
        </div>

        {/* Filter Badge */}
        <div className="px-3.5 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-semibold text-[#0A84FF]">
          Todos os pedidos
        </div>
      </div>

      {/* Clean Full-Width Vector Chart (No background dots) */}
      <div className="relative w-full overflow-hidden">
        <svg
          ref={chartRef}
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-auto overflow-visible"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ cursor: 'crosshair' }}
        >
          <defs>
            <linearGradient id="mainAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#30D158" stopOpacity="0.3" />
              <stop offset="60%" stopColor="#30D158" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#30D158" stopOpacity="0.0" />
            </linearGradient>
            <filter id="mainGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Horizontal Grid Lines & Y-Axis Labels */}
          {yTicks.map((val, i) => {
            const yPos = getY(val);
            return (
              <g key={i}>
                <line
                  x1={padding.left}
                  y1={yPos}
                  x2={chartWidth - padding.right}
                  y2={yPos}
                  stroke="rgba(255, 255, 255, 0.07)"
                  strokeWidth="1"
                />
                <text
                  x={padding.left - 10}
                  y={yPos + 4}
                  textAnchor="end"
                  className="text-[10px] font-mono fill-slate-400 font-medium"
                >
                  R${' '}
                  {val.toLocaleString('pt-BR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </text>
              </g>
            );
          })}

          {/* Area Fill for Current Period */}
          <path d={generateAreaPath()} fill="url(#mainAreaGrad)" />

          {/* Previous Period Line (Dashed Blue/Gray) */}
          <path
            d={generatePath('prevValue')}
            fill="none"
            stroke="#0A84FF"
            strokeWidth="2"
            strokeDasharray="4 4"
            opacity="0.5"
          />

          {/* Current Period Line (Solid Green) */}
          <path
            d={generatePath('value')}
            fill="none"
            stroke="#30D158"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Hover Pointer Line */}
          {hoveredIndex !== null && chartData[hoveredIndex] && (
            <line
              x1={getX(hoveredIndex)}
              y1={padding.top}
              x2={getX(hoveredIndex)}
              y2={chartHeight - padding.bottom}
              stroke="rgba(255, 255, 255, 0.2)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          )}

          {/* Active Hover Point Circle */}
          {hoveredIndex !== null && chartData[hoveredIndex] && (
            <g className="transition-all duration-150 ease-out">
              <circle
                cx={getX(hoveredIndex)}
                cy={getY(chartData[hoveredIndex].value)}
                r="8"
                fill="#30D158"
                opacity="0.3"
              />
              <circle
                cx={getX(hoveredIndex)}
                cy={getY(chartData[hoveredIndex].value)}
                r="5"
                fill="#ffffff"
                stroke="#30D158"
                strokeWidth="2.5"
                filter="url(#mainGlow)"
              />
            </g>
          )}

          {/* X-Axis Date Labels */}
          {chartData.map((d, i) => (
            <text
              key={i}
              x={getX(i)}
              y={chartHeight - 12}
              textAnchor="middle"
              className="text-[11px] font-medium fill-slate-400"
            >
              {d.day}
            </text>
          ))}
        </svg>

        {/* Floating Tooltip */}
        {hoveredIndex !== null && chartData[hoveredIndex] && (
          <div
            className="pointer-events-none absolute transition-all duration-150 ease-out z-30"
            style={{
              left: `${(getX(hoveredIndex) / chartWidth) * 100}%`,
              top: `${(getY(chartData[hoveredIndex].value) / chartHeight) * 100}%`,
              transform: 'translate(-50%, -130%)',
            }}
          >
            <div className="relative rounded-xl bg-zinc-900/95 border border-white/20 px-3 py-1.5 shadow-2xl backdrop-blur-2xl text-center">
              <span className="text-[10px] text-slate-400 font-semibold block">{chartData[hoveredIndex].day}</span>
              <span className="text-xs font-bold text-[#30D158]">
                R${' '}
                {chartData[hoveredIndex].value.toLocaleString('pt-BR', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              <div className="absolute left-1/2 -bottom-2 -translate-x-1/2 w-0 h-0 border-l-6 border-r-6 border-t-6 border-l-transparent border-r-transparent border-t-zinc-900" />
            </div>
          </div>
        )}
      </div>

      {/* Bottom Financial Metrics Bar (Matching Reference Image) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-4 border-t border-white/10 text-center">
        {/* 1. FATURAMENTO SEM FRETE */}
        <div className="space-y-1 p-2 rounded-xl bg-white/5 border border-white/5">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">0%</p>
          <p className="text-sm font-extrabold text-white">
            R${' '}
            {faturamentoSemFrete.toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
            })}
          </p>
          <p className="text-[10px] font-medium text-slate-400 uppercase">Faturamento sem frete</p>
        </div>

        {/* 2. PREÇO DE CUSTO */}
        <div className="space-y-1 p-2 rounded-xl bg-white/5 border border-white/5">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">0%</p>
          <p className="text-sm font-extrabold text-slate-200">
            R${' '}
            {precoCusto.toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
            })}
          </p>
          <div className="flex items-center justify-center gap-1">
            <p className="text-[10px] font-medium text-slate-400 uppercase">Preço de custo</p>
            <Info className="w-3 h-3 text-[#0A84FF]" />
          </div>
        </div>

        {/* 3. MARGEM BRUTA */}
        <div className="space-y-1 p-2 rounded-xl bg-white/5 border border-white/5">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">0%</p>
          <p className="text-sm font-extrabold text-[#30D158]">
            {margemBruta.toFixed(2)}%
          </p>
          <p className="text-[10px] font-medium text-slate-400 uppercase">Margem Bruta</p>
        </div>

        {/* 4. IMPOSTOS */}
        <div className="space-y-1 p-2 rounded-xl bg-white/5 border border-white/5">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">0%</p>
          <p className="text-sm font-extrabold text-slate-300">
            R${' '}
            {impostos.toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
            })}
          </p>
          <p className="text-[10px] font-medium text-slate-400 uppercase">Impostos (0%)</p>
        </div>

        {/* 5. TAXA VENDA */}
        <div className="space-y-1 p-2 rounded-xl bg-white/5 border border-white/5">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">0%</p>
          <p className="text-sm font-extrabold text-slate-300">
            R${' '}
            {taxaVenda.toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
            })}
          </p>
          <p className="text-[10px] font-medium text-slate-400 uppercase">Taxa Venda (0%)</p>
        </div>

        {/* 6. LUCRO */}
        <div className="space-y-1 p-2 rounded-xl bg-white/5 border border-white/5">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">0%</p>
          <p className="text-sm font-extrabold text-[#30D158]">
            R${' '}
            {lucro.toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
            })}
          </p>
          <div className="flex items-center justify-center gap-1">
            <p className="text-[10px] font-medium text-slate-400 uppercase">Lucro (0%)</p>
            <Info className="w-3 h-3 text-[#0A84FF]" />
          </div>
        </div>
      </div>
    </div>
  );
}
