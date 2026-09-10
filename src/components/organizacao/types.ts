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
}
