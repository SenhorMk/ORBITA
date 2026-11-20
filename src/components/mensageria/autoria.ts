import type { ChatwootMessage } from '@/types';

/**
 * Quem escreveu uma mensagem do histórico, até onde o dado prova.
 *
 * O espelho traz só `message_type`, `sender_type` e `sender_name`. Isso basta
 * para separar a cliente, o atendimento e os eventos do sistema, mas **não**
 * separa a IA de uma pessoa: as respostas da IA e as dos atendentes saem pelo
 * mesmo canal (a outbox, com o token da conexão) e chegam ao espelho com o
 * mesmo `sender_type: 'user'`. Quem pediu o envio fica em `chatwoot_envios`,
 * que o navegador não lê. Por isso uma mensagem de saída aparece como
 * "Atendimento", com o nome da conta quando houver, e nunca como "IA" ou
 * "Atendente" por suposição.
 *
 * Notas privadas não aparecem aqui: o consumidor do webhook não as espelha
 * (MSG-009), e a outbox não as lista como respostas.
 */
export type TipoDeAutoria = 'cliente' | 'atendimento' | 'sistema';

export interface Autoria {
  readonly tipo: TipoDeAutoria;
  /** O rótulo principal da bolha: o nome da cliente, "Atendimento" ou "Evento". */
  readonly rotulo: string;
  /** Um complemento comprovado (a conta que enviou), quando existir. */
  readonly detalhe: string | null;
}

const ENTRADA: readonly ChatwootMessage['message_type'][] = ['incoming', '0'];
const SISTEMA: readonly ChatwootMessage['message_type'][] = ['activity', '2'];
const MODELO: readonly ChatwootMessage['message_type'][] = ['template', '3'];

function nomeLimpo(nome: string | null | undefined): string | null {
  const limpo = nome?.trim();
  return limpo ? limpo : null;
}

export function autoriaDaMensagem(mensagem: ChatwootMessage, nomeDoContato?: string | null): Autoria {
  if (SISTEMA.includes(mensagem.message_type)) return { tipo: 'sistema', rotulo: 'Evento', detalhe: null };

  const remetente = nomeLimpo(mensagem.sender_name);
  const deAtendente = mensagem.sender_type === 'user' || mensagem.sender_type === 'agent';
  if (ENTRADA.includes(mensagem.message_type) && !deAtendente) {
    return { tipo: 'cliente', rotulo: remetente ?? nomeLimpo(nomeDoContato) ?? 'Cliente', detalhe: null };
  }

  if (MODELO.includes(mensagem.message_type)) {
    return { tipo: 'atendimento', rotulo: 'Atendimento', detalhe: remetente ?? 'mensagem modelo' };
  }
  return { tipo: 'atendimento', rotulo: 'Atendimento', detalhe: remetente };
}
