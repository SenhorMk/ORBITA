import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import type { BlingPort } from '@/services/blingPort';
import { pedidoRepository } from '@/repositories/pedidoRepository';
import { supabaseServer } from '@/lib/supabaseServer';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { logger } from '@/lib/observability/logger';
import { getCorrelationId } from '@/lib/observability/correlation';

export const dynamic = 'force-dynamic';

interface NfeApiResponse {
  id?: number | string;
  bling_id?: number | string;
  numero?: string;
  numeroNFE?: string;
  chave?: string;
  chaveAcesso?: string;
  status?: string;
  situacao?: string;
  data?: NfeApiResponse;
}


/** Emite a NF-e no Bling e persiste o resultado local. Assume que o advisory lock do pedido já foi adquirido pelo chamador. */
async function emitNfeWithLock(
  scope: VerifiedOrganizationScope,
  pedidoId: string,
  blingPedidoId: string,
  blingClient: BlingPort,
  correlationId: string,
): Promise<NextResponse> {
  // 2. Verificar no banco se a NF-e já existe na tabela canônica
  const { data: nfeExistente, error: nfeError } = await supabaseServer
    .from('documentos_fiscais')
    .select('*')
    .eq('pedido_id', pedidoId)
    .eq('organizacao_id', scope.organizationId)
    .maybeSingle();

  if (nfeError) {
    // `nfeError` é um `PostgrestError`, e `message` carrega texto do Postgres:
    // nome de constraint e, num conflito de unicidade, o próprio valor da
    // linha. Por isso fica só no log (CWE-209).
    registrarFalhaInterna('nfe.consultar_documento', nfeError, { organizacaoId: scope.organizationId });
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }

  if (nfeExistente) {
    return NextResponse.json(
      { success: false, error: `Este pedido já possui a NF-e número ${nfeExistente.numero} emitida.` },
      { status: 400 }
    );
  }

  // Sem a RPC auditada (banco sem a migration 83) a nota sairia no Bling e não
  // poderia ser registrada aqui: recusa antes de emitir.
  if (!(await pedidoRepository.registroDeNfeDisponivel())) {
    return NextResponse.json(
      { success: false, error: 'Emissão de NF-e indisponível no momento. Nada foi enviado ao Bling.' },
      { status: 503 }
    );
  }

  // 1. Emitir nota fiscal através do Bling Client
  const nfeResult = (await blingClient.createNfe(blingPedidoId)) as NfeApiResponse;

  // Bling v3 envelopa a resposta em { data: {...} }; extrair com fallbacks defensivos.
  const nfeData = (nfeResult?.data ?? nfeResult ?? {}) as NfeApiResponse;
  const nfeBlingId = String(nfeData.id ?? nfeData.bling_id ?? '');
  const nfeNumero = nfeData.numero ?? nfeData.numeroNFE ?? '';
  const nfeChave = nfeData.chave ?? nfeData.chaveAcesso ?? null;
  const nfeStatus = nfeData.status ?? nfeData.situacao ?? 'Emitida';

  if (!nfeBlingId || !nfeNumero) {
    // O corpo da resposta é uma NF-e: destinatário, itens, valores. Nada disso
    // é diagnóstico, e nada disso sai — nem ao cliente, nem ao log.
    //
    // O que ajuda a diagnosticar é **qual campo faltou**, e é a única coisa que
    // fica: os nomes das chaves que vieram, sem um único valor.
    // Indicadores **fechados**, dos campos que este código espera — e nada
    // derivado da resposta.
    //
    // Registrar `Object.keys(...)` da resposta parece seguro por não ter
    // valores, mas não é: nome de propriedade também é
    // dado que vem de fora, e um provedor que devolva um objeto com chaves
    // dinâmicas colocaria conteúdo arbitrário no log por essa porta. O que sai
    // é uma lista de booleanos escrita aqui.
    logger.error('nfe.resposta_do_bling_sem_identificador', {
      subsystem: 'app',
      provider: 'bling',
      organizacaoId: scope.organizationId,
      envelopadoEmData: nfeData !== nfeResult,
      temIdentificador: nfeBlingId.length > 0,
      temNumero: String(nfeNumero).length > 0,
      temChave: nfeChave !== null,
      temStatus: nfeStatus !== 'Emitida',
    });
    // A resposta diz o que aconteceu e onde procurar. O pedido no Bling é o que
    // permite achar a nota — e ele veio do próprio chamador.
    return NextResponse.json({
      success: false,
      error: 'NF-e emitida no Bling, mas a resposta não trouxe número ou identificador. Reconciliação manual necessária.',
      compensation_required: true,
      bling_pedido_id: blingPedidoId,
    }, { status: 502 });
  }

  // M8: Fluxo fiscal com compensação e tratamento de erro estruturado.
  try {
    // 2. Persistir nota fiscal gerada no cache local associando ao ID do pedido
    const nfeCache = await pedidoRepository.upsertNfe(scope, {
      bling_id: nfeBlingId,
      numero: String(nfeNumero),
      chave: nfeChave || '',
      status: nfeStatus,
      pedido_id: pedidoId,
    }, { correlationId });

    // 3. Atualizar status do pedido local para Atendido/Faturado
    const pedidoLocal = await pedidoRepository.getById(scope, pedidoId);
    if (pedidoLocal) {
      await pedidoRepository.upsert(scope, {
        ...pedidoLocal,
        status: 'Atendido'
      });
    }

    return NextResponse.json({ success: true, data: nfeCache });
  } catch (dbError: unknown) {
    // A nota existe no Bling e não existe aqui: é o único caminho que exige
    // ação humana, e por isso ele continua dizendo **o quê e onde** — número,
    // chave e id da nota são o que permite reconciliar.
    //
    // A mensagem do banco não ajuda a reconciliar nada e é diagnóstico interno
    // (CWE-209): fica só no log.
    registrarFalhaInterna('nfe.persistir', dbError, { organizacaoId: scope.organizationId });
    return NextResponse.json({
      success: false,
      error: 'Nota fiscal foi gerada com sucesso no ERP Bling, porém ocorreu um erro ao salvar o registro no banco local. Pendente reconciliação manual.',
      compensation_required: true,
      bling_nfe_id: nfeBlingId,
      numero: String(nfeNumero),
      chave: nfeChave,
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // A autorização vem do escopo verificado: identidade + vínculo persistido
    // nesta organização. A permissão é decidida pela capacidade do papel, nunca
    // por metadados do provedor de identidade.
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;
    if (!escopoTemCapacidade(scope, 'organization:manage')) {
      return NextResponse.json({ success: false, error: 'Acesso negado: somente quem administra a organização pode faturar pedidos.' }, { status: 403 });
    }

    const { pedidoId, blingPedidoId } = await request.json();

    if (!pedidoId || !blingPedidoId) {
      return NextResponse.json(
        { success: false, error: 'pedidoId e blingPedidoId são obrigatórios' },
        { status: 400 }
      );
    }

    // C8: Prevenir double-faturamento no Bling checando se o pedido já tem NF-e local
    if (!(process.env.MOCK_MODE === 'true' && process.env.NODE_ENV === 'development')) {
      // 1. Tentar obter lock exclusivo no pedido (Advisory Lock), verificado
      // pela organizacao ativa (nunca pelo user_id primitivo).
      const { data: lockAcquired, error: lockError } = await supabaseServer.rpc('tentar_lock_nfe_organizacao', {
        p_organizacao_id: scope.organizationId,
        p_pedido_id: pedidoId,
      });

      if (lockError || !lockAcquired) {
        return NextResponse.json({ success: false, error: 'Outra emissão de nota já está em andamento para este pedido.' }, { status: 429 });
      }

      try {
        const blingClient = bling.forVerifiedOrganization(scope);
        return await emitNfeWithLock(scope, pedidoId, blingPedidoId, blingClient, getCorrelationId(request));
      } catch (error: unknown) {
        // A mensagem do erro fica só no log (CWE-209); o cliente recebe frase fixa.
        registrarFalhaInterna('nfe.emitir', error, { organizacaoId: scope.organizationId });
        return NextResponse.json(
          { success: false, error: 'Falha ao emitir nota fiscal no ERP' },
          { status: 500 }
        );
      } finally {
        await supabaseServer.rpc('liberar_lock_nfe_organizacao', {
          p_organizacao_id: scope.organizationId,
          p_pedido_id: pedidoId,
        });
      }
    } else {
        // Implementar lógica de mock se necessário
        return NextResponse.json({ success: true, data: { status: 'mock' } });
    }
  } catch (error: unknown) {
    registrarFalhaInterna('nfe.processar', error);
    return NextResponse.json(
      { success: false, error: MENSAGEM_PUBLICA_DE_FALHA },
      { status: 500 }
    );
  }
}
