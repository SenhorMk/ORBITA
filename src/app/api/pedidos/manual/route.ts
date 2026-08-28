import { NextResponse } from 'next/server';
import { verifySessionAndRole } from '@/lib/auth';
import { bling } from '@/services/bling';
import { supabaseServer } from '@/lib/supabaseServer';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

type BlingClient = ReturnType<typeof bling.forUser>;

/** Constrói o resultado padrão `{ _tag: 'Failed', response }` usado por todas as validações desta rota. */
function failed(error: string, status: number, logEntries: string[]): { readonly _tag: 'Failed'; readonly response: NextResponse } {
  return {
    _tag: 'Failed',
    response: NextResponse.json({ success: false, error, logs: logEntries }, { status }),
  };
}

interface ItemValidado {
  id?: string;
  codigo?: string | null;
  bling_id?: string | null;
  nome?: string;
  quantidade_compra: number;
  valor_unitario: number;
}

/** Resultado da resolução do cliente local e, se aplicável, do seu ID no Bling ERP. */
type ClienteResolutionResult =
  | { readonly _tag: 'Resolved'; readonly localClienteId: string; readonly clienteNome: string; readonly numericBlingId: number | null }
  | { readonly _tag: 'Failed'; readonly response: NextResponse };

/**
 * Localiza o cliente local pelo ID informado (UUID ou bling_id) e, quando a
 * venda será sincronizada com o Bling e o cliente ainda não possui um ID
 * numérico oficial, cadastra o contato no Bling ERP para obtê-lo.
 */
async function resolveClienteAndBlingId(
  scope: VerifiedOrganizationScope,
  rawContatoId: string | number,
  syncBling: boolean,
  blingClient: BlingClient,
  logEntries: string[],
): Promise<ClienteResolutionResult> {
  const contatoId = String(rawContatoId);
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contatoId);
  let query = supabaseServer.from('clientes').select('*').eq('organizacao_id', scope.organizationId);
  query = isUUID ? query.or(`id.eq.${contatoId},bling_id.eq.${contatoId}`) : query.eq('bling_id', contatoId);

  const { data: clienteData, error: dbErr } = await query.maybeSingle();

  if (dbErr) {
    logEntries.push(`[${new Date().toISOString()}] 💥 Erro ao consultar cliente local: ${dbErr.message}`);
    return failed(`Erro ao consultar cliente no banco de dados local: ${dbErr.message}`, 500, logEntries);
  }

  if (!clienteData) {
    return failed(`Cliente não encontrado no banco de dados local (ID: ${contatoId}).`, 400, logEntries);
  }

  const localClienteId: string = clienteData.id;
  logEntries.push(`[${new Date().toISOString()}] 👤 Cliente local: "${clienteData.nome}" (ID: ${localClienteId})`);

  let numericBlingId: number | null = null;
  if (clienteData.bling_id && /^\d+$/.test(String(clienteData.bling_id).trim())) {
    numericBlingId = Number(clienteData.bling_id);
    logEntries.push(`[${new Date().toISOString()}] ✅ ID do contato no Bling verificado: ${numericBlingId}`);
    return { _tag: 'Resolved', localClienteId, clienteNome: clienteData.nome, numericBlingId };
  }

  if (!syncBling) {
    return { _tag: 'Resolved', localClienteId, clienteNome: clienteData.nome, numericBlingId: null };
  }

  // Registrar obrigatoriamente o contato no Bling ERP v3 para obter o ID oficial
  logEntries.push(`[${new Date().toISOString()}] ➕ Cliente não possui cadastro no Bling. Enviando cadastro de contato para o Bling...`);
  try {
    const resCriar = (await blingClient.createContato({
      nome: clienteData.nome,
      email: clienteData.email,
      telefone: clienteData.telefone,
      cnpj: clienteData.cpf_cnpj,
    })) as { data?: { id?: number | string } };

    if (!resCriar?.data?.id) {
      throw new Error('Bling confirmou a criação do contato mas não retornou um ID numérico válido.');
    }

    numericBlingId = Number(resCriar.data.id);
    logEntries.push(`[${new Date().toISOString()}] ✅ Contato cadastrado no Bling ERP com sucesso! Bling ID: ${numericBlingId}`);

    // Atualizar o cliente no Supabase com o ID oficial do Bling
    await supabaseServer
      .from('clientes')
      .update({ bling_id: String(numericBlingId) })
      .eq('id', localClienteId);

    return { _tag: 'Resolved', localClienteId, clienteNome: clienteData.nome, numericBlingId };
  } catch (cErr: unknown) {
    const cErrMsg = cErr instanceof Error ? cErr.message : String(cErr);
    logEntries.push(`[${new Date().toISOString()}] ❌ Erro ao cadastrar contato no Bling: ${cErrMsg}`);
    return failed(`Não foi possível cadastrar o contato no Bling para a venda: ${cErrMsg}`, 400, logEntries);
  }
}

