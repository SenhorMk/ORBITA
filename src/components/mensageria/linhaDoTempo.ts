import type { ChatwootMessage } from '@/types';
import { autoriaDaMensagem, type Autoria } from './autoria';

/** Um item do histórico desenhado: um separador de dia ou uma mensagem. */
export type ItemDaLinhaDoTempo =
  | { readonly tipo: 'dia'; readonly chave: string; readonly rotulo: string }
  | {
    readonly tipo: 'mensagem';
    readonly chave: string;
    readonly mensagem: ChatwootMessage;
    readonly autoria: Autoria;
    /** Segue a mensagem anterior do mesmo autor, no mesmo dia e em poucos minutos: não repete o nome. */
    readonly continuacao: boolean;
  };

/** Até quanto tempo depois duas mensagens do mesmo autor ainda formam um grupo. */
const JANELA_DO_GRUPO_MS = 5 * 60_000;

function dataValida(iso: string | undefined): Date | null {
  if (!iso) return null;
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? null : data;
}

/** O dia local (AAAA-MM-DD) em que a mensagem foi criada. */
function chaveDoDia(data: Date): string {
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}

export function rotuloDoDia(data: Date, agora: Date = new Date()): string {
  const hoje = chaveDoDia(agora);
  const ontem = new Date(agora);
  ontem.setDate(agora.getDate() - 1);
  const chave = chaveDoDia(data);
  if (chave === hoje) return 'Hoje';
  if (chave === chaveDoDia(ontem)) return 'Ontem';
  return data.toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'long',
    ...(data.getFullYear() === agora.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function mesmoAutor(a: Autoria, b: Autoria): boolean {
  return a.tipo === b.tipo && a.rotulo === b.rotulo && a.detalhe === b.detalhe;
}

/**
 * O histórico em ordem, com um separador a cada dia e as mensagens seguidas do
 * mesmo autor agrupadas. Mensagem sem data válida não abre dia novo nem agrupa:
 * aparece sozinha, com o autor, e sem horário inventado.
 */
export function montarLinhaDoTempo(
  historico: readonly ChatwootMessage[],
  nomeDoContato: string | null | undefined,
  agora: Date = new Date(),
): ItemDaLinhaDoTempo[] {
  const itens: ItemDaLinhaDoTempo[] = [];
  let diaAtual: string | null = null;
  let anterior: { readonly autoria: Autoria; readonly data: Date | null } | null = null;

  for (const mensagem of historico) {
    const data = dataValida(mensagem.created_at);
    const autoria = autoriaDaMensagem(mensagem, nomeDoContato);
    if (data !== null && chaveDoDia(data) !== diaAtual) {
      diaAtual = chaveDoDia(data);
      itens.push({ tipo: 'dia', chave: `dia-${diaAtual}`, rotulo: rotuloDoDia(data, agora) });
      anterior = null;
    }
    const continuacao =
      anterior !== null &&
      autoria.tipo !== 'sistema' &&
      mesmoAutor(anterior.autoria, autoria) &&
      data !== null &&
      anterior.data !== null &&
      data.getTime() - anterior.data.getTime() <= JANELA_DO_GRUPO_MS;
    itens.push({ tipo: 'mensagem', chave: mensagem.id_local, mensagem, autoria, continuacao });
    anterior = { autoria, data };
  }
  return itens;
}
