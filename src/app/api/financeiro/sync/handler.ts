import { NextResponse } from 'next/server';
import { z } from 'zod';

import { descreverErro } from '@/lib/erroLegivel';
import { logger, sanitizeErrorForLog } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { TituloFinanceiro } from '@/types';

import type {
  CandidatoDeVinculo,
  EntidadeFinanceira,
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncResponseBody,
  FinanceiroSyncStorePort,
  RawContaFinanceira,
  SyncStats,
} from './ports';

export type {
  EntidadeFinanceira,
  FinanceiroSyncAuthPort,
  FinanceiroSyncBlingPort,
  FinanceiroSyncDependencies,
  FinanceiroSyncResponseBody,
  FinanceiroSyncStorePort,
  RawContaFinanceira,
  SyncStats,
} from './ports';

/**
 * Número vindo do provedor.
 *
 * `Number()` cru aceita coisa demais: `''` e `'   '` viram **zero**, `'0xFF'`
 * vira **255**. Numa conta a pagar isso não é um detalhe de parsing — é um
 * valor inventado sendo gravado como se o Bling o tivesse mandado.
 *
 * Aceita número de verdade, ou string decimal simples com sinal opcional.
 * Zero numérico legítimo continua passando; vazio, espaço e hexadecimal não.
 */
const numeroDoProvedor = z.union([
  z.number(),
  z.string().regex(/^\s*-?\d+(?:\.\d+)?\s*$/u).transform((texto) => Number(texto.trim())),
]);

/**
 * Contrato do item de conta, conferido **antes** da persistência.
 *
 * O tipo TypeScript e a comparação textual com o catálogo do OpenAPI dizem o
 * que o Bling *deveria* mandar; nenhum dos dois olha o que ele mandou. Sem esta
 * validação, um item sem `id` chegava ao repositório com `bling_id: null` — que
 * é a chave do `ON CONFLICT` — e `valor: null` virava `0` pelo `Number()`.
 *
 * `situacao` e `vencimento` são obrigatórios no OpenAPI oficial. `id` não é
 * declarado obrigatório lá, mas aqui é: sem ele não existe chave de
 * idempotência, e gravar sem chave é pior que não gravar.
 */
const contaFinanceiraSchema = z.object({
  id: numeroDoProvedor.pipe(z.number().int().positive()),
  situacao: numeroDoProvedor.pipe(z.number().finite()),
  valor: numeroDoProvedor.pipe(z.number().finite()),
  vencimento: z.string().min(1),
  pagamento: z.object({ data: z.string().optional() }).optional(),
  historico: z.string().optional(),
  // `origem` é opcional e frouxa de propósito: a conta a pagar não tem esse
  // campo, e uma conta a receber sem origem continua sendo uma conta válida.
  // O que ela não pode é virar vínculo sem `tipoOrigem` dizer que é venda.
  origem: z.object({
    id: numeroDoProvedor.pipe(z.number().int().positive()).optional(),
    tipoOrigem: z.string().optional(),
  }).optional(),
});

/** Item já provado contra o contrato, pronto para virar `TituloFinanceiro`. */
type ContaValidada = z.infer<typeof contaFinanceiraSchema>;

/**
 * Identificador do item **sem confiar na forma dele**.
 *
 * O ramo de item inválido lia `raw.id` para nomear a linha do log — e `raw`
 * pode ser `null`, que é justamente uma das formas rejeitadas: acessar `.id`
 * ali lançava `TypeError`, abortava o lote inteiro e nem tentava os itens
 * válidos seguintes. Não se lê campo de um valor cuja forma acabou de ser
 * recusada.
 */
function identificadorNaoConfiavel(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
}

const LIMITE_POR_PAGINA = 100;
const MAX_PAGINAS_PADRAO = 50;

