import { NextResponse } from 'next/server';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';
import { Produto } from '@/types';
import { validateProdutoForBling, sanitizeProductName } from '@/lib/utils';
import { verifySessionAndRole } from '@/lib/auth';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';

type BlingClient = ReturnType<typeof bling.forUser>;

interface ProdutoBlingFields {
  nomeSanitizado: string;
  codigo: string | undefined;
  preco: number | undefined;
  estoque: number | undefined;
  tipo: string | undefined;
  situacao: string | undefined;
  formato: string | undefined;
  unidade: string | undefined;
}

/** Resultado da sincronização (PUT/POST com fallback) do produto no Bling ERP. */
interface ProdutoBlingSyncResult {
  readonly realBlingId: string | undefined;
  readonly blingResult: unknown;
  readonly blingError: string | null;
}

function buildBlingProdutoPayload(fields: ProdutoBlingFields) {
  return {
    nome: fields.nomeSanitizado,
    codigo: fields.codigo,
    preco: Number(fields.preco),
    estoque: Number(fields.estoque),
    tipo: fields.tipo,
    situacao: fields.situacao,
    formato: fields.formato,
    unidade: fields.unidade,
  };
}

/** Atualiza (PUT) um produto já cadastrado no Bling com o novo ID/dados, opcionalmente lançando estoque. */
async function updateExistingProdutoInBling(
  blingClient: BlingClient,
  existingBlingId: string,
  fields: ProdutoBlingFields,
  logEntries: string[],
): Promise<unknown> {
  const blingResult = await blingClient.updateProduto(existingBlingId, buildBlingProdutoPayload(fields));
  logEntries.push(`[${new Date().toISOString()}] ✅ Produto atualizado no Bling ERP com sucesso!`);

  if (fields.estoque !== undefined) {
    logEntries.push(`[${new Date().toISOString()}] 📦 Lançando estoque de ${fields.estoque} para o produto existente...`);
    try {
      await blingClient.lancamentoEstoque(existingBlingId, Number(fields.estoque), 'B');
      logEntries.push(`[${new Date().toISOString()}] ✅ Estoque lançado com sucesso!`);
    } catch (estoqueErr: unknown) {
      const estoqueMsg = estoqueErr instanceof Error ? estoqueErr.message : String(estoqueErr);
      throw new Error(`Falha ao lançar estoque no Bling: ${estoqueMsg}`);
    }
  }
  return blingResult;
}

/** Sincroniza um produto sem ID Bling numérico ainda conhecido: busca por SKU antes de criar, evitando duplicação. */
async function createOrLinkProdutoInBling(
  blingClient: BlingClient,
  codigo: string | undefined,
  fields: ProdutoBlingFields,
  logEntries: string[],
): Promise<{ realBlingId: string; blingResult: unknown }> {
  let existingBlingId: string | null = null;

  if (codigo) {
    const searchRes = await blingClient.getProdutos(1, 1, codigo);
    if (searchRes && searchRes.length > 0 && searchRes[0].id) {
      existingBlingId = String(searchRes[0].id);
      logEntries.push(`[${new Date().toISOString()}] ℹ️ Produto já existe no Bling com ID ${existingBlingId} (buscado por código). Atualizando (PUT)...`);
    }
  }

  if (existingBlingId) {
    const blingResult = await updateExistingProdutoInBling(blingClient, existingBlingId, fields, logEntries);
    return { realBlingId: existingBlingId, blingResult };
  }

  const blingResult = await blingClient.createProduto(buildBlingProdutoPayload(fields));
  const createdData = (blingResult as { data?: { id?: number | string } })?.data;
  if (!createdData?.id) {
    throw new Error('API do Bling não retornou o ID numérico do produto criado.');
  }

  const realBlingId = String(createdData.id);
  logEntries.push(`[${new Date().toISOString()}] ✅ Produto cadastrado no Bling ERP com sucesso! Novo Bling ID real: ${realBlingId}`);

  if (Number(fields.estoque) > 0) {
    logEntries.push(`[${new Date().toISOString()}] 📦 Lançando estoque inicial de ${fields.estoque}...`);
    await blingClient.lancamentoEstoque(realBlingId, Number(fields.estoque), 'B');
    logEntries.push(`[${new Date().toISOString()}] ✅ Estoque inicial lançado com sucesso!`);
  }

  return { realBlingId, blingResult };
}

/**
 * Tenta atualizar (PUT) ou criar (POST) o produto no Bling ERP. Nunca lança:
 * falhas são reportadas via `blingError` para o chamador decidir se aborta
 * antes de persistir no Supabase (regra de ouro: Bling é a fonte da verdade).
 */
