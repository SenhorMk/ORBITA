import { descreverErro } from '../erroLegivel';

/**
 * A frase que a tela de entrada mostra quando o login não acontece.
 *
 * O `signInWithPassword` do `supabase-js` rejeita com a mensagem do provedor,
 * em inglês e no vocabulário dele: `Invalid login credentials`,
 * `Email not confirmed`, `Failed to fetch`. Essa string ia direto para o banner
 * de erro — a primeira tela do produto, e a primeira que qualquer pessoa vê,
 * respondia em outro idioma e com um termo de API.
 *
 * O que muda aqui é **o texto, não o desfecho**. Cada caso conhecido vira uma
 * frase em português que diz a mesma coisa que o provedor disse, sem agrupar
 * causas diferentes: senha errada, e-mail não confirmado, servidor inalcançável
 * e excesso de tentativas continuam sendo quatro respostas distintas, porque
 * são quatro coisas distintas de se fazer a seguir. O que não é reconhecido
 * passa inteiro, pelo `descreverErro` — inventar uma explicação genérica para
 * uma falha desconhecida seria trocar um texto feio por um texto falso.
 */
const TRADUCOES: ReadonlyArray<{ quando: RegExp; frase: string }> = [
  {
    quando: /invalid login credentials|invalid_credentials/i,
    frase: 'E-mail ou senha inválidos.',
  },
  {
    quando: /email not confirmed|email_not_confirmed/i,
    frase: 'Este e-mail ainda não foi confirmado. Confirme o cadastro pelo link enviado antes de entrar.',
  },
  {
    quando: /failed to fetch|networkerror|load failed|fetch failed/i,
    frase:
      'Não foi possível falar com o servidor de autenticação. Verifique a conexão e tente de novo — '
      + 'a senha não chegou a ser conferida.',
  },
  {
    quando: /rate limit|too many requests|over_request_rate_limit/i,
    frase: 'Tentativas demais em pouco tempo. Espere um momento antes de tentar de novo.',
  },
];

export function mensagemDeFalhaDeLogin(erro: unknown): string {
  const bruto = descreverErro(erro);
  return TRADUCOES.find(({ quando }) => quando.test(bruto))?.frase ?? bruto;
}
