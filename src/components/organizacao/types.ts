export interface Organizacao {
  id: string;
  nome: string;
  slug: string;
}

export interface ActiveOrg {
  organizacao: Organizacao;
  papel: 'owner' | 'admin' | 'member';
}

export interface Convite {
  id: string;
  email: string;
  papel: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export interface MembroOrganizacao {
  user_id: string;
  papel: 'owner' | 'admin' | 'member';
  created_at: string;
}

/**
 * O convite recém-criado, **com o código**, como a tela precisa dele.
 *
 * Ticket 06: a entrega é manual, então o token é o produto da criação — quem
 * criou o convite precisa dele para enviar por WhatsApp, e-mail ou outro
 * canal. Ele vive no estado de React da tela e em nenhum outro lugar: não vai
 * para `localStorage`, não vai para log, e desaparece quando o modal fecha.
 *
 * `email` e `papel` acompanham o código porque é o que a tela repete de volta
 * para quem vai entregá-lo: um código sem destinatário não diz para quem é.
 */
export interface ConviteCriado {
  readonly id: string;
  readonly token: string;
  readonly email: string;
  readonly papel: 'admin' | 'member';
  /**
   * A organização para a qual este convite foi criado.
   *
   * Ela viaja junto porque o código sobrevive na tela ao fim da requisição, e
   * um código sem tenant seria um código que a proxima troca de organização
   * poderia fazer parecer de outra. A tela usa isto para dizer, ao lado do
   * codigo, de qual organização ele é — e para impedir a troca enquanto ele
   * estiver na tela.
   */
  readonly organizacaoId: string;
}

/**
 * O que a tela aprende ao aceitar um convite.
 *
 * O aceite são **duas etapas** no servidor, e a primeira commita sozinha: o
 * convite é consumido antes de o contexto ser resolvido. Um booleano juntaria
 * "entrou e o contexto está resolvido" com "entrou e o contexto ficou por
 * resolver" — e a segunda, dita como sucesso normal, manda a pessoa procurar a
 * organização onde ela não aparece; dita como falha, manda repetir um código
 * que já não existe.
 */
export interface ResultadoDoAceite {
  /** O convite foi consumido e a membership existe. */
  readonly aceito: boolean;
  /**
   * `organizacao_ativada` — a organização ingressada passou a ser a ativa.
   * `selecao_anterior_preservada` — já havia seleção válida, e ela continua.
   * `nao_resolvido` — aceito, mas o servidor não resolveu a organização ativa.
   */
  readonly contexto?: 'organizacao_ativada' | 'selecao_anterior_preservada' | 'nao_resolvido';
  /** O que dizer a quem aceitou, quando o contexto ficou por resolver. */
  readonly aviso?: string;
}
