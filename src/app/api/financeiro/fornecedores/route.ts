import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

export const dynamic = 'force-dynamic';

interface BlingContatoTipo {
  readonly id?: number | string;
}

interface BlingContato {
  readonly id?: number | string;
  readonly nome?: string;
  readonly tipo?: string | number;
  readonly tipos?: readonly (BlingContatoTipo | string | number)[];
}

interface FornecedorRequestBody {
  readonly cnpj?: string;
  readonly nome?: string;
  readonly nome_fantasia?: string;
  readonly logradouro?: string;
  readonly numero?: string;
  readonly bairro?: string;
  readonly municipio?: string;
  readonly uf?: string;
  readonly cep?: string;
  readonly telefone?: string;
  readonly email?: string;
}

export async function GET(request: Request) {
  try {
    // Ticket 22 — o portão de sessão legado saiu daqui. Ele lia o papel de
    // `app_metadata`, que só os usuários históricos têm, e era redundante: o
    // escopo de organização abaixo já resolve identidade e vínculo, e já
    // distingue 401 (sem sessão), 403 (sem vínculo) e 503 (indisponível).

    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const blingClient = bling.forVerifiedOrganization(scopeResult.scope);

    // Buscamos os primeiros 200 contatos
    const contatos: BlingContato[] = await blingClient.getClientes(1, 200);

    // Filtramos fornecedores (tipo F no Bling) ou retornamos todos
    const fornecedores = contatos.filter((c: BlingContato) => {
      const tipos = c.tipos || c.tipo;
      if (!tipos) return true;
      if (Array.isArray(tipos)) {
        return tipos.some((t) => {
          if (typeof t === 'object' && t !== null && 'id' in t) {
            return t.id === 2 || t.id === '2';
          }
          return t === 2 || t === 'F' || t === '2';
        });
      }
      return tipos === 'F' || tipos === 2 || tipos === '2';
    });

    return NextResponse.json({ success: true, data: fornecedores });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro ao buscar fornecedores';
    console.error('Erro ao buscar fornecedores:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// POST: Cria um novo fornecedor real no Bling com dados da BrasilAPI
export async function POST(request: Request) {
  try {
    // Ticket 22 — o portão de sessão legado saiu daqui. Ele lia o papel de
    // `app_metadata`, que só os usuários históricos têm, e era redundante: o
    // escopo de organização abaixo já resolve identidade e vínculo, e já
    // distingue 401 (sem sessão), 403 (sem vínculo) e 503 (indisponível).

    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const blingClient = bling.forVerifiedOrganization(scopeResult.scope);

    const body = (await request.json()) as FornecedorRequestBody;
    const { cnpj, nome, logradouro, numero, bairro, municipio, uf, cep, telefone, email } = body;

    if (!cnpj || !nome) {
      return NextResponse.json({ success: false, error: 'CNPJ e nome são obrigatórios.' }, { status: 400 });
    }

    const fornecedorCriado = await blingClient.createContato({
      nome,
      cnpj,
      tipo: 'J',
      indicadorIe: 1,
      endereco: logradouro,
      numero: numero || 'S/N',
      bairro: bairro || undefined,
      cidade: municipio || undefined,
      uf: uf || undefined,
      cep: cep ? cep.replace(/\D/g, '') : undefined,
      telefone: telefone || undefined,
      email: email || undefined,
    });

    return NextResponse.json({ success: true, data: fornecedorCriado });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro interno ao criar fornecedor';
    console.error('Erro ao criar fornecedor:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
