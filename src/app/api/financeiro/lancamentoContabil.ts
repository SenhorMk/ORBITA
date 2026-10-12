import { NextResponse } from 'next/server';

import type {
  DespesaRequest,
  EstadoDaOperacaoDeDespesa,
  OperacaoDeDespesa,
} from '@/lib/config/despesaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { logger } from '@/lib/observability/logger';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

import type {
  DespesaDependencies,
  DespesaResponseBody,
  DespesaStorePort,
  GravacaoDeTentativa,
  ReivindicacaoDeTentativa,
  TituloPersistido,
} from './despesaHandler';
import { mensagemPublicaDaFalhaDoBling } from './mensagemPublicaDoBling';
import { quitar } from './quitacaoDaConta';
import { classificarEnvio, digestDaDespesa, referenciaNoBling } from './tentativaDeContaPagar';

/**
 * Lançamento contábil de despesa (`modo: 'contabil'`): a intenção de criar a
 * conta a pagar é reivindicada ANTES de qualquer chamada ao Bling, e só o dono
 * da tentativa envia o POST. Uma resposta perdida vira `indeterminada` e
 * bloqueia o reenvio — nunca é tratada como recusa.
 */

/**
 * Resposta de falha da rota de despesa, com a operação quando ela existe.
 *
 * @param error - Mensagem pública.
 * @param status - Status HTTP.
 * @param operacao - Referência e estado da operação contábil, se houver.
 * @returns A resposta JSON.
 */
export function fail(error: string, status: number, operacao?: OperacaoDeDespesa): NextResponse {
  return NextResponse.json(
    { success: false, error, ...(operacao ? { operacao } : {}) } satisfies DespesaResponseBody,
    { status },
  );
}

/**
 * Resultado não confirmado. `202`, e não erro: a conta pode existir no Bling,
 * e a resposta não pode parecer uma recusa que convida a lançar de novo.
 */
function naoConfirmado(ref: string, estado: 'em_voo' | 'indeterminada', mensagem: string): NextResponse {
  return fail(
    `${mensagem} Não lance de novo: a operação ${ref} fica pendente até ser conferida no Bling.`,
    202,
    { ref, estado },
  );
}

const MENSAGEM_INDETERMINADA = 'O Bling não confirmou o resultado deste lançamento — a conta a pagar pode ter sido criada lá.';
const MENSAGEM_EM_VOO = 'O resultado deste lançamento ainda não foi registrado.';

function registrarDesfecho(
  scope: VerifiedOrganizationScope,
  ref: string,
  estado: EstadoDaOperacaoDeDespesa,
  detalhes: { readonly motivo?: string; readonly gravacao?: GravacaoDeTentativa } = {},
): void {
  const nivel = estado === 'confirmada' && detalhes.gravacao !== 'NaoGravado' ? 'info' : 'warn';
  logger[nivel]('financeiro.despesa.tentativa', {
    subsystem: 'app',
    organizacaoId: scope.organizationId,
    actorId: scope.actorId,
    operacao: ref,
    estado,
    ...detalhes,
  });
}

type TituloParaSalvar = Parameters<DespesaStorePort['salvarTitulo']>[1];

function tituloDaDespesa(
  body: DespesaRequest,
  blingId: string,
  contatoId: number,
  situacao: 'aberto' | 'pago',
): TituloParaSalvar {
  return {
    blingId,
    valor: body.valor,
    dataVencimento: body.dataVencimento,
    titulo: body.titulo,
    descricao: body.descricao,
    categoriaId: body.categoriaId,
    // Quem recebeu a despesa fica no histórico: o id é a referência, o
    // nome é o retrato do momento.
    fornecedorBlingId: contatoId,
    fornecedorNome: body.contatoNome,
    situacao,
  };
}

/**
 * Grava o título de uma conta já confirmada no Bling e o liga à tentativa.
 * A tentativa confirmada já é a prova durável da criação: se esta gravação
 * falhar, uma repetição da MESMA operação refaz só esta parte.
 */
async function gravarTituloConfirmado(
  scope: VerifiedOrganizationScope,
  ref: string,
  tentativaId: string,
  titulo: TituloParaSalvar,
  avisos: readonly string[],
  deps: DespesaDependencies,
): Promise<NextResponse> {
  let data: TituloPersistido;
  try {
    data = await deps.store.salvarTitulo(scope, titulo);
  } catch (error: unknown) {
    // A causa vai para o log, não para a resposta: um erro do Postgres traz
    // `details` e `hint` com valor de linha (CWE-209).
    registrarFalhaInterna('financeiro.despesa.titulo.salvar', error);
    return fail(
      `Despesa lançada no Bling (id ${titulo.blingId}), mas falhou ao gravar no ORBITA. `
        + 'Envie de novo o mesmo lançamento para concluir a gravação — nada será enviado de novo ao Bling.',
      500,
      { ref, estado: 'confirmada' },
    );
  }

  if (await deps.store.vincularTitulo(scope, tentativaId, data.id) === 'NaoGravado') {
    registrarDesfecho(scope, ref, 'confirmada', { motivo: 'titulo_nao_vinculado', gravacao: 'NaoGravado' });
  }

  return NextResponse.json(
    {
      success: true,
      data,
      avisos: data.aviso ? [...avisos, data.aviso] : avisos,
      operacao: { ref, estado: 'confirmada' },
    } satisfies DespesaResponseBody,
    { status: 200 },
  );
}

