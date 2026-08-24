import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { bling } from '@/services/bling';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(request: Request) {
  const logEntries: string[] = [];
  try {
    const session = await verifySessionAndRole(request);
    const userId = session?.tenant.id;
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const blingClient = bling.forUser(session.tenant);
    const body = await request.json();
    const { syncBling, contatoId, itens, parcelas: _parcelas, total, formaPagamento, desconto, frete, observacoes } = body;

    logEntries.push(`[${new Date().toISOString()}] Recebido requisição de Pedido Manual (Sync Bling: ${syncBling})`);

    // 1. Resolver Cliente local
    let localClienteId: string | null = null;
    let numericBlingId: number | null = null;

    if (!contatoId) {
      return NextResponse.json({
        success: false,
        error: 'É necessário selecionar um cliente para realizar a venda.',
        logs: logEntries
      }, { status: 400 });
    }

    // Buscar cliente no Supabase por ID (UUID) ou por bling_id
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(contatoId));
    let query = supabaseServer.from('clientes').select('*').eq('user_id', userId);

    if (isUUID) {
      query = query.or(`id.eq.${contatoId},bling_id.eq.${contatoId}`);
    } else {
      query = query.eq('bling_id', contatoId);
    }

    const { data: clienteData, error: _dbErr } = await query.maybeSingle();

    if (!clienteData) {
      return NextResponse.json({
        success: false,
        error: `Cliente não encontrado no banco de dados local (ID: ${contatoId}).`,
        logs: logEntries
      }, { status: 400 });
    }

    localClienteId = clienteData.id;
    logEntries.push(`[${new Date().toISOString()}] 👤 Cliente local: "${clienteData.nome}" (ID: ${localClienteId})`);

    // Verificar se já tem Bling ID numérico válido
    if (clienteData.bling_id && /^\d+$/.test(String(clienteData.bling_id).trim())) {
      numericBlingId = Number(clienteData.bling_id);
      logEntries.push(`[${new Date().toISOString()}] ✅ ID do contato no Bling verificado: ${numericBlingId}`);
    } else if (syncBling) {
      // Registrar obrigatoriamente o contato no Bling ERP v3 para obter o ID oficial
      logEntries.push(`[${new Date().toISOString()}] ➕ Cliente não possui cadastro no Bling. Enviando cadastro de contato para o Bling...`);
      try {
        const resCriar = (await blingClient.createContato({
          nome: clienteData.nome,
          email: clienteData.email,
          telefone: clienteData.telefone,
          cnpj: clienteData.cpf_cnpj,
        })) as { data?: { id?: number | string } };

        if (resCriar?.data?.id) {
          numericBlingId = Number(resCriar.data.id);
          logEntries.push(`[${new Date().toISOString()}] ✅ Contato cadastrado no Bling ERP com sucesso! Bling ID: ${numericBlingId}`);

          // Atualizar o cliente no Supabase com o ID oficial do Bling
          await supabaseServer
            .from('clientes')
            .update({ bling_id: String(numericBlingId) })
            .eq('id', localClienteId);
        } else {
          throw new Error('Bling confirmou a criação do contato mas não retornou um ID numérico válido.');
        }
      } catch (cErr: unknown) {
        const cErrMsg = cErr instanceof Error ? cErr.message : String(cErr);
        logEntries.push(`[${new Date().toISOString()}] ❌ Erro ao cadastrar contato no Bling: ${cErrMsg}`);
        return NextResponse.json({
          success: false,
          error: `Não foi possível cadastrar o contato no Bling para a venda: ${cErrMsg}`,
          logs: logEntries
        }, { status: 400 });
      }
    }

    // 2. Validar produtos e estoque
    interface ItemValidado {
      id?: string;
      codigo?: string | null;
      bling_id?: string | null;
      nome?: string;
      quantidade_compra: number;
      valor_unitario: number;
    }

    const itensValidados: ItemValidado[] = [];
    for (const i of itens) {
      const { data: pData } = await supabaseServer
        .from('produtos')
        .select('id, codigo, bling_id, nome, estoque, estoque_reservado')
        .eq('user_id', userId)
        .eq(i.produto_id ? 'id' : 'codigo', i.produto_id || i.codigo)
        .maybeSingle();

      if (!pData) {
        return NextResponse.json({ success: false, error: `Produto local não encontrado: ${i.codigo || i.produto_id}`, logs: logEntries }, { status: 400 });
      }

      const estoqueAtual = pData.estoque || 0;
      const reservado = pData.estoque_reservado || 0;
      const disponivel = estoqueAtual - reservado;

      if (disponivel < i.quantidade) {
         return NextResponse.json({ success: false, error: `Estoque insuficiente para ${pData.nome}. Disponível: ${disponivel}, Tentou comprar: ${i.quantidade}`, logs: logEntries }, { status: 400 });
      }

      itensValidados.push({
        ...pData,
        quantidade_compra: i.quantidade,
        valor_unitario: i.valor_unitario
      });
    }

    const today = new Date();
    const dataStr = today.toISOString().split('T')[0];
    let realBlingId = `MANUAL-${Math.random().toString(36).substring(2, 15)}`;
    let realNumero = realBlingId;

    // 3. Sincronizar Venda no Bling ERP
    if (syncBling) {
      if (!numericBlingId) {
        return NextResponse.json({
          success: false,
          error: 'Id do contato da venda é obrigatório para enviar ao Bling ERP.',
          logs: logEntries
        }, { status: 400 });
      }

      logEntries.push(`[${new Date().toISOString()}] Enviando pedido de venda ao Bling ERP (Contato ID: ${numericBlingId})...`);

      interface BlingItemPayload {
        descricao?: string;
        quantidade: number;
        valor: number;
        produto?: { id: number };
        codigo?: string;
      }

      interface BlingPedidoCreatePayload {
        contato: { id: number };
        data: string;
        situacao: { id: number };
        itens: BlingItemPayload[];
        observacoes?: string;
        desconto?: { valor: number; unidade: string };
        transporte?: { frete: number };
      }

      const payload: BlingPedidoCreatePayload = {
        contato: { id: numericBlingId },
        data: dataStr,
        situacao: { id: 9 }, // 9 = Atendido
        itens: itensValidados.map((item) => {
          const payloadItem: BlingItemPayload = {
            descricao: item.nome,
            quantidade: item.quantidade_compra,
            valor: item.valor_unitario
          };
          if (item.bling_id && /^\d+$/.test(String(item.bling_id))) {
            payloadItem.produto = { id: parseInt(item.bling_id, 10) };
          } else if (item.codigo) {
            payloadItem.codigo = item.codigo;
          }
          return payloadItem;
        })
      };

      if (observacoes && observacoes.trim()) payload.observacoes = observacoes;
      if (desconto && Number(desconto) > 0) payload.desconto = { valor: Number(desconto), unidade: 'REAL' };
      if (frete && Number(frete) > 0) payload.transporte = { frete: Number(frete) };

      try {
        const blingRes = (await blingClient.createPedido(payload)) as { data?: { id?: number | string; numero?: number | string } };
        if (blingRes?.data?.id) {
          realBlingId = String(blingRes.data.id);
          realNumero = blingRes.data.numero ? String(blingRes.data.numero) : realBlingId;
          logEntries.push(`[${new Date().toISOString()}] ✅ Pedido de venda criado no Bling com sucesso! ID: ${realBlingId}`);

          // Baixa de estoque no Bling
          try {
            for (const item of itensValidados) {
              if (item.bling_id && /^\d+$/.test(String(item.bling_id))) {
                await blingClient.lancarBaixaEstoqueProduto(item.bling_id, item.quantidade_compra, item.valor_unitario);
              }
            }
            logEntries.push(`[${new Date().toISOString()}] ✅ Baixa de estoque efetuada no Bling!`);
          } catch (e: unknown) {
            const eMsg = e instanceof Error ? e.message : String(e);
            logEntries.push(`[${new Date().toISOString()}] ⚠️ Alerta na baixa de estoque do Bling: ${eMsg}`);
          }
        } else {
          throw new Error('Bling retornou confirmação sem informar o ID da venda.');
        }
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logEntries.push(`[${new Date().toISOString()}] ❌ Erro na API Bling ao criar pedido: ${errMessage}`);
        return NextResponse.json({
          success: false,
          error: `Erro na API Bling ao criar pedido: ${errMessage}`,
          logs: logEntries
        }, { status: 400 });
      }
    }

    // 4. Salvar no Banco Local (Supabase)
    logEntries.push(`[${new Date().toISOString()}] 💾 Registrando venda no banco de dados local...`);

    // a) Criar Pedido
    const { data: novoPedido, error: pedErr } = await supabaseServer.from('pedidos').insert({
      user_id: userId,
      cliente_id: localClienteId,
      bling_id: realBlingId,
      numero: realNumero,
      data: new Date().toISOString(),
      total: total,
      desconto: Number(desconto) || 0,
      frete: Number(frete) || 0,
      status: 'Entregue',
      origem: 'Loja Física / Manual',
      forma_pagamento: formaPagamento,
      observacao: observacoes
    }).select('id').single();

    if (pedErr) throw new Error(`Erro ao criar pedido local: ${pedErr.message}`);

    // b) Registrar Itens, dar baixa no estoque local e registrar movimentação
    for (const item of itensValidados) {
      await supabaseServer.from('itens_pedido').insert({
        user_id: userId,
        pedido_id: novoPedido.id,
        produto_id: item.id,
        quantidade: item.quantidade_compra,
        valor_unitario: item.valor_unitario
      });

      // Baixa no estoque local de forma atômica para evitar overselling (Race condition)
      const { error: stockError } = await supabaseServer.rpc('decrement_estoque', {
        p_user_id: userId,
        p_produto_id: item.id,
        p_qty: item.quantidade_compra,
      });

      if (stockError) {
        throw new Error(`Erro ao atualizar estoque local: ${stockError.message}`);
      }

      // Movimentação de estoque
      await supabaseServer.from('movimentacao_estoque').insert({
        user_id: userId,
        produto_id: item.id,
        tipo: 'SAIDA',
        origem: `PEDIDO_MANUAL:${novoPedido.id}`,
        quantidade: item.quantidade_compra
      });
    }

    // c) Registrar Financeiro
    await supabaseServer.from('titulos_financeiros').insert({
      user_id: userId,
      tipo: 'receber',
      situacao: 'pago',
      valor: total,
      data_vencimento: dataStr,
      data_pagamento: dataStr,
      descricao: `Venda Manual #${realNumero}`
    });

    logEntries.push(`[${new Date().toISOString()}] ✅ Venda e estoque registrados com sucesso! (ID Local: ${novoPedido.id})`);

    return NextResponse.json({
      success: true,
      pedidoId: novoPedido.id,
      logs: logEntries
    });

  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logEntries.push(`[${new Date().toISOString()}] 💥 Erro Crítico: ${errMessage}`);
    return NextResponse.json({
      success: false,
      error: `Erro interno: ${errMessage}`,
      logs: logEntries
    }, { status: 500 });
  }
}