/** Resultado da validação de itens e disponibilidade de estoque para a venda manual. */
type ItensValidationResult =
  | { readonly _tag: 'Valid'; readonly itensValidados: ItemValidado[] }
  | { readonly _tag: 'Failed'; readonly response: NextResponse };

/** Valida cada item da venda contra o cadastro local de produtos e o estoque disponível. */
async function validateItensAndStock(
  scope: VerifiedOrganizationScope,
  itens: Array<{ produto_id?: string; codigo?: string; quantidade: number; valor_unitario: number }>,
  logEntries: string[],
): Promise<ItensValidationResult> {
  const itensValidados: ItemValidado[] = [];

  for (const i of itens) {
    const { data: pData } = await supabaseServer
      .from('produtos')
      .select('id, codigo, bling_id, nome, estoque, estoque_reservado')
      .eq('organizacao_id', scope.organizationId)
      .eq(i.produto_id ? 'id' : 'codigo', i.produto_id || i.codigo)
      .maybeSingle();

    if (!pData) {
      return failed(`Produto local não encontrado: ${i.codigo || i.produto_id}`, 400, logEntries);
    }

    const estoqueAtual = pData.estoque || 0;
    const reservado = pData.estoque_reservado || 0;
    const disponivel = estoqueAtual - reservado;

    if (disponivel < i.quantidade) {
      return failed(`Estoque insuficiente para ${pData.nome}. Disponível: ${disponivel}, Tentou comprar: ${i.quantidade}`, 400, logEntries);
    }

    itensValidados.push({
      ...pData,
      quantidade_compra: i.quantidade,
      valor_unitario: i.valor_unitario,
    });
  }

  return { _tag: 'Valid', itensValidados };
}

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

/** Resultado da sincronização da venda manual com o Bling ERP. */
type VendaBlingSyncResult =
  | { readonly _tag: 'Synced'; readonly realBlingId: string; readonly realNumero: string }
  | { readonly _tag: 'Skipped' }
  | { readonly _tag: 'Failed'; readonly response: NextResponse };

/** Cria o pedido de venda no Bling ERP e dá baixa de estoque remota para cada item. */
async function syncVendaToBling(
  blingClient: BlingClient,
  numericBlingId: number | null,
  itensValidados: ItemValidado[],
  dataStr: string,
  observacoes: string | undefined,
  desconto: number | string | undefined,
  frete: number | string | undefined,
  logEntries: string[],
): Promise<VendaBlingSyncResult> {
  if (!numericBlingId) {
    return failed('Id do contato da venda é obrigatório para enviar ao Bling ERP.', 400, logEntries);
  }

  logEntries.push(`[${new Date().toISOString()}] Enviando pedido de venda ao Bling ERP (Contato ID: ${numericBlingId})...`);

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
    if (!blingRes?.data?.id) {
      throw new Error('Bling retornou confirmação sem informar o ID da venda.');
    }

    const realBlingId = String(blingRes.data.id);
    const realNumero = blingRes.data.numero ? String(blingRes.data.numero) : realBlingId;
    logEntries.push(`[${new Date().toISOString()}] ✅ Pedido de venda criado no Bling com sucesso! ID: ${realBlingId}`);

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

    return { _tag: 'Synced', realBlingId, realNumero };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logEntries.push(`[${new Date().toISOString()}] ❌ Erro na API Bling ao criar pedido: ${errMessage}`);
    return failed(`Erro na API Bling ao criar pedido: ${errMessage}`, 400, logEntries);
  }
}

interface SaveVendaLocalInput {
  readonly userId: string;
  readonly organizacaoId: string;
  readonly localClienteId: string;
  readonly realBlingId: string;
  readonly realNumero: string;
  readonly total: number;
  readonly desconto: number | string | undefined;
  readonly frete: number | string | undefined;
  readonly formaPagamento: string | undefined;
  readonly observacoes: string | undefined;
  readonly dataStr: string;
  readonly itensValidados: ItemValidado[];
}

