'use client';

import { HelpContext, helpPageHeader } from '@/components/help/HelpContext';

import { useMemo, useState } from 'react';

import { AvisoDeAtualizacaoFalhada, EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import { AreaAnalitica } from './AreaAnalitica';
import type { DadosDoPainel } from './useLeituraDoPainel';
import { analiseDaMetrica } from './analisesDoPainel';
import {
  anelDePedidos,
  celulasDoPainel,
  metricasLaterais,
  type Celula,
  type FatiaDeDistribuicao,
  type MetricaLateral,
  type MetricaId,
} from './metricasDoPainel';

/**
 * Visão Geral.
 *
 * A composição é a de `Orbita Dashboard.dc.html`: título e células de contexto
 * na linha de cima; embaixo, o anel com as métricas à esquerda e a área
 * analítica à direita.
 *
 * O que muda em relação ao protótipo é o que os cinco cards dele mostravam —
 * faturamento por canal, evolução anual do ticket, pedidos separados por dia,
 * estoque conferido, devoluções. Nenhum desses números existe no contrato. Em
 * vez de cinco cards com números inventados, há **uma** área analítica que
 * responde à métrica escolhida, e ela só sabe dizer o que o payload já contém.
 *
 * A seleção é só da tela: `metricaSelecionada`. Nenhuma rota, nenhuma
 * agregação, nenhuma leitura nova.
 *
 * Contraste, conforme o Design System: um card claro (a área analítica, que é o
 * que manda na tela), um acento lime e um lavanda no anel, e vidro no resto.
 */

/** O anel: um degradê cônico com uma parada por fatia, na ordem em que vêm. */
function degradeDoAnel(fatias: readonly FatiaDeDistribuicao[]): string {
  if (fatias.length === 0) return 'conic-gradient(var(--bar) 0 100%)';
  let acumulado = 0;
  const paradas = fatias.map((fatia) => {
    const de = acumulado * 100;
    acumulado += fatia.fracao;
    return `${fatia.cor} ${de}% ${acumulado * 100}%`;
  });
  return `conic-gradient(from -90deg, ${paradas.join(', ')})`;
}

/** A linha de cima: o título da tela e as sete células de contexto. */
function LinhaDeTitulo({
  celulas,
  metricaSelecionada,
  onSelecionar,
}: {
  celulas: readonly Celula[];
  metricaSelecionada: MetricaId;
  onSelecionar: (metrica: MetricaId) => void;
}) {
  return (
      <div className={`flex items-start gap-8 flex-none ${helpPageHeader}`}>
        <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
          <HelpContext ajudaId="painel.visao">
            <h1
              className="m-0"
              style={{
                fontFamily: 'var(--font-space-grotesk), sans-serif',
                fontWeight: 500,
                fontSize: 'var(--titulo-fs)',
                lineHeight: 1.04,
                letterSpacing: '-0.03em',
                color: 'var(--txt)',
              }}
            >
              Visão<br />Geral
            </h1>
          </HelpContext>
          <HelpContext ajudaId="painel.metricas-detalhadas"><span className="orbita-eyebrow">Indicadores</span></HelpContext>
        </div>

        <div
          className="flex-1 min-w-0 grid"
          style={{ gridTemplateColumns: `repeat(${celulas.length}, 1fr)`, gap: 'var(--resumo-gap)' }}
        >
          {celulas.map((celula) => {
            const selecionada = metricaSelecionada === celula.id;
            return (
              <button
                key={celula.id}
                type="button"
                onClick={() => onSelecionar(celula.id)}
                aria-pressed={selecionada}
                title={`Ver ${celula.rotulo.toLowerCase()} na área analítica`}
                className="flex flex-col justify-between text-left cursor-pointer"
                style={{
                  minHeight: 'var(--resumo-min)',
                  padding: '12px 13px',
                  borderRadius: 16,
                  background: 'var(--glass2)',
                  border: `1px solid ${selecionada ? 'var(--txt)' : 'var(--line)'}`,
                }}
              >
                <span style={{ font: '400 10.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}>
                  {celula.rotulo}
                </span>
                <span
                  className="orbita-numero truncate"
                  style={{ fontSize: 'var(--resumo-fs)', color: celula.cor ?? 'var(--txt)' }}
                >
                  {celula.valor}
                </span>
              </button>
            );
          })}
        </div>
      </div>
  );
}

/** A coluna da esquerda: o anel dos baldes e os números de contexto. */
function ColunaDoAnel({
  anel,
  metricas,
}: {
  anel: { total: number; fatias: readonly FatiaDeDistribuicao[] };
  metricas: readonly MetricaLateral[];
}) {
  const anelBg = degradeDoAnel(anel.fatias);
  return (
          <div
            className="flex flex-col flex-none min-w-0"
            style={{ width: 'var(--anel-col)', paddingLeft: 26, gap: 16 }}
          >
            {/*
              O anel absorve a sobra e as métricas ficam com a altura natural.
              Antes era o contrário — a coluna distribuía o espaço e, quando ele
              acabava, quem sumia era a última linha de métricas. Aqui o que
              cede é o desenho, nunca o número: o anel encolhe até o espaço que
              existir, e as legendas continuam inteiras.
            */}
            <div className="flex-1 min-h-0 flex items-center justify-center">
              <div
                className="relative"
                style={{ height: '100%', aspectRatio: '1', maxHeight: 'var(--anel-tam)', maxWidth: '100%' }}
              >
              <div className="absolute inset-0 rounded-full" style={{ background: anelBg }} aria-hidden />
              <div
                className="absolute rounded-full flex flex-col items-center justify-center"
                style={{ inset: '30%', background: 'var(--glass)', backdropFilter: 'blur(24px)' }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-space-grotesk), sans-serif',
                    fontWeight: 500,
                    fontSize: 'var(--anel-fs)',
                    lineHeight: 1,
                    letterSpacing: '-0.03em',
                    color: 'var(--txt)',
                  }}
                >
                  {anel.total}
                </span>
                <span
                  className="text-center"
                  style={{ font: '400 11px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
                >
                  pedidos
                </span>
                </div>
              </div>
            </div>

            <div
              className="grid flex-none"
              style={{
                gridTemplateColumns: 'repeat(auto-fit, minmax(var(--metrica-min), 1fr))',
                gap: '14px 12px',
                padding: '0 4px 2px',
              }}
            >
              {metricas.map((metrica) => (
                <div key={metrica.rotulo} className="flex flex-col" style={{ gap: 5 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-space-grotesk), sans-serif',
                      fontWeight: 500,
                      fontSize: 'var(--metrica-fs)',
                      lineHeight: 1,
                      letterSpacing: '-0.02em',
                      color: metrica.cor,
                    }}
                  >
                    {metrica.valor}
                  </span>
                  <span
                    className="flex items-baseline"
                    style={{ gap: 6, font: '400 10.5px/1.25 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: metrica.cor }} aria-hidden />
                    <span className="min-w-0">{metrica.rotulo}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
  );
}

interface VisaoGeralProps {
  dados: DadosDoPainel | null;
  erroDeLeitura: string | null;
  onRecarregar: () => void;
}

export function VisaoGeral({ dados, erroDeLeitura, onRecarregar }: VisaoGeralProps) {
  const [metricaSelecionada, setMetricaSelecionada] = useState<MetricaId>('faturamento');
  /** O "agora" da tela, fixado na montagem: as janelas não se movem sozinhas. */
  const [agora] = useState(() => Date.now());

  const celulas = useMemo(() => (dados === null ? [] : celulasDoPainel(dados, agora)), [dados, agora]);
  const metricas = useMemo(() => (dados === null ? [] : metricasLaterais(dados, agora)), [dados, agora]);
  const anel = useMemo(
    () => (dados === null ? { total: 0, fatias: [] } : anelDePedidos(dados.pedidos)),
    [dados],
  );
  const analise = useMemo(
    () => (dados === null ? null : analiseDaMetrica(metricaSelecionada, dados, agora)),
    [metricaSelecionada, dados, agora],
  );

  if (dados === null) {
    return erroDeLeitura === null ? (
      <EstadoCarregando mensagem="Carregando a visão geral…" />
    ) : (
      <EstadoDeErro
        titulo="Não foi possível carregar a visão geral"
        detalhe={erroDeLeitura}
        onTentarDeNovo={onRecarregar}
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ gap: 'var(--conteudo-gap)' }}>
      {erroDeLeitura !== null && <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura} />}

      <LinhaDeTitulo
        celulas={celulas}
        metricaSelecionada={metricaSelecionada}
        onSelecionar={setMetricaSelecionada}
      />

      {dados.pedidos.length === 0 ? (
        <EstadoVazio
          titulo="Nenhum pedido nesta organização ainda"
          descricao="Sincronize o Bling ou registre uma venda manual para a visão geral ter o que mostrar."
        />
      ) : (
        <div className="flex flex-1 min-h-0" style={{ gap: 26 }}>
          <ColunaDoAnel anel={anel} metricas={metricas} />

          {/* Coluna direita: a área analítica, e a legenda do anel embaixo. */}
          <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 14 }}>
            <div className="flex-1 min-h-0 flex">{analise && <AreaAnalitica analise={analise} />}</div>

            <div
              className="grid flex-none"
              style={{ gridTemplateColumns: `repeat(${anel.fatias.length || 1}, 1fr)`, gap: 14 }}
            >
              {anel.fatias.map((fatia) => (
                <div
                  key={fatia.rotulo}
                  className="flex flex-col justify-between"
                  style={{
                    gap: 10,
                    padding: '14px 16px',
                    borderRadius: 22,
                    background: 'var(--glass2)',
                    border: '1px solid var(--line)',
                  }}
                >
                  <span
                    className="flex items-center"
                    style={{ gap: 7, font: '400 11px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: fatia.cor }} aria-hidden />
                    {fatia.rotulo}
                  </span>
                  <span className="flex items-baseline" style={{ gap: 8 }}>
                    <span className="orbita-numero" style={{ fontSize: 23, color: fatia.cor }}>
                      {fatia.quantidade}
                    </span>
                    <span style={{ font: '400 10.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
                      {fatia.valor}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