/** A mesma operação, de novo: responde pelo estado gravado, sem chamar o Bling. */
async function responderRepeticao(
  scope: VerifiedOrganizationScope,
  ref: string,
  repetida: Extract<ReivindicacaoDeTentativa, { _tag: 'TentativaRepetida' }>,
  body: DespesaRequest,
  deps: DespesaDependencies,
): Promise<NextResponse> {
  if (repetida.estado === 'em_voo') return naoConfirmado(ref, 'em_voo', MENSAGEM_EM_VOO);
  if (repetida.estado === 'indeterminada') return naoConfirmado(ref, 'indeterminada', MENSAGEM_INDETERMINADA);
  if (repetida.estado === 'recusada') {
    return fail(
      `O Bling já recusou este lançamento (operação ${ref}). Corrija os dados e envie como um novo lançamento.`,
      400,
      { ref, estado: 'recusada' },
    );
  }

  if (repetida.tituloId !== null) {
    return NextResponse.json(
      {
        success: true,
        avisos: [`Este lançamento já estava registrado (operação ${ref}); nada foi enviado de novo ao Bling.`],
        operacao: { ref, estado: 'confirmada' },
      } satisfies DespesaResponseBody,
      { status: 200 },
    );
  }

  // Confirmada no Bling e sem título local: a requisição anterior morreu entre
  // as duas gravações. Grava o título como `aberto` — a criação é o que está
  // provado; a quitação, se houve, não é repetida, e a sincronização com o
  // Bling corrige a situação depois.
  const contatoId = repetida.contatoBlingId ?? body.contatoBlingId;
  if (repetida.blingContaId === null || contatoId === undefined) {
    return naoConfirmado(ref, 'em_voo', MENSAGEM_EM_VOO);
  }
  const avisos = body.pago
    ? [`A despesa ${repetida.blingContaId} foi lançada no Bling, mas a quitação não foi confirmada. Confira no Bling antes de quitar de novo.`]
    : [];
  return gravarTituloConfirmado(
    scope,
    ref,
    repetida.tentativaId,
    tituloDaDespesa(body, repetida.blingContaId, contatoId, 'aberto'),
    avisos,
    deps,
  );
}

/**
 * Lança a despesa no Bling sob a tentativa reivindicada.
 *
 * @param scope - Organização e ator verificados no servidor.
 * @param body - O pedido de despesa já validado.
 * @param ref - A chave da operação, enviada pelo cliente.
 * @param categoriaBlingId - A categoria local traduzida para o Bling, se houver.
 * @param deps - Portas da rota.
 * @returns A resposta HTTP, com a operação.
 */
