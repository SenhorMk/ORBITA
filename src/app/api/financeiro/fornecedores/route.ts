import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { verifySessionAndRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET: Busca todos os fornecedores cadastrados no Bling
export async function GET(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const blingClient = bling.forUser(session.tenant);

    // Buscamos os primeiros 200 contatos
    const contatos = await blingClient.getClientes(1, 200);

    // Filtramos fornecedores (tipo F no Bling) ou retornamos todos
    const fornecedores = contatos.filter((c: any) => {
      // Bling retorna tipo como numero ou string. Tipo 2 = Fornecedor, "F" = Fornecedor
      const tipos = c.tipos || c.tipo;
      if (!tipos) return true; // sem filtro se não tem o campo
      if (Array.isArray(tipos)) return tipos.some((t: any) => t.id === 2 || t === 'F' || t === 2);
      return tipos === 'F' || tipos === 2;
    });

    return NextResponse.json({ success: true, data: fornecedores });
  } catch (error: any) {
    console.error('Erro ao buscar fornecedores:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST: Cria um novo fornecedor real no Bling com dados da BrasilAPI
export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const blingClient = bling.forUser(session.tenant);

    const body = await request.json();
    const { cnpj, nome, nome_fantasia, logradouro, numero, bairro, municipio, uf, cep, telefone, email } = body;

    if (!cnpj || !nome) {
      return NextResponse.json({ success: false, error: 'CNPJ e nome são obrigatórios.' }, { status: 400 });
    }

    // Monta payload no formato da API v3 do Bling
    const payload: any = {
      nome,
      fantasia: nome_fantasia || nome,
      tipoPessoa: 'J', // Jurídica
      situacao: 'A', // Ativo
      numeroDocumento: cnpj.replace(/\D/g, ''),
      tipos: [{ id: 2 }], // 2 = Fornecedor no Bling v3
    };

    // Endereço (opcional mas incluído se disponível)
    if (logradouro) {
      payload.endereco = {
        endereco: logradouro,
        numero: numero || 'S/N',
        bairro: bairro || '',
        municipio: municipio || '',
        uf: uf || '',
        cep: cep ? cep.replace(/\D/g, '') : '',
      };
    }

    if (telefone) payload.telefone = telefone;
    if (email) payload.email = email;

    const fornecedorCriado = await blingClient.createContato(payload);

    return NextResponse.json({ success: true, data: fornecedorCriado });
  } catch (error: any) {
    console.error('Erro ao criar fornecedor:', error);
    return NextResponse.json({ success: false, error: error.message || 'Erro interno ao criar fornecedor' }, { status: 500 });
  }
}
