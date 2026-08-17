import { NextResponse } from 'next/server';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';
import { Produto } from '@/types';
import { validateProdutoForBling, sanitizeProductName } from '@/lib/utils';
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
    const userId = session.user.id;
    const blingClient = bling.forUser(userId);

    const body = await request.json();
    const { id, bling_id, nome, codigo, preco, estoque, tipo, situacao, formato, unidade, categoria_id } = body as Partial<Produto> & {
      tipo?: string;
      situacao?: string;
      formato?: string;
      unidade?: string;
    };

    if (!nome) {
      return NextResponse.json({ success: false, error: 'O nome do produto é obrigatório' }, { status: 400 });
    }

    logEntries.push(`[${timestamp}] 📦 Processando sincronização de produto: "${nome}" (ID Bling Atual: ${bling_id || 'Novo'})`);

    const validation = validateProdutoForBling({
      nome,
      preco: Number(preco) || 0,
      estoque: Number(estoque) || 0,
      codigo,
      tipo: tipo || 'P',
      situacao: situacao || 'A',
      formato: formato || 'S',
      unidade: unidade || 'UN'
    });

    if (!validation.valid) {
      logEntries.push(`[${new Date().toISOString()}] ❌ Validação falhou: ${validation.errors.join(' | ')}`);
      return NextResponse.json(
        {
          success: false,
          error: `Dados inválidos para o Bling ERP: ${validation.errors[0]}`,
          details: validation.errors.join('\n'),
          logs: logEntries,
        },
        { status: 400 }
      );
    }

    const nomeSanitizado = sanitizeProductName(nome!);
    let realBlingId = bling_id;
    let blingResult: any = null;
    let blingError: string | null = null;

    // 1. Tentar atualizar ou criar no Bling ERP v3 em tempo real
    if (bling_id && /^\d+$/.test(bling_id)) {
      // Produto já existe no Bling (ID numérico) -> PUT
      logEntries.push(`[${new Date().toISOString()}] 🔄 Atualizando produto existente no Bling ERP v3 (PUT)...`);
      try {
        blingResult = await blingClient.updateProduto(bling_id, {
          nome: nomeSanitizado,
          codigo,
          preco: Number(preco),
          estoque: Number(estoque),
          tipo,
          situacao,
          formato,
          unidade
        });
        logEntries.push(`[${new Date().toISOString()}] ✅ Produto atualizado no Bling ERP com sucesso!`);
        
        // Sincronizar estoque no Bling se fornecido
        if (estoque !== undefined) {
          logEntries.push(`[${new Date().toISOString()}] 📦 Lançando estoque de ${estoque} para o produto existente...`);
          try {
            await blingClient.lancamentoEstoque(bling_id, Number(estoque), 'B');
            logEntries.push(`[${new Date().toISOString()}] ✅ Estoque lançado com sucesso!`);
          } catch (estoqueErr: any) {
            throw new Error(`Falha ao lançar estoque no Bling: ${estoqueErr.message || estoqueErr}`);
          }
        }
      } catch (updateErr: any) {
        blingError = updateErr.message || String(updateErr);
        logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao atualizar no Bling: ${blingError}`);
      }
    } else {
      // É um produto sem ID numérico no Bling (ex: prod-teste-123 ou local). Criar diretamente no Bling!
      logEntries.push(`[${new Date().toISOString()}] ➕ Verificando existência ou criando cadastro oficial do produto no Bling ERP v3...`);
      try {
        let existingBlingId: string | null = null;
        
        // Evitar duplicação: buscar por SKU antes
        if (codigo) {
          const searchRes = await blingClient.getProdutos(1, 1, codigo);
          if (searchRes && searchRes.length > 0 && searchRes[0].id) {
            existingBlingId = String(searchRes[0].id);
            logEntries.push(`[${new Date().toISOString()}] ℹ️ Produto já existe no Bling com ID ${existingBlingId} (buscado por código). Atualizando (PUT)...`);
          }
        }

        if (existingBlingId) {
          blingResult = await blingClient.updateProduto(existingBlingId, {
            nome: nomeSanitizado,
            codigo,
            preco: Number(preco),
            estoque: Number(estoque),
            tipo,
            situacao,
            formato,
            unidade
          });
          realBlingId = existingBlingId;
          logEntries.push(`[${new Date().toISOString()}] ✅ Produto existente atualizado no Bling ERP com sucesso!`);
          
          if (estoque !== undefined) {
            logEntries.push(`[${new Date().toISOString()}] 📦 Lançando estoque de ${estoque} para o produto existente...`);
            await blingClient.lancamentoEstoque(existingBlingId, Number(estoque), 'B');
            logEntries.push(`[${new Date().toISOString()}] ✅ Estoque lançado com sucesso!`);
          }
        } else {
          blingResult = await blingClient.createProduto({
            nome: nomeSanitizado,
            codigo,
            preco: Number(preco),
            estoque: Number(estoque),
            tipo,
            situacao,
            formato,
            unidade
          });

          if (blingResult?.data?.id) {
            realBlingId = String(blingResult.data.id);
            logEntries.push(`[${new Date().toISOString()}] ✅ Produto cadastrado no Bling ERP com sucesso! Novo Bling ID real: ${realBlingId}`);
            
            if (Number(estoque) > 0) {
              logEntries.push(`[${new Date().toISOString()}] 📦 Lançando estoque inicial de ${estoque}...`);
              await blingClient.lancamentoEstoque(realBlingId, Number(estoque), 'B');
              logEntries.push(`[${new Date().toISOString()}] ✅ Estoque inicial lançado com sucesso!`);
            }
          } else {
            throw new Error('API do Bling não retornou o ID numérico do produto criado.');
          }
        }
      } catch (createErr: any) {
        blingError = createErr.message || String(createErr);
        logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao criar no Bling: ${blingError}`);
      }
    }

    // REGRA DE OURO: Se o Bling falhar, abortar IMEDIATAMENTE e não salvar no Supabase
    if (blingError) {
      return NextResponse.json({
        success: false,
        error: `Erro ao salvar no Bling ERP: ${blingError}`,
        details: blingError,
        logs: logEntries,
      }, { status: 400 });
    }

    // 2. Persistir alterações no Supabase Cache DB com o bling_id real
    const updatedProductPayload: Produto = {
      id: id || undefined,
      bling_id: realBlingId || `LOCAL-${Date.now()}`,
      nome: nomeSanitizado,
      codigo: codigo || '',
      preco: Number(preco) || 0,
      estoque: Number(estoque) || 0,
      categoria_id: categoria_id || undefined,
    };

    logEntries.push(`[${new Date().toISOString()}] 💾 Persistindo registro no banco Supabase...`);
    let savedProduct: Produto;
    try {
      savedProduct = await produtoRepository.upsert(userId, updatedProductPayload);
      logEntries.push(`[${new Date().toISOString()}] ✅ Registro persistido no Supabase! ID: ${savedProduct.id}`);
    } catch (dbErr: any) {
      logEntries.push(`[${new Date().toISOString()}] ❌ ERRO SUPABASE: ${dbErr.message || dbErr}`);
      return NextResponse.json(
        {
          success: false,
          error: 'Falha ao salvar no banco de dados Supabase.',
          details: dbErr.message || String(dbErr),
          logs: logEntries,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      product: savedProduct,
      blingResult,
      logs: logEntries,
    });
  } catch (err: any) {
    logEntries.push(`[${new Date().toISOString()}] 💥 ERRO CRÍTICO NA API DE PRODUTOS: ${err.message || err}`);
    return NextResponse.json(
      {
        success: false,
        error: 'Erro crítico interno ao processar a atualização do produto.',
        details: err.message || String(err),
        logs: logEntries,
      },
      { status: 500 }
    );
  }
}
