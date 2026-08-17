import { NextResponse } from 'next/server';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';
import { Cliente } from '@/types';
import { verifySessionAndRole } from '@/lib/auth';

export async function POST(request: Request) {
  const logEntries: string[] = [];
  const timestamp = new Date().toISOString();

  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (session.role !== 'dono') {
      return NextResponse.json({ success: false, error: 'Acesso negado: apenas o dono pode realizar esta ação.' }, { status: 403 });
    }
    const blingClient = bling.forUser(session.tenant);

    const body = await request.json();
    const { id, bling_id, nome, email, telefone, cpf_cnpj, tipo, contribuinte, cep, endereco, numero, bairro, cidade, uf } = body as Partial<Cliente>;

    logEntries.push(`[${timestamp}] 👤 Processando sincronização de cliente: "${nome}" (Bling ID: ${bling_id || 'Novo'})`);

    if (!nome) {
      return NextResponse.json(
        {
          success: false,
          error: 'O nome do cliente é obrigatório.',
          logs: logEntries,
        },
        { status: 400 }
      );
    }

    const isRealBlingId = Boolean(bling_id && /^\d+$/.test(bling_id.trim()));
    let realBlingId = bling_id || `LOCAL-CLI-${Date.now()}`;
    let blingResult: any = null;
    let blingError: string | null = null;

    // 1. Tentar atualizar ou criar no Bling ERP v3 em tempo real
    if (isRealBlingId) {
      logEntries.push(`[${new Date().toISOString()}] 🔄 Enviando atualização (PUT) de contato para o Bling v3 (ID: ${bling_id})...`);
      try {
        blingResult = await blingClient.updateContato(bling_id!, {
          nome,
          email,
          telefone,
          cnpj: cpf_cnpj,
          tipo,
          contribuinte,
          cep,
          endereco,
          numero,
          bairro,
          cidade,
          uf
        });
        logEntries.push(`[${new Date().toISOString()}] ✅ Contato atualizado com sucesso no Bling ERP!`);
      } catch (putErr: any) {
        logEntries.push(`[${new Date().toISOString()}] ⚠️ PUT no Bling falhou (${putErr.message}). Tentando criar novo contato (POST)...`);
        try {
          blingResult = await blingClient.createContato({
            nome,
            email,
            telefone,
            cnpj: cpf_cnpj,
            tipo,
            contribuinte,
            cep,
            endereco,
            numero,
            bairro,
            cidade,
            uf
          });
          if (blingResult?.data?.id) {
            realBlingId = String(blingResult.data.id);
            logEntries.push(`[${new Date().toISOString()}] ✅ Contato criado com sucesso no Bling ERP! Novo Bling ID: ${realBlingId}`);
          }
        } catch (postErr: any) {
          blingError = postErr.message || String(postErr);
          logEntries.push(`[${new Date().toISOString()}] ❌ ERRO API BLING CONTATOS: ${blingError}`);
        }
      }
    } else {
      logEntries.push(`[${new Date().toISOString()}] ➕ Criando cadastro oficial de contato no Bling ERP v3 (POST)...`);
      try {
        blingResult = await blingClient.createContato({
          nome,
          email,
          telefone,
          cnpj: cpf_cnpj,
          tipo,
          contribuinte,
          cep,
          endereco,
          numero,
          bairro,
          cidade,
          uf
        });
        if (blingResult?.data?.id) {
          realBlingId = String(blingResult.data.id);
          logEntries.push(`[${new Date().toISOString()}] ✅ Contato cadastrado no Bling ERP com sucesso! Novo Bling ID real: ${realBlingId}`);
        }
      } catch (createErr: any) {
        blingError = createErr.message || String(createErr);
        logEntries.push(`[${new Date().toISOString()}] ❌ Erro de validação na API do Bling ao criar contato: ${blingError}`);
        return NextResponse.json({
          success: false,
          error: `Falha na validação do Bling ERP: ${blingError}`,
          details: blingError,
          logs: logEntries,
        }, { status: 400 });
      }
    }

    // 2. Persistir no Supabase Cache DB (apenas se a validação com o Bling for concluída)
    const updatedClientPayload: Cliente = {
      id: id || undefined,
      bling_id: realBlingId,
      nome,
      email: email || '',
      telefone: telefone || '',
      cpf_cnpj: cpf_cnpj || '',
    };

    logEntries.push(`[${new Date().toISOString()}] 💾 Persistindo cliente no Supabase...`);
    let savedClient: Cliente;
    try {
      savedClient = await clienteRepository.upsert(session.tenant, updatedClientPayload);
      logEntries.push(`[${new Date().toISOString()}] ✅ Cliente salvo no Supabase com sucesso! ID: ${savedClient.id}`);
    } catch (dbErr: any) {
      logEntries.push(`[${new Date().toISOString()}] ❌ ERRO SUPABASE CLIENTE: ${dbErr.message || dbErr}`);
      return NextResponse.json(
        {
          success: false,
          error: 'Falha ao salvar o cliente no banco de dados Supabase.',
          details: dbErr.message || String(dbErr),
          logs: logEntries,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      client: savedClient,
      blingResult,
      logs: logEntries,
    });

  } catch (err: any) {
    logEntries.push(`[${new Date().toISOString()}] 💥 ERRO CRÍTICO NA API DE CLIENTES: ${err.message || err}`);
    return NextResponse.json(
      {
        success: false,
        error: 'Erro crítico interno ao processar a atualização do cliente.',
        details: err.message || String(err),
        logs: logEntries,
      },
      { status: 500 }
    );
  }
}
