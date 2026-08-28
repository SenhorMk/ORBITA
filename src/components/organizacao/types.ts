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
