'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { format, parseISO } from 'date-fns';

import { MolduraDeTabela } from '@/components/ui/MolduraDeTabela';
import { Pilula } from '@/components/ui/StatusPill';
import type { FiltroDeTipo, SituacaoDeTitulo, TituloFinanceiro } from './useLeituraFinanceira';

/**
 * As últimas movimentações, na tabela do produto novo.
 *
 * O filtro é o mesmo mecanismo de antes — ele muda o `tipo` da consulta a
 * `/api/financeiro`, e não a lista já carregada —, e continua com as mesmas três
 * opções e a mesma semântica.
 *
 * **Cancelado e estornado continuam na lista.** É isso que deixa o lojista
 * entender "a venda existiu, mas foi revertida". O que eles não fazem é entrar
 * no total: o resumo vem do servidor, e o fluxo de caixa já os exclui. O valor
 * riscado e a pílula dizem que o título terminou; nenhuma informação some por
 * causa disso.
 */

const GRADE = 'var(--tabela-financeiro-cols)';

/** A soma das colunas na geometria de 1366 — abaixo disso a tabela rola dentro da moldura. */
const LARGURA_MINIMA = 860;

/** Quantas linhas cabem em "últimas": o mesmo teto de antes. */
const TETO_DE_LINHAS = 10;

const FILTROS: ReadonlyArray<{ id: FiltroDeTipo; rotulo: string }> = [
  { id: 'todos', rotulo: 'Todos' },
  { id: 'receber', rotulo: 'Entradas' },
  { id: 'pagar', rotulo: 'Saídas' },
];

/**
 * A aparência de uma situação financeira — tradução **visual**, e só.
 *
 * O valor gravado continua sendo `aberto`, `pago`, `cancelado` ou `estornado`;
 * nada aqui volta para o banco.
 */
const APARENCIA: Record<SituacaoDeTitulo, { rotulo: string; cor: string }> = {
  aberto: { rotulo: 'Aberto', cor: 'var(--warning)' },
  pago: { rotulo: 'Pago', cor: 'var(--accent)' },
  cancelado: { rotulo: 'Cancelado', cor: 'var(--txt3)' },
  estornado: { rotulo: 'Estornado', cor: 'var(--danger)' },
};

function ehTerminal(situacao: SituacaoDeTitulo): boolean {
  return situacao === 'cancelado' || situacao === 'estornado';
}

function formatarVencimento(data: string): string {
  try {
    return format(parseISO(data), 'dd/MM/yyyy');
  } catch {
    return data;
  }
}

export function FiltroDeMovimentacoes({
  filtroTipo,
  setFiltroTipo,
}: {
  filtroTipo: FiltroDeTipo;
  setFiltroTipo: (tipo: FiltroDeTipo) => void;
}) {
  return (
    <div
      className="flex flex-none"
      style={{ gap: 3, padding: 4, borderRadius: 14, background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      {FILTROS.map((filtro) => {
        const ativo = filtroTipo === filtro.id;
        return (
          <button
            key={filtro.id}
            type="button"
            onClick={() => setFiltroTipo(filtro.id)}
            aria-pressed={ativo}
            className="cursor-pointer"
            style={{
              height: 30,
              padding: '0 13px',
              borderRadius: 11,
              font: '600 12px/1 var(--font-archivo), sans-serif',
              background: ativo ? 'var(--txt)' : 'transparent',
              color: ativo ? 'var(--invTxt)' : 'var(--txt2)',
            }}
          >
            {filtro.rotulo}
          </button>
        );
      })}
    </div>
  );
}

export function TabelaDeMovimentacoes({
  titulos,
  formatarDinheiro,
}: {
  titulos: readonly TituloFinanceiro[];
  formatarDinheiro: (valor: number) => string;
}) {
  const visiveis = titulos.slice(0, TETO_DE_LINHAS);
  const rodape = `${visiveis.length} de ${titulos.length} movimentações`;

  return (
    <MolduraDeTabela larguraMinima={LARGURA_MINIMA} rodape={rodape}>
      <div
        className="orbita-tabela-cabecalho grid items-center"
        style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
      >
        <span />
        <span>DESCRIÇÃO</span>
        <span>CATEGORIA</span>
        <span>VENCIMENTO</span>
        <span>SITUAÇÃO</span>
        <span className="text-right">VALOR</span>
      </div>

      {visiveis.map((titulo) => {
        const entrada = titulo.tipo === 'receber';
        const terminal = ehTerminal(titulo.situacao);
        const { rotulo, cor } = APARENCIA[titulo.situacao] ?? { rotulo: titulo.situacao, cor: 'var(--txt2)' };
        const corDoValor = terminal ? 'var(--txt3)' : entrada ? 'var(--accent)' : 'var(--txt)';

        return (
          <div
            key={titulo.id}
            className="orbita-tabela-linha grid items-center"
            style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
          >
            <span
              className="flex items-center justify-center rounded-lg shrink-0"
              style={{
                width: 28,
                height: 28,
                background: 'var(--chip)',
                border: '1px solid var(--line)',
                color: entrada ? 'var(--accent)' : 'var(--danger)',
              }}
              aria-label={entrada ? 'Entrada' : 'Saída'}
            >
              {entrada ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
            </span>

            <span className="min-w-0 flex flex-col" style={{ gap: 2 }}>
              <span
                className="truncate"
                style={{ font: '500 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                title={titulo.descricao}
              >
                {titulo.descricao}
              </span>
              {titulo.bling_id === 0 && (
                <span style={{ font: '400 10px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
                  Interno
                </span>
              )}
            </span>

            <span
              className="truncate"
              style={{ font: '400 12px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
            >
              {titulo.categoria?.descricao || 'Sem categoria'}
            </span>

            <span style={{ font: '400 11.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}>
              {formatarVencimento(titulo.data_vencimento)}
            </span>

            <Pilula rotulo={rotulo} cor={cor} />

            <span
              className="orbita-numero text-right truncate"
              style={{
                fontSize: 13.5,
                color: corDoValor,
                textDecoration: terminal ? 'line-through' : undefined,
              }}
            >
              {entrada ? '+' : '-'}{formatarDinheiro(titulo.valor)}
            </span>
          </div>
        );
      })}
    </MolduraDeTabela>
  );
}