async function syncProdutoToBling(
  blingClient: BlingClient,
  bling_id: string | undefined,
  codigo: string | undefined,
  fields: ProdutoBlingFields,
  logEntries: string[],
): Promise<ProdutoBlingSyncResult> {
  if (bling_id && /^\d+$/.test(bling_id)) {
    // Produto já existe no Bling (ID numérico) -> PUT
    logEntries.push(`[${new Date().toISOString()}] 🔄 Atualizando produto existente no Bling ERP v3 (PUT)...`);
    try {
      const blingResult = await updateExistingProdutoInBling(blingClient, bling_id, fields, logEntries);
      return { realBlingId: bling_id, blingResult, blingError: null };
    } catch (updateErr: unknown) {
      const blingError = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao atualizar no Bling: ${blingError}`);
      return { realBlingId: bling_id, blingResult: null, blingError };
    }
  }

  // É um produto sem ID numérico no Bling (ex: prod-teste-123 ou local). Criar diretamente no Bling!
  logEntries.push(`[${new Date().toISOString()}] ➕ Verificando existência ou criando cadastro oficial do produto no Bling ERP v3...`);
  try {
    const { realBlingId, blingResult } = await createOrLinkProdutoInBling(blingClient, codigo, fields, logEntries);
    return { realBlingId, blingResult, blingError: null };
  } catch (createErr: unknown) {
    const blingError = createErr instanceof Error ? createErr.message : String(createErr);
    logEntries.push(`[${new Date().toISOString()}] ⚠️ Falha ao criar no Bling: ${blingError}`);
    return { realBlingId: bling_id, blingResult: null, blingError };
  }
}

/** Persiste o produto sincronizado no cache local do Supabase e monta a resposta final. */
async function persistProdutoLocalAndRespond(
  scope: Parameters<typeof produtoRepository.upsert>[0],
  updatedProductPayload: Produto,
  blingResult: unknown,
  logEntries: string[],
): Promise<NextResponse> {
  logEntries.push(`[${new Date().toISOString()}] 💾 Persistindo registro no banco Supabase...`);
  try {
    const savedProduct = await produtoRepository.upsert(scope, updatedProductPayload);
    logEntries.push(`[${new Date().toISOString()}] ✅ Registro persistido no Supabase! ID: ${savedProduct.id}`);
    return NextResponse.json({
      success: true,
      product: savedProduct,
      blingResult,
      logs: logEntries,
    });
  } catch (dbErr: unknown) {
    const dbErrMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
    logEntries.push(`[${new Date().toISOString()}] ❌ ERRO SUPABASE: ${dbErrMsg}`);
    return NextResponse.json(
      {
        success: false,
        error: 'Falha ao salvar no banco de dados Supabase.',
        details: dbErrMsg,
        logs: logEntries,
      },
      { status: 500 }
    );
  }
}

type ProdutoInputBody = Partial<Produto> & {
  tipo?: string;
  situacao?: string;
  formato?: string;
  unidade?: string;
};

/** Resultado da leitura e validação (ASVS) do corpo da requisição de produto. */
type ProdutoInputResult =
  | { readonly _tag: 'Valid'; readonly input: ProdutoInputBody }
  | { readonly _tag: 'Failed'; readonly response: NextResponse };

/** Lê o corpo da requisição e valida os dados obrigatórios do Bling antes de qualquer chamada externa. */
async function parseAndValidateProdutoInput(request: Request, logEntries: string[], timestamp: string): Promise<ProdutoInputResult> {
  const body = await request.json();
  const input = body as ProdutoInputBody;
  const { nome, bling_id, codigo, preco, estoque, tipo, situacao, formato, unidade } = input;

  if (!nome) {
    return { _tag: 'Failed', response: NextResponse.json({ success: false, error: 'O nome do produto é obrigatório' }, { status: 400 }) };
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
    return {
      _tag: 'Failed',
      response: NextResponse.json(
        {
          success: false,
          error: `Dados inválidos para o Bling ERP: ${validation.errors[0]}`,
          details: validation.errors.join('\n'),
          logs: logEntries,
        },
        { status: 400 }
      ),
    };
  }

  return { _tag: 'Valid', input };
}

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
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;
    const blingClient = bling.forUser(session.tenant);

    const inputResult = await parseAndValidateProdutoInput(request, logEntries, timestamp);
    if (inputResult._tag === 'Failed') return inputResult.response;
    const { id, bling_id, nome, codigo, preco, estoque, tipo, situacao, formato, unidade, categoria_id } = inputResult.input;

    const nomeSanitizado = sanitizeProductName(nome!);

    // 1. Tentar atualizar ou criar no Bling ERP v3 em tempo real
    const syncResult = await syncProdutoToBling(
      blingClient,
      bling_id,
      codigo,
      {
        nomeSanitizado,
        codigo,
        preco: preco !== undefined ? Number(preco) : undefined,
        estoque: estoque !== undefined ? Number(estoque) : undefined,
        tipo,
        situacao,
        formato,
        unidade,
      },
      logEntries,
    );
    const { realBlingId, blingResult, blingError } = syncResult;

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

    return await persistProdutoLocalAndRespond(scope, updatedProductPayload, blingResult, logEntries);
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logEntries.push(`[${new Date().toISOString()}] 💥 ERRO CRÍTICO NA API DE PRODUTOS: ${errMessage}`);
    return NextResponse.json(
      {
        success: false,
        error: 'Erro crítico interno ao processar a atualização do produto.',
        details: errMessage,
        logs: logEntries,
      },
      { status: 500 }
    );
  }
}
