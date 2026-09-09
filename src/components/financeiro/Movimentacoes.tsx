'use client';

import { format, parseISO } from 'date-fns';

import { PERIODOS, type Periodo } from '@/components/vendas/filtrosDeVendas';
import { MolduraDeTabela } from '@/components/ui/MolduraDeTabela';
import { Pilula } from '@/components/ui/StatusPill';
import type { FiltroDeTipo, SituacaoDeTitulo, TituloFinanceiro } from './useLeituraFinanceira';

/**
 * As movimentações, na coluna direita da nova composição.
 *
 * A tabela ficou **compacta** de propósito: título, vencimento, valor e a ação
 * de abrir o detalhe. Categoria e situação não sumiram do produto — mudaram de
 * lugar, para o detalhe, que é onde há espaço para elas. A pílula de situação
 * continua na linha porque ela é o que distingue um título ativo de um
 * terminal, e essa distinção não pode depender de abrir o detalhe.
 *
 * **Cancelado e estornado continuam na lista.** É isso que deixa o lojista
 * entender "a venda existiu, mas foi revertida". O que eles não fazem é entrar
 * no total nem nos gráficos.
 *
 * A coluna chama-se `Título`. Onde a coluna `titulo` (migration 62) é nula —
 * todo título importado do Bling, e toda despesa lançada antes dela — a tela
 * **exibe** a `descricao`. É fallback de apresentação, declarado aqui e em
 * `tituloVisivel`; nada é gravado por causa dele.
 */

const GRADE = 'var(--tabela-financeiro-cols)';

/** A soma das colunas na geometria de 1366 — abaixo disso a tabela rola dentro da moldura. */
const LARGURA_MINIMA = 430;

/** Quantas linhas cabem em "últimas": o mesmo teto de antes. */
const TETO_DE_LINHAS = 10;

export const FILTROS_DE_TIPO: ReadonlyArray<{ id: FiltroDeTipo; rotulo: string }> = [
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
export const APARENCIA_DA_SITUACAO: Record<SituacaoDeTitulo, { rotulo: string; cor: string }> = {
  aberto: { rotulo: 'Aberto', cor: 'var(--warning)' },
  pago: { rotulo: 'Pago', cor: 'var(--accent)' },
  cancelado: { rotulo: 'Cancelado', cor: 'var(--txt3)' },
  estornado: { rotulo: 'Estornado', cor: 'var(--danger)' },
};

export function ehTerminal(situacao: SituacaoDeTitulo): boolean {
  return situacao === 'cancelado' || situacao === 'estornado';
}

/** O nome curto do título, com o fallback de apresentação para os antigos. */
export function tituloVisivel(titulo: TituloFinanceiro): string {
  const proprio = (titulo.titulo ?? '').trim();
  return proprio !== '' ? proprio : titulo.descricao;
}

export function formatarVencimento(data: string): string {
  try {
    return format(parseISO(data), 'dd/MM/yyyy');
  } catch {
    return data;
  }
}

/** A cápsula de pills usada pelos dois filtros da toolbar. */
function GrupoDePills<T extends string>({
  opcoes,
  ativo,
  onEscolher,
}: {
  opcoes: ReadonlyArray<{ id: T; rotulo: string }>;
  ativo: T;
  onEscolher: (id: T) => void;
}) {
  return (
    <div
      className="flex flex-none"
      style={{ gap: 3, padding: 4, borderRadius: 14, background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      {opcoes.map((opcao) => {
        const selecionado = ativo === opcao.id;
        return (
          <button
            key={opcao.id}
            type="button"
            onClick={() => onEscolher(opcao.id)}
            aria-pressed={selecionado}
            className="cursor-pointer"
            style={{
              height: 30,
              padding: '0 13px',
              borderRadius: 11,
              font: '600 12px/1 var(--font-archivo), sans-serif',
              background: selecionado ? 'var(--txt)' : 'transparent',
              color: selecionado ? 'var(--invTxt)' : 'var(--txt2)',
            }}
          >
            {opcao.rotulo}
          </button>
        );
      })}
    </div>
  );
}

/**
 * O período, com o mesmo vocabulário de Vendas & Pedidos — `PERIODOS` vem de
 * lá, não é uma segunda lista. O que muda é o campo que ele corta: aqui o eixo
 * financeiro é o vencimento (ver `derivacoesDoFinanceiro`).
 */
export function FiltroDePeriodo({
  periodo,
  setPeriodo,
}: {
  periodo: Periodo;
  setPeriodo: (p: Periodo) => void;
}) {
  return <GrupoDePills opcoes={PERIODOS} ativo={periodo} onEscolher={setPeriodo} />;
}

export function FiltroDeMovimentacoes({
  filtroTipo,
  setFiltroTipo,
}: {
  filtroTipo: FiltroDeTipo;
  setFiltroTipo: (tipo: FiltroDeTipo) => void;
}) {
  return <GrupoDePills opcoes={FILTROS_DE_TIPO} ativo={filtroTipo} onEscolher={setFiltroTipo} />;
}

export function TabelaDeMovimentacoes({
  titulos,
  formatarDinheiro,
  onAbrirDetalhe,
}: {
  titulos: readonly TituloFinanceiro[];
  formatarDinheiro: (valor: number) => string;
  onAbrirDetalhe: (titulo: TituloFinanceiro) => void;
}) {
  const visiveis = titulos.slice(0, TETO_DE_LINHAS);
  const rodape = `${visiveis.length} de ${titulos.length} movimentações`;

  return (
    <MolduraDeTabela larguraMinima={LARGURA_MINIMA} rodape={rodape}>
      <div
        className="orbita-tabela-cabecalho grid items-center"
        style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
      >
        <span>TÍTULO</span>
        <span>VENCIMENTO</span>
        <span className="text-right">VALOR</span>
        <span />
      </div>

      {visiveis.map((titulo) => {
        const entrada = titulo.tipo === 'receber';
        const terminal = ehTerminal(titulo.situacao);
        const { rotulo, cor } = APARENCIA_DA_SITUACAO[titulo.situacao]
          ?? { rotulo: titulo.situacao, cor: 'var(--txt2)' };
        const corDoValor = terminal ? 'var(--txt3)' : entrada ? 'var(--accent)' : 'var(--txt)';
        const nome = tituloVisivel(titulo);

        return (
          <div
            key={titulo.id}
            className="orbita-tabela-linha grid items-center"
            // A linha é mais alta que a das outras tabelas porque a situação
            // vive embaixo do título: em 1366 a altura padrão (40px) faz o
            // título e a pílula se sobreporem.
            style={{
              gridTemplateColumns: GRADE,
              gap: 'var(--tabela-gap)',
              padding: '0 var(--tabela-pad)',
              height: 'var(--linha-financeiro-h)',
            }}
          >
            <span className="min-w-0 flex flex-col" style={{ gap: 3 }}>
              <span
                className="truncate"
                style={{ font: '500 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                title={nome}
              >
                {nome}
              </span>
              <Pilula rotulo={rotulo} cor={cor} />
            </span>

            <span style={{ font: '400 11.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}>
              {formatarVencimento(titulo.data_vencimento)}
            </span>

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

            <span className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => onAbrirDetalhe(titulo)}
                className="orbita-chip cursor-pointer"
                style={{ height: 28, fontSize: 11, padding: '0 10px' }}
              >
                Detalhes
              </button>
            </span>
          </div>
        );
      })}
    </MolduraDeTabela>
  );
}
