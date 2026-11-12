import { comFalhaSegura } from './rotas';

export const dynamic = 'force-dynamic';

/** O estado da verificação da conversa e os candidatos pelo telefone do contato. */
export const GET = comFalhaSegura('sac.verificacao.ler', 'lerVerificacao');

/** Confirmar o cliente da conversa ou desfazer a confirmação. */
export const POST = comFalhaSegura('sac.verificacao.alterar', 'alterarVerificacao');
