'use client';
import responsive from '@/components/ui/Responsive.module.css';

import type { Analise } from './metricasDoPainel';
import { HelpContext } from '@/components/help/HelpContext';

/**
 * A área analítica — o card claro que manda na tela.
 *
 * É o nível 3 da escada de elevação do Design System, e o único: superfície
 * sólida clara, reservada para "o número que manda na tela". Tudo o mais nesta
 * tela é vidro, com um acento lime e um lavanda no máximo.
 *
 * Ela tem quatro formas, e a escolha entre elas não é estética — é o que os
 * dados sustentam:
 *
 * - **série**, quando cada ponto foi medido (o faturamento de cada dia);
 * - **distribuição**, quando há repartição verdadeira de um total;
 * - **fila**, quando o que importa é a ordem de espera;
 * - **vazia**, quando não há nada a mostrar — e aí ela diz isso, em vez de
 *   desenhar uma curva reta e chamar de gráfico.
 */

function Cabecalho({ titulo, destaque, abaixo }: { titulo: string; destaque: string; abaixo?: React.ReactNode }) {
  return (
    <div className="flex flex-col" style={{ gap: 3 }}>
      <HelpContext ajudaId="painel.analise"><span style={{ font: '500 12px/1.3 var(--font-archivo), sans-serif', opacity: 0.65 }}>{titulo}</span></HelpContext>
      <span
        style={{
          font: '500 34px/1 var(--font-space-grotesk), sans-serif',
          letterSpacing: '-0.03em',
        }}
      >
        {destaque}
      </span>
      {abaixo}
    </div>
  );
}

/** O cabeçalho de quem tem legenda: distribuição e fila usam o mesmo. */
function CabecalhoComLegenda({ titulo, destaque, legenda }: { titulo: string; destaque: string; legenda: string }) {
  return (
    <Cabecalho
      titulo={titulo}
      destaque={destaque}
      abaixo={
        <span style={{ font: '400 11px/1.3 var(--font-archivo), sans-serif', opacity: 0.6 }}>{legenda}</span>
      }
    />
  );
}

function Serie({ analise }: { analise: Extract<Analise, { tipo: 'serie' }> }) {
  const maior = Math.max(...analise.pontos.map((p) => p.valor), 0);

  return (
    <>
      <Cabecalho
        titulo={analise.titulo}
        destaque={analise.destaque}
        abaixo={
          analise.variacao && (
            <span
              style={{
                font: '500 11px/1 var(--font-jetbrains-mono), monospace',
                color: analise.variacaoPositiva ? '#3E6B00' : '#B32316',
              }}
            >
              {analise.variacao}
            </span>
          )
        }
      />

      <div className="flex-1 flex items-end" style={{ gap: 2, minHeight: 96 }}>
        {analise.pontos.map((ponto, indice) => {
          const altura = maior === 0 ? 0 : (ponto.valor / maior) * 100;
          return (
            <span
              key={`${ponto.rotulo}-${indice}`}
              title={`${ponto.rotulo}: ${ponto.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`}
              className="flex-1 flex items-end"
              style={{ height: '100%' }}
            >
              <span
                className="w-full"
                style={{
                  height: `${Math.max(altura, ponto.valor > 0 ? 4 : 1)}%`,
                  borderRadius: '4px 4px 2px 2px',
                  background: ponto.valor > 0 ? 'var(--accent)' : 'rgba(20,20,26,.12)',
                }}
              />
            </span>
          );
        })}
      </div>

      <div className={`flex items-center justify-between ${responsive.seriesFooter}`} style={{ gap: 12 }}>
        <span style={{ font: '400 10px/1 var(--font-archivo), sans-serif', opacity: 0.55 }}>
          {analise.pontos[0]?.rotulo}
        </span>
        <div className="flex" style={{ gap: 20 }}>
          {analise.comparacao.map((item) => (
            <span key={item.rotulo} className="flex flex-col" style={{ gap: 2 }}>
              <span style={{ font: '500 15px/1.1 var(--font-space-grotesk), sans-serif', letterSpacing: '-0.02em' }}>
                {item.valor}
              </span>
              <span style={{ font: '400 10px/1.3 var(--font-archivo), sans-serif', opacity: 0.6 }}>
                {item.rotulo}
              </span>
            </span>
          ))}
        </div>
        <span style={{ font: '400 10px/1 var(--font-archivo), sans-serif', opacity: 0.55 }}>
          {analise.pontos[analise.pontos.length - 1]?.rotulo}
        </span>
      </div>
    </>
  );
}

