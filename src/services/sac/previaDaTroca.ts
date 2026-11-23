import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import {
  PreviaDaTrocaSchema, ProximaPerguntaDaTrocaSchema,
  type PendenciaDaTroca, type PreviaDaTroca, type SolicitacaoDeTroca,
} from '@/lib/integrations/contratoDaPropostaDeTroca';
import type { ResultadoDoRetrato } from './retratoDoPedido';

const PERGUNTAS = {
  pedido: 'Qual é o número do pedido?',
  item: 'Qual item do pedido você quer trocar ou devolver?',
  quantidade: 'Quantas unidades desse item foram afetadas?',
  motivo: 'O que aconteceu com o produto?',
  substituto: 'Qual produto você gostaria de receber como substituto?',
} as const;

export interface LeiturasDaPreviaDeTroca {
  casoAberto(escopo: VerifiedOrganizationScope, conversaId: string): Promise<string | null>;
  retrato(escopo: VerifiedOrganizationScope, conversaId: string, pedidoId: string): Promise<ResultadoDoRetrato>;
}

type ResultadoDaPrevia =
  | { estado: 'sem_caso' | 'pedido_nao_encontrado' }
  | { estado: 'ok'; previa: PreviaDaTroca };

function perguntaPara(pendencias: PendenciaDaTroca[]) {
  const campo = pendencias.find((p): p is keyof typeof PERGUNTAS => Object.hasOwn(PERGUNTAS, p));
  return campo === undefined ? null : ProximaPerguntaDaTrocaSchema.parse({ campo, pergunta: PERGUNTAS[campo] });
}

function pendenciasDoIntake(entrada: SolicitacaoDeTroca): PendenciaDaTroca[] {
  const pendencias: PendenciaDaTroca[] = [];
  if (!entrada.pedidoId) pendencias.push('pedido');
  if (!entrada.itemId) pendencias.push('item');
  if (!entrada.quantidade) pendencias.push('quantidade');
  if (!entrada.motivo) pendencias.push('motivo');
  if (entrada.tipo === 'troca' && !entrada.substitutoPretendido) pendencias.push('substituto');
  return pendencias;
}

async function conferirPedido(
  escopo: VerifiedOrganizationScope, entrada: SolicitacaoDeTroca, deps: LeiturasDaPreviaDeTroca, pendencias: PendenciaDaTroca[],
): Promise<{ fato: PreviaDaTroca['pedido']; pedidoRecusado: boolean }> {
  if (!entrada.pedidoId) return { fato: null, pedidoRecusado: false };
  const resultado = await deps.retrato(escopo, entrada.conversaId, entrada.pedidoId);
  if (resultado._tag === 'SemProva') {
    pendencias.unshift('confirmar_cliente');
    return { fato: null, pedidoRecusado: false };
  }
  if (resultado._tag !== 'Retrato' || resultado.retrato.pedido.id !== entrada.pedidoId) {
    return { fato: null, pedidoRecusado: true };
  }
  const { retrato } = resultado;
  const data = retrato.frescor.pedido.sincronizadoEm;
  if (retrato.frescor.pedido.situacao !== 'atual' || data === null) {
    pendencias.unshift('frescor');
    return { fato: null, pedidoRecusado: false };
  }
  const item = retrato.itens.find((i) => i.id === entrada.itemId);
  if (entrada.itemId && !item) return { fato: null, pedidoRecusado: true };
  if (item && entrada.quantidade && entrada.quantidade > item.quantidade) pendencias.unshift('quantidade_excede_item');
  return {
    pedidoRecusado: false,
    fato: {
      id: retrato.pedido.id, numero: retrato.pedido.numero, sincronizadoEm: data, fonte: 'espelho_bling',
      item: item ? {
        id: item.id, nome: item.nome, quantidadeComprada: item.quantidade,
        precoUnitarioCentavos: centavosDoPedido(item.valorUnitario), moeda: 'BRL',
      } : null,
    },
  };
}

function centavosDoPedido(valor: number): number {
  const partes = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(String(valor));
  if (partes === null) throw new Error('Preço unitário fora do contrato.');
  const centavos = Number(partes[1]) * 100 + Number((partes[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(centavos)) throw new Error('Preço unitário fora do contrato.');
  return centavos;
}

/** Somente leitura. Política D7 e ranking com compatibilidade comprovada ainda bloqueiam decisões. */
export async function prepararPreviaDaTroca(
  escopo: VerifiedOrganizationScope, entrada: SolicitacaoDeTroca, deps: LeiturasDaPreviaDeTroca,
): Promise<ResultadoDaPrevia> {
  const casoId = await deps.casoAberto(escopo, entrada.conversaId);
  if (!casoId) return { estado: 'sem_caso' };
  const pendencias = pendenciasDoIntake(entrada);
  const pedido = await conferirPedido(escopo, entrada, deps, pendencias);
  if (pedido.pedidoRecusado) return { estado: 'pedido_nao_encontrado' };
  const proximaPergunta = pendencias.some((p) => p === 'confirmar_cliente' || p === 'frescor')
    ? null : perguntaPara(pendencias);
  if (entrada.tipo === 'troca') pendencias.push('ranking');
  pendencias.push('politica');
  const estado = pendencias.some(p => p !== 'ranking' && p !== 'politica')
    ? 'incompleta' : pendencias.includes('ranking') ? 'requer_compatibilidade' : 'requer_politica';
  return { estado: 'ok', previa: PreviaDaTrocaSchema.parse({
    versao: 1, casoId, conversaId: entrada.conversaId, tipo: entrada.tipo, estado, pendencias, proximaPergunta,
    pedido: pedido.fato, quantidadeSolicitada: entrada.quantidade ?? null,
    motivo: entrada.motivo ?? null, substitutoPretendido: entrada.substitutoPretendido ?? null,
    rastreio: 'sem_fonte', podeAprovar: false,
  }) };
}