/** Persiste a venda manual no banco local: pedido, itens com baixa de estoque atômica, e título financeiro. */
async function saveVendaLocal(input: SaveVendaLocalInput, logEntries: string[]): Promise<NextResponse> {
  logEntries.push(`[${new Date().toISOString()}] 💾 Registrando venda no banco de dados local...`);

  // a) Criar Pedido
  const { data: novoPedido, error: pedErr } = await supabaseServer.from('pedidos').insert({
    user_id: input.userId,
    organizacao_id: input.organizacaoId,
    cliente_id: input.localClienteId,
    bling_id: input.realBlingId,
    numero: input.realNumero,
    data: new Date().toISOString(),
    total: input.total,
    desconto: Number(input.desconto) || 0,
    frete: Number(input.frete) || 0,
    status: 'Entregue',
    origem: 'Loja Física / Manual',
    forma_pagamento: input.formaPagamento,
    observacao: input.observacoes
  }).select('id').single();

  if (pedErr) throw new Error(`Erro ao criar pedido local: ${pedErr.message}`);

  // b) Registrar Itens e dar baixa no estoque local de forma atômica,
  // verificada pela organização (nunca aceita organizacao/actor forjados:
  // a RPC revalida que o produto pertence a scope.organizationId e nunca
  // permite estoque negativo).
  for (const item of input.itensValidados) {
    await supabaseServer.from('itens_pedido').insert({
      user_id: input.userId,
      organizacao_id: input.organizacaoId,
      pedido_id: novoPedido.id,
      produto_id: item.id,
      quantidade: item.quantidade_compra,
      valor_unitario: item.valor_unitario
    });

    const { error: stockError } = await supabaseServer.rpc('baixar_estoque_organizacao', {
      p_organizacao_id: input.organizacaoId,
      p_produto_id: item.id,
      p_qty: item.quantidade_compra,
    });

    if (stockError) {
      throw new Error(`Erro ao atualizar estoque local: ${stockError.message}`);
    }
  }

  // c) Registrar Financeiro
  await supabaseServer.from('titulos_financeiros').insert({
    user_id: input.userId,
    tipo: 'receber',
    situacao: 'pago',
    valor: input.total,
    data_vencimento: input.dataStr,
    data_pagamento: input.dataStr,
    descricao: `Venda Manual #${input.realNumero}`
  });

  logEntries.push(`[${new Date().toISOString()}] ✅ Venda e estoque registrados com sucesso! (ID Local: ${novoPedido.id})`);

  return NextResponse.json({
    success: true,
    pedidoId: novoPedido.id,
    logs: logEntries
  });
}

export async function POST(request: Request) {
  const logEntries: string[] = [];
  try {
    const session = await verifySessionAndRole(request);
    const userId = session?.tenant.id;
    if (!userId || !session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const blingClient = bling.forUser(session.tenant);
    const body = await request.json();
    const { syncBling, contatoId, itens, total, formaPagamento, desconto, frete, observacoes } = body;

    logEntries.push(`[${new Date().toISOString()}] Recebido requisição de Pedido Manual (Sync Bling: ${syncBling})`);

    // 1. Resolver Cliente local
    if (!contatoId) {
      return NextResponse.json({
        success: false,
        error: 'É necessário selecionar um cliente para realizar a venda.',
        logs: logEntries
      }, { status: 400 });
    }

    const clienteResolution = await resolveClienteAndBlingId(scope, contatoId, Boolean(syncBling), blingClient, logEntries);
    if (clienteResolution._tag === 'Failed') return clienteResolution.response;
    const { localClienteId, numericBlingId } = clienteResolution;

    // 2. Validar produtos e estoque
    const itensValidation = await validateItensAndStock(scope, itens, logEntries);
    if (itensValidation._tag === 'Failed') return itensValidation.response;
    const { itensValidados } = itensValidation;

    const today = new Date();
    const dataStr = today.toISOString().split('T')[0];
    let realBlingId = `MANUAL-${Math.random().toString(36).substring(2, 15)}`;
    let realNumero = realBlingId;

    // 3. Sincronizar Venda no Bling ERP
    if (syncBling) {
      const syncResult = await syncVendaToBling(blingClient, numericBlingId, itensValidados, dataStr, observacoes, desconto, frete, logEntries);
      if (syncResult._tag === 'Failed') return syncResult.response;
      if (syncResult._tag === 'Synced') {
        realBlingId = syncResult.realBlingId;
        realNumero = syncResult.realNumero;
      }
    }

    // 4. Salvar no Banco Local (Supabase)
    return await saveVendaLocal({
      userId,
      organizacaoId: scope.organizationId,
      localClienteId,
      realBlingId,
      realNumero,
      total,
      desconto,
      frete,
      formaPagamento,
      observacoes,
      dataStr,
      itensValidados,
    }, logEntries);

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