function Distribuicao({ analise }: { analise: Extract<Analise, { tipo: 'distribuicao' }> }) {
  return (
    <>
      <CabecalhoComLegenda titulo={analise.titulo} destaque={analise.destaque} legenda={analise.legenda} />

      <div className="flex-1 flex flex-col justify-end overflow-y-auto" style={{ gap: 12 }}>
        {analise.fatias.map((fatia) => (
          <div key={fatia.rotulo} className="flex flex-col" style={{ gap: 5 }}>
            <div className="flex items-baseline justify-between" style={{ gap: 10 }}>
              <span style={{ font: '500 12px/1.2 var(--font-archivo), sans-serif' }}>{fatia.rotulo}</span>
              <span className="flex items-baseline" style={{ gap: 8 }}>
                <span style={{ font: '500 15px/1 var(--font-space-grotesk), sans-serif', letterSpacing: '-0.02em' }}>
                  {fatia.quantidade}
                </span>
                <span style={{ font: '400 10.5px/1 var(--font-jetbrains-mono), monospace', opacity: 0.55 }}>
                  {fatia.valor}
                </span>
              </span>
            </div>
            <span className="block w-full" style={{ height: 8, borderRadius: 4, background: 'rgba(20,20,26,.09)' }}>
              <span
                className="block"
                style={{
                  width: `${Math.max(fatia.fracao * 100, 2)}%`,
                  height: '100%',
                  borderRadius: 4,
                  background: '#17171B',
                }}
              />
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Fila({ analise }: { analise: Extract<Analise, { tipo: 'fila' }> }) {
  return (
    <>
      <CabecalhoComLegenda titulo={analise.titulo} destaque={analise.destaque} legenda={analise.legenda} />

      <div className="flex-1 flex flex-col justify-end overflow-y-auto" style={{ gap: 0 }}>
        {analise.itens.map((item) => (
          <div
            key={item.numero}
            className="flex items-center justify-between"
            style={{ gap: 12, padding: '7px 0', borderBottom: '1px solid rgba(20,20,26,.09)' }}
          >
            <span className="flex items-baseline min-w-0" style={{ gap: 9 }}>
              <span style={{ font: '500 12px/1 var(--font-jetbrains-mono), monospace' }}>{item.numero}</span>
              <span className="truncate" style={{ font: '400 12px/1.3 var(--font-archivo), sans-serif', opacity: 0.75 }}>
                {item.cliente}
              </span>
            </span>
            <span className="flex items-baseline shrink-0" style={{ gap: 12 }}>
              <span style={{ font: '400 10.5px/1 var(--font-archivo), sans-serif', opacity: 0.55 }}>
                {item.idade}
              </span>
              <span style={{ font: '500 13px/1 var(--font-space-grotesk), sans-serif', letterSpacing: '-0.02em' }}>
                {item.valor}
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function AreaAnalitica({ analise }: { analise: Analise }) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col flex-1 min-h-0 min-w-0"
      style={{
        background: 'var(--inv)',
        color: 'var(--invTxt)',
        borderRadius: 22,
        padding: '18px 20px',
        gap: 14,
      }}
    >
      {analise.tipo === 'serie' && <Serie analise={analise} />}
      {analise.tipo === 'distribuicao' && <Distribuicao analise={analise} />}
      {analise.tipo === 'fila' && <Fila analise={analise} />}
      {analise.tipo === 'vazia' && (
        <>
          <Cabecalho titulo={analise.titulo} destaque={analise.destaque} />
          <p
            className="flex-1 flex items-center"
            style={{ font: '400 12.5px/1.5 var(--font-archivo), sans-serif', opacity: 0.6, maxWidth: '46ch' }}
          >
            {analise.motivo}
          </p>
        </>
      )}
    </section>
  );
}