function json(body: FinanceiroSyncResponseBody, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** 1 = Aberto, 2 = Pago, 3 = Cancelado (padrão Bling). */
function mapSituacao(idSituacao: number): 'aberto' | 'pago' | 'cancelado' {
  if (idSituacao === 1) return 'aberto';
  if (idSituacao === 2) return 'pago';
  if (idSituacao === 3) return 'cancelado';
  return 'aberto';
}

/**
 * Classifica a falha de um item como temporária (rede, timeout,
 * indisponibilidade — reprocessar adianta) ou permanente (dado inválido —
 * reprocessar não adianta).
 */
function ehFalhaTemporaria(err: unknown): boolean {
  return /timeout|network|ECONNRESET|ETIMEDOUT|fetch failed|503|502|504|429/i.test(descreverErro(err));
}

/**
 * Registra a falha no servidor sem carregar nada que não possa ser lido depois.
 *
 * Nunca inclui o item: uma conta carrega valor, vencimento e histórico — dado
 * do negócio do lojista. O que fica é onde falhou e qual entidade.
 */
function registrarFalha(
  erro: unknown,
  contexto: { readonly etapa: string; readonly entidade: EntidadeFinanceira; readonly organizacaoId?: string; readonly blingId?: string },
): void {
  logger.error('Falha na sincronização financeira', {
    subsystem: 'provider',
    operacao: `financeiro.sync.${contexto.etapa}`,
    entidade: contexto.entidade,
    organizacaoId: contexto.organizacaoId,
    blingId: contexto.blingId,
    erro: sanitizeErrorForLog(erro).name,
    // Sem o status, um 403 e um 500 do provedor viravam a mesma linha
    // `BlingLeituraError` — o log existia e nao distinguia causa nenhuma.
    status: statusTecnico(erro),
  });
}

/** Status HTTP do erro, quando ele carrega um numero de status crivel. */
function statusTecnico(erro: unknown): number | undefined {
  const bruto = (erro as { status?: unknown } | null | undefined)?.status;
  return typeof bruto === 'number' && Number.isInteger(bruto) && bruto >= 0 && bruto <= 599 ? bruto : undefined;
}

function toTitulo(
  conta: ContaValidada,
  tipo: 'pagar' | 'receber',
  pedidoId?: string,
): TituloFinanceiro {
  const rotulo = tipo === 'pagar' ? 'Conta a Pagar' : 'Conta a Receber';
  return {
    bling_id: conta.id,
    tipo,
    situacao: mapSituacao(conta.situacao),
    valor: conta.valor,
    data_vencimento: conta.vencimento,
    data_pagamento: conta.pagamento?.data || undefined,
    descricao: conta.historico || `${rotulo} #${conta.id}`,
    // Só o que o store confirmou. `undefined` não escreve nada: um título já
    // vinculado não perde o vínculo porque uma releitura não o reconfirmou.
    ...(pedidoId ? { pedido_id: pedidoId } : {}),
  };
}

/**
 * O pedido que a conta declara ter originado — e nada além disso.
 *
 * `tipoOrigem` é o que separa uma venda de uma nota fiscal dentro do mesmo
 * campo `origem.id`. Fora de `venda`, o id não é de pedido, e casá-lo com um
 * pedido seria ligar receita ao registro errado. Valor, data, cliente e texto
 * da descrição não entram nesta decisão em nenhuma hipótese.
 */
function candidatoDeVinculo(conta: ContaValidada): CandidatoDeVinculo | null {
  const origem = conta.origem;
  if (!origem || origem.id === undefined) return null;
  if ((origem.tipoOrigem ?? '').trim().toLowerCase() !== 'venda') return null;
  return { contaBlingId: conta.id, pedidoBlingId: String(origem.id) };
}

/**
 * Sincroniza uma entidade financeira inteira, página a página.
 *
 * O que mudou em relação à versão anterior, e por quê:
 *
 * - **a leitura pode falhar, e a falha para o laço.** Antes o cliente devolvia
 *   `[]` em 401/403/500/timeout, o laço interpretava como fim dos dados e a
 *   etapa terminava "com sucesso" tendo processado zero;
 * - **o checkpoint só avança se todas as páginas foram lidas.** Marcar depois
 *   de uma leitura falha registra um progresso que não houve;
 * - **falha de item não é mais só um `console.warn`.** Continua não derrubando
 *   o lote — um dado inválido não pode impedir os outros — mas entra na
 *   contagem que a resposta carrega.
 */
async function sincronizarEntidade(
  scope: VerifiedOrganizationScope,
  entidade: EntidadeFinanceira,
  tipo: 'pagar' | 'receber',
  store: FinanceiroSyncStorePort,
  bling: FinanceiroSyncBlingPort,
  maxPaginas: number,
): Promise<SyncStats> {
  let processados = 0;
  let falhasTemporarias = 0;
  let falhasPermanentes = 0;
  let itensInvalidos = 0;
  /** Verdadeiro enquanto não vimos o fim dos dados (página vazia ou parcial). */
  let aindaHaPaginas = true;

  for (let pagina = 1; pagina <= maxPaginas && aindaHaPaginas; pagina++) {
    let itens: readonly RawContaFinanceira[];
    try {
      itens = await bling.lerPagina(entidade, pagina, LIMITE_POR_PAGINA);
    } catch (err: unknown) {
      registrarFalha(err, { etapa: 'ler-pagina', entidade, organizacaoId: scope.organizationId });
      // Sai sem marcar checkpoint: o que veio até aqui é parcial e assumido.
      return {
        processados, falhasTemporarias, falhasPermanentes, itensInvalidos,
        leituraFalhou: true, leituraIncompleta: false,
      };
    }

    if (itens.length === 0) {
      aindaHaPaginas = false;
      break;
    }

    const validados: ContaValidada[] = [];
    for (const raw of itens) {
      const validado = contaFinanceiraSchema.safeParse(raw);
      if (!validado.success) {
        // Nunca alcança o repositório: sem `id` válido não há chave de
        // idempotência, e `valor` ausente viraria `0` silenciosamente.
        itensInvalidos++;
        registrarFalha(new Error('item fora do contrato'), {
          etapa: 'validar-item',
          entidade,
          organizacaoId: scope.organizationId,
          blingId: identificadorNaoConfiavel(raw),
        });
        continue;
      }
      validados.push(validado.data);
    }

    // Uma consulta por página, e não uma por conta. Falhar aqui não pode
    // custar a página inteira: o vínculo é enriquecimento, e sem ele os
    // títulos continuam sendo gravados exatamente como eram antes.
    let vinculos: ReadonlyMap<number, string> = new Map();
    const candidatos = validados.map(candidatoDeVinculo).filter((c): c is CandidatoDeVinculo => c !== null);
    if (candidatos.length > 0) {
      try {
        vinculos = await store.vincularPedidos(scope, candidatos);
      } catch (err: unknown) {
        registrarFalha(err, { etapa: 'vincular-pedido', entidade, organizacaoId: scope.organizationId });
      }
    }

    for (const conta of validados) {
      try {
        // Idempotente: `onConflict (organizacao_id, bling_id)` no repositório
        // faz a reexecução atualizar o mesmo registro, nunca duplicar.
        await store.upsertTitulo(scope, toTitulo(conta, tipo, vinculos.get(conta.id)));
        processados++;
      } catch (err: unknown) {
        if (ehFalhaTemporaria(err)) falhasTemporarias++;
        else falhasPermanentes++;
        registrarFalha(err, {
          etapa: 'gravar-titulo',
          entidade,
          organizacaoId: scope.organizationId,
          blingId: String(conta.id),
        });
      }
    }

    if (itens.length < LIMITE_POR_PAGINA) aindaHaPaginas = false;
  }

  if (aindaHaPaginas) {
    // O laço terminou porque bateu no teto, com a última página cheia: há mais
    // dados do outro lado. Atingir um limite de segurança não é esgotar os
    // dados, e marcar checkpoint aqui registraria uma conclusão que não houve.
    logger.warn('Sincronização financeira interrompida pelo teto de páginas', {
      subsystem: 'provider',
      operacao: 'financeiro.sync.teto-de-paginas',
      entidade,
      organizacaoId: scope.organizationId,
      maxPaginas,
    });
    return {
      processados, falhasTemporarias, falhasPermanentes, itensInvalidos,
      leituraFalhou: false, leituraIncompleta: true,
    };
  }

  await store.marcarCheckpoint(scope, entidade);
  return {
    processados, falhasTemporarias, falhasPermanentes, itensInvalidos,
    leituraFalhou: false, leituraIncompleta: false,
  };
}

/**
 * Sincroniza contas a pagar e a receber do Bling para a organização verificada.
 *
 * A resposta só diz `success: true` quando nenhuma leitura falhou e nenhum item
 * ficou para trás em definitivo. Um `success` que ignora falhas foi a quarta
 * das cinco camadas que esconderam a quebra do catálogo.
 */
export function createFinanceiroSyncHandler(deps: FinanceiroSyncDependencies) {
  const { auth, store, bling } = deps;
  const maxPaginas = deps.maxPaginas ?? MAX_PAGINAS_PADRAO;

  return async function handleFinanceiroSync(request: Request): Promise<NextResponse> {
    let organizacaoId: string | undefined;
    try {
      const ator = await auth.authenticate(request);
      if (!ator) return json({ success: false, error: 'Não autorizado' }, 401);

      const scopeResult = await auth.resolveScope(request);
      if (scopeResult._tag !== 'Resolved') return scopeResult.response;
      const { scope } = scopeResult;
      organizacaoId = scope.organizationId;

      const contasPagar = await sincronizarEntidade(scope, 'financeiro_contas_pagar', 'pagar', store, bling, maxPaginas);
      const contasReceber = await sincronizarEntidade(scope, 'financeiro_contas_receber', 'receber', store, bling, maxPaginas);

      const stats = { contasPagar, contasReceber };
      const leituraFalhou = contasPagar.leituraFalhou || contasReceber.leituraFalhou;
      const leituraIncompleta = contasPagar.leituraIncompleta || contasReceber.leituraIncompleta;
      const itensPerdidos = contasPagar.falhasPermanentes + contasReceber.falhasPermanentes
        + contasPagar.falhasTemporarias + contasReceber.falhasTemporarias
        + contasPagar.itensInvalidos + contasReceber.itensInvalidos;

      if (leituraFalhou) {
        // 502: o provedor não respondeu o que devia. A mensagem nomeia a etapa
        // sem repassar nada do erro dele — o diagnóstico ficou no log.
        return json(
          { success: false, error: 'Não foi possível ler as contas no Bling; a sincronização ficou incompleta.', stats },
          502,
        );
      }

      if (leituraIncompleta) {
        return json(
          {
            success: false,
            // Nao mandar "rode novamente": cada execucao comeca na pagina 1,
            // entao repetir le exatamente as mesmas paginas e deixa as mesmas
            // contas de fora. Prometer progresso por repeticao seria mentira.
            error: 'A sincronização parou no limite de páginas e não trouxe todas as contas. '
              + 'Repetir agora lê as mesmas páginas: é preciso ampliar o limite ou filtrar por período.',
            stats,
          },
          200,
        );
      }

      if (itensPerdidos > 0) {
        return json(
          { success: false, error: `${itensPerdidos} título(s) não puderam ser gravados.`, stats },
          200,
        );
      }

      return json({ success: true, stats }, 200);
    } catch (error: unknown) {
      // CWE-209: o diagnóstico fica no servidor, o cliente recebe a frase fixa.
      logger.error('Falha na sincronização financeira', {
        subsystem: 'app',
        operacao: 'financeiro.sync',
        organizacaoId,
        erro: sanitizeErrorForLog(error).name,
      });
      return json({ success: false, error: 'Erro interno' }, 500);
    }
  };
}