export async function lancarNoBling(
  scope: VerifiedOrganizationScope,
  body: DespesaRequest,
  ref: string,
  categoriaBlingId: number | null,
  deps: DespesaDependencies,
): Promise<NextResponse> {
  const hoje = deps.hoje();

  const reivindicacao = await deps.store.reivindicarTentativa(scope, {
    chave: ref,
    digest: digestDaDespesa(body),
    valor: body.valor,
    dataVencimento: body.dataVencimento,
    dataEmissao: hoje,
    contatoBlingId: body.contatoBlingId ?? null,
    numeroDocumento: referenciaNoBling(ref),
    quitacaoSolicitada: body.pago,
  });

  switch (reivindicacao._tag) {
    case 'TentativaIndisponivel':
      return fail('Não foi possível registrar a intenção do lançamento. Nada foi enviado ao Bling. Tente de novo em instantes.', 503);
    case 'ConflitoDeConteudo':
      return fail(`A operação ${ref} já foi usada para um lançamento diferente. Abra o formulário de novo e envie.`, 409);
    case 'PendenciaIdentica':
      return naoConfirmado(
        reivindicacao.chavePendente,
        'em_voo',
        'Já existe um lançamento idêntico cujo resultado ainda não foi confirmado.',
      );
    case 'TentativaRepetida':
      return responderRepeticao(scope, ref, reivindicacao, body, deps);
    case 'TentativaPropria':
      break;
  }

  const tentativa = { tentativaId: reivindicacao.tentativaId, epoca: reivindicacao.epoca };

  let contatoId = body.contatoBlingId ?? null;
  if (contatoId === null) {
    const padrao = await deps.bling.resolverContatoPadrao();
    if (padrao._tag === 'BlingFailed') {
      const gravacao = await deps.store.concluirTentativa(scope, tentativa, {
        estado: 'nao_enviada', motivo: 'contato_nao_resolvido', contatoBlingId: null,
      });
      registrarDesfecho(scope, ref, 'nao_enviada', { motivo: 'contato_nao_resolvido', gravacao });
      if (gravacao === 'NaoGravado') return naoConfirmado(ref, 'em_voo', MENSAGEM_EM_VOO);
      return fail(
        `Não foi possível resolver o fornecedor padrão. ${mensagemPublicaDaFalhaDoBling(padrao.failure, 'resolver o fornecedor')} Nada foi enviado ao Bling.`,
        400,
        { ref, estado: 'nao_enviada' },
      );
    }
    contatoId = padrao.value;
  }

  const envio = await deps.bling.criarContaPagar({
    contatoId,
    vencimento: body.dataVencimento,
    valor: body.valor,
    historico: body.descricao,
    dataEmissao: hoje,
    competencia: hoje,
    ...(categoriaBlingId ? { categoriaId: categoriaBlingId } : {}),
    // Só a referência gravada na tentativa vai ao Bling: uma tentativa antiga
    // reaberta, sem referência, continua sem.
    ...(reivindicacao.numeroDocumento ? { numeroDocumento: reivindicacao.numeroDocumento } : {}),
  });

  const desfecho = classificarEnvio(envio);
  switch (desfecho._tag) {
    case 'NaoEnviada': {
      const gravacao = await deps.store.concluirTentativa(scope, tentativa, {
        estado: 'nao_enviada', motivo: desfecho.motivo, contatoBlingId: contatoId,
      });
      registrarDesfecho(scope, ref, 'nao_enviada', { motivo: desfecho.motivo, gravacao });
      if (gravacao === 'NaoGravado') return naoConfirmado(ref, 'em_voo', MENSAGEM_EM_VOO);
      return fail(
        'Nada foi enviado ao Bling: a conexão com o Bling não está disponível. Confira em "Conectar APIs" e tente de novo.',
        503,
        { ref, estado: 'nao_enviada' },
      );
    }
    case 'Recusada': {
      const gravacao = await deps.store.concluirTentativa(scope, tentativa, {
        estado: 'recusada', motivo: 'recusa_definitiva', contatoBlingId: contatoId,
      });
      registrarDesfecho(scope, ref, 'recusada', { motivo: 'recusa_definitiva', gravacao });
      if (gravacao === 'NaoGravado') return naoConfirmado(ref, 'em_voo', MENSAGEM_EM_VOO);
      return fail(
        mensagemPublicaDaFalhaDoBling(desfecho.failure, 'criar a conta a pagar'),
        400,
        { ref, estado: 'recusada' },
      );
    }
    case 'Indeterminada': {
      const gravacao = await deps.store.concluirTentativa(scope, tentativa, {
        estado: 'indeterminada', motivo: desfecho.motivo, contatoBlingId: contatoId,
      });
      registrarDesfecho(scope, ref, 'indeterminada', { motivo: desfecho.motivo, gravacao });
      // Gravada ou não, a resposta é a mesma: o resultado não é conhecido. Sem
      // a gravação a tentativa fica `em_voo`, que também bloqueia o reenvio.
      return naoConfirmado(ref, gravacao === 'Gravado' ? 'indeterminada' : 'em_voo', MENSAGEM_INDETERMINADA);
    }
    case 'Confirmada':
      break;
  }

  const blingContaId = desfecho.valor.id;
  const gravacao = await deps.store.concluirTentativa(scope, tentativa, {
    estado: 'confirmada', blingContaId, contatoBlingId: contatoId,
  });
  registrarDesfecho(scope, ref, 'confirmada', { gravacao });
  if (gravacao === 'NaoGravado') {
    // A conta existe no Bling, mas a prova não ficou gravada aqui. A tentativa
    // continua `em_voo` — o que bloqueia o reenvio — e nada mais é feito.
    return naoConfirmado(
      ref,
      'em_voo',
      `A conta a pagar foi criada no Bling (id ${blingContaId}), mas o ORBITA não conseguiu registrar o resultado.`,
    );
  }

  const quitacao = body.pago
    ? await quitar(scope, { ref, tentativaId: tentativa.tentativaId, blingContaId }, body.descricao, categoriaBlingId, deps)
    : { quitada: false, avisos: [] };
  return gravarTituloConfirmado(
    scope,
    ref,
    tentativa.tentativaId,
    // A situação gravada é a real do ERP. Se a quitação não aconteceu, o
    // título fica aberto aqui também — os dois lados contam a mesma coisa.
    tituloDaDespesa(body, blingContaId, contatoId, quitacao.quitada ? 'pago' : 'aberto'),
    quitacao.avisos,
    deps,
  );
}
