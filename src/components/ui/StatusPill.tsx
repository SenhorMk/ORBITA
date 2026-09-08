'use client';

import { pedidoContaComoVendaAtiva } from '@/lib/metricas/vendasAtivas';

/**
 * A tradução visual de um status de pedido — **e nada além disso**.
 *
 * Os rótulos aqui são os status que o contrato realmente grava. A lista boa é a
 * da migração `03_update_pedidos_status.sql` — `Novo`, `Aberto`,
 * `Em Processamento`, `Despachado`, `Enviado`, `Entregue`, `Pendente`,
 * `A Emitir`, `Atendido`, `Cancelado`, `Concluído` — e **não** a de
 * `schema_master.sql`, que ficou para trás e nem inclui `Entregue`, o status
 * que a própria venda manual grava. O mockup chama alguns de outra coisa —
 * "Em trânsito", "Em separação", "Aguardando pgto" —, e essas palavras **não**
 * entram: nenhuma delas corresponde inequivocamente a um estado que existe, e
 * um rótulo que promete mais do que o dado sabe é pior que um rótulo seco.
 *
 * Esta tradução nunca é gravada. O que vai para o banco continua sendo o status
 * que veio do Bling ou da venda manual.
 */
interface Aparencia {
  readonly rotulo: string;
  readonly cor: string;
}

const POR_STATUS: Record<string, Aparencia> = {
  novo: { rotulo: 'Novo', cor: 'var(--txt2)' },
  aberto: { rotulo: 'Aberto', cor: 'var(--txt2)' },
  pendente: { rotulo: 'Pendente', cor: 'var(--txt2)' },
  'a emitir': { rotulo: 'A Emitir', cor: 'var(--warning)' },
  'em processamento': { rotulo: 'Em Processamento', cor: 'var(--info)' },
  despachado: { rotulo: 'Despachado', cor: 'var(--info)' },
  enviado: { rotulo: 'Enviado', cor: 'var(--info)' },
  entregue: { rotulo: 'Entregue', cor: 'var(--accent)' },
  atendido: { rotulo: 'Atendido', cor: 'var(--accent)' },
  'concluído': { rotulo: 'Concluído', cor: 'var(--accent)' },
  concluido: { rotulo: 'Concluído', cor: 'var(--accent)' },
};

const CANCELADO: Aparencia = { rotulo: 'Cancelado', cor: 'var(--danger)' };
const DESCONHECIDO: Aparencia = { rotulo: 'Sem status', cor: 'var(--txt3)' };

/**
 * A aparência de um status.
 *
 * O cancelado é reconhecido pelo radical, e não por igualdade: o status chega
 * de duas fontes e já apareceu como `Cancelado` e `cancelado` — é a mesma
 * frouxidão deliberada de `pedidoContaComoVendaAtiva`, pela mesma razão.
 */
export function aparenciaDoStatus(status: string | null | undefined): Aparencia {
  const bruto = (status ?? '').trim();
  if (bruto === '') return DESCONHECIDO;
  if (!pedidoContaComoVendaAtiva({ status: bruto })) return CANCELADO;
  return POR_STATUS[bruto.toLowerCase()] ?? { rotulo: bruto, cor: 'var(--txt2)' };
}

/**
 * O status de um pedido, como pílula.
 *
 * O ponto colorido carrega o significado, mas nunca sozinho: o texto ao lado diz
 * a mesma coisa. Cor não pode ser a única forma de indicar estado.
 */
export function StatusPill({ status }: { status: string | null | undefined }) {
  const { rotulo, cor } = aparenciaDoStatus(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-lg w-fit"
      style={{
        background: 'var(--chip)',
        border: '1px solid var(--line)',
        fontFamily: 'var(--font-jetbrains-mono), ui-monospace, monospace',
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: '0.04em',
        color: cor,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cor }} aria-hidden />
      {rotulo.toUpperCase()}
    </span>
  );
}
