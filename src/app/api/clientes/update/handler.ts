import { NextResponse } from 'next/server';

import { clienteRequestSchema, type ClienteRequest } from '@/lib/config/clienteContract';
import type { BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';

export interface ContatoBlingPayload {
  readonly nome: string;
  readonly email?: string;
  readonly telefone?: string;
  readonly numeroDocumento?: string;
  readonly tipo: string;
  readonly indicadorIe: number;
  readonly cep?: string;
  readonly endereco?: string;
  readonly numero?: string;
  readonly bairro?: string;
  readonly cidade?: string;
  readonly uf?: string;
}

export interface ClienteBlingPort {
  criar(payload: ContatoBlingPayload): Promise<BlingCallResult<{ id: string }>>;
  atualizar(id: string, payload: ContatoBlingPayload): Promise<BlingCallResult<void>>;
}

export interface ClientePersistido {
  readonly id: string;
  readonly blingId: string;
  readonly nome: string;
}

export interface ClienteStorePort {
  upsert(scope: VerifiedOrganizationScope, cliente: {
    readonly id?: string;
    readonly blingId: string;
    readonly nome: string;
    readonly email: string;
    readonly telefone: string;
    readonly cpfCnpj: string;
    /**
     * Endereço e classificação fiscal, persistidos desde a migration 54.
     * Antes eram enviados ao Bling e descartados aqui: o formulário de edição
     * abria sempre vazio e um PUT sem endereço podia apagar o do ERP.
     */
    readonly tipo: string;
    readonly indicadorIe: number;
    readonly cep: string;
    readonly endereco: string;
    readonly numero: string;
    readonly bairro: string;
    readonly cidade: string;
    readonly uf: string;
  }): Promise<ClientePersistido>;
}

export interface ClienteAuthPort {
  authorize(request: Request): Promise<
    | { readonly _tag: 'Authorized'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Denied'; readonly response: NextResponse }
  >;
}

export interface ClienteDependencies {
  readonly auth: ClienteAuthPort;
  readonly bling: ClienteBlingPort;
  readonly store: ClienteStorePort;
}

export interface ClienteResponseBody {
  readonly success: boolean;
  readonly client?: ClientePersistido;
  readonly error?: string;
  /**
   * **Prova** de que nenhum efeito externo foi confirmado: repetir é seguro.
   *
   * Só é afirmado quando o servidor sabe que nada saiu — corpo inválido,
   * contrato recusado antes do envio — ou quando o Bling **respondeu
   * recusando** (4xx). Nos dois casos não existe contato criado lá.
   *
   * A ausência deste campo **não** significa "não é seguro repetir e eu sei por
   * quê"; significa que não há prova. Ver `DESFECHO AMBÍGUO` abaixo.
   */
  readonly retrySafe?: boolean;
  /**
   * O provedor **já criou/atualizou** o contato e só a gravação local falhou.
   *
   * É o desfecho mais perigoso deste fluxo, e por isso ele chega nomeado em vez
   * de escondido dentro de uma frase: repetir a requisição não conserta nada e
   * pode cadastrar um **segundo** contato no Bling. Quem consome esta resposta
   * deve oferecer sincronização/reconciliação, nunca "tentar novamente".
   */
  readonly reconcileRequired?: boolean;
  /** O contato que o Bling confirmou, para a reconciliação ter por onde começar. */
  readonly blingId?: string;
}

/**
 * Os três desfechos de falha, e por que eles não são dois.
 *
 * 1. **Repetição comprovadamente segura** (`retrySafe: true`) — o servidor sabe
 *    que nada foi confirmado do outro lado.
 * 2. **Reconciliação necessária** (`reconcileRequired: true`) — o Bling
 *    confirmou e a gravação local falhou.
 * 3. **DESFECHO AMBÍGUO** — nenhum dos dois. O servidor pediu ao Bling e não
 *    obteve resposta conclusiva: 5xx do provedor, ou o `INVALID_RESPONSE` em
 *    que ele responde **sucesso sem devolver o id** do contato. Nesse estado o
 *    contato pode existir lá. Repetir pode duplicar, e dizer "nada foi criado"
 *    seria afirmar um fato que ninguém verificou.
 *
 * Tratar "não é reconciliação" como "é seguro repetir" é o erro que esta
 * distinção existe para impedir — do lado do servidor e do lado da tela.
 */

/** A recusa do provedor é prova de que nada foi criado? Só quando ele recusou. */
function recusaProvadaPeloProvedor(status: number): boolean {
  // 4xx é o Bling dizendo "não aceito". 5xx é o Bling não dizendo nada
  // conclusivo — a requisição pode ter sido processada antes de ele falhar.
  // E `INVALID_RESPONSE` carrega o status 2xx original, então cai fora daqui
  // por construção: ali o contato provavelmente FOI criado, só sem id de volta.
  return status >= 400 && status < 500;
}

function fail(
  error: string,
  status: number,
  extras: Omit<ClienteResponseBody, 'success' | 'error'> = {},
): NextResponse {
  return NextResponse.json({ success: false, error, ...extras } satisfies ClienteResponseBody, { status });
}

/**
 * Frase do desfecho ambíguo.
 *
 * Ela **não** diz que o contato não foi criado, porque não se sabe. O que ela
 * pede é a conferência antes de qualquer nova tentativa — que é a única ação
 * correta quando o efeito externo é desconhecido.
 */
const FALHA_AMBIGUA_PUBLICA =
  'Não foi possível confirmar o resultado do envio ao Bling. O contato pode ter sido criado lá. '
  + 'Sincronize os clientes e confira antes de tentar de novo.';

/**
 * Frase pública da falha parcial. Fixa, e sem nada da linha recusada.
 *
 * A versão anterior interpolava `descreverErro(error)` aqui, e o que o Postgres
 * põe em `message`/`details` numa violação de constraint são **valores da
 * linha**: nome, e-mail, telefone do contato apareceram no diálogo de erro da
 * tela. Diagnóstico técnico é assunto do servidor; a tela recebe o que dá para
 * agir, e nada além.
 */
const FALHA_PARCIAL_PUBLICA =
  'Contato salvo no Bling, mas não foi possível concluir a gravação no ORBITA. '
  + 'Sincronize os clientes para reconciliar.';

function toContatoPayload(body: ClienteRequest): ContatoBlingPayload {
  const opcional = (valor: string | undefined) => (valor && valor.trim() ? valor.trim() : undefined);
  return {
    nome: body.nome,
    email: opcional(body.email),
    telefone: opcional(body.telefone),
    numeroDocumento: opcional(body.cpfCnpj),
    tipo: body.tipo,
    indicadorIe: body.indicadorIe,
    cep: opcional(body.cep),
    endereco: opcional(body.endereco),
    numero: opcional(body.numero),
    bairro: opcional(body.bairro),
    cidade: opcional(body.cidade),
    uf: opcional(body.uf),
  };
}

/**
 * `POST /api/clientes/update`.
 *
 * O Bling é a fonte da verdade: nada é gravado localmente antes de ele
 * confirmar. Duas regras deste handler existem por causa de defeitos concretos
 * da versão anterior:
 *
 * 1. **Uma falha de PUT nunca vira POST.** Antes, um erro transitório na
 *    atualização (429, 500) fazia o código "degradar para criação" e cadastrar
 *    um contato **duplicado** no Bling para alguém que já existia lá.
 * 2. **Falha do provedor nunca vira sucesso.** Antes, quando PUT e POST
 *    falhavam, a função devolvia `Synced` e o cliente era gravado localmente
 *    com o id antigo ou um `LOCAL-CLI-<timestamp>` inventado — a UI mostrava
 *    sucesso para uma sincronização que não aconteceu.
 */
export function createClienteUpdateHandler(deps: ClienteDependencies) {
  return async function handleClienteUpdate(request: Request): Promise<NextResponse> {
    const authorization = await deps.auth.authorize(request);
    if (authorization._tag === 'Denied') return authorization.response;
    const { scope } = authorization;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // Nada saiu daqui: nem Bling, nem banco. Repetir é seguro, e provado.
      return fail('Corpo da requisição não é um JSON válido.', 400, { retrySafe: true });
    }

    const parsed = clienteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const detalhes = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`)
        .join('; ');
      // Recusado antes de qualquer envio — o provedor nem foi procurado.
      return fail(`Cliente inválido: ${detalhes}`, 400, { retrySafe: true });
    }
    const body = parsed.data;
    const payload = toContatoPayload(body);

    let blingId: string;
    if (body.blingId) {
      const atualizado = await deps.bling.atualizar(body.blingId, payload);
      if (atualizado._tag === 'BlingFailed') {
        return recusaProvadaPeloProvedor(atualizado.failure.status)
          ? fail(`O Bling recusou a atualização do contato: ${atualizado.failure.message}`, 400, { retrySafe: true })
          : fail(FALHA_AMBIGUA_PUBLICA, 502);
      }
      blingId = body.blingId;
    } else {
      const criado = await deps.bling.criar(payload);
      if (criado._tag === 'BlingFailed') {
        // Recusa (4xx) é prova de que não há contato criado; qualquer outra
        // coisa é desfecho ambíguo, e aí a tela não pode oferecer repetir.
        return recusaProvadaPeloProvedor(criado.failure.status)
          ? fail(`O Bling recusou o cadastro do contato: ${criado.failure.message}`, 400, { retrySafe: true })
          : fail(FALHA_AMBIGUA_PUBLICA, 502);
      }
      blingId = criado.value.id;
    }

    try {
      const client = await deps.store.upsert(scope, {
        id: body.id,
        blingId,
        nome: body.nome,
        email: body.email ?? '',
        telefone: body.telefone ?? '',
        cpfCnpj: body.cpfCnpj ?? '',
        tipo: body.tipo,
        indicadorIe: body.indicadorIe,
        cep: body.cep ?? '',
        endereco: body.endereco ?? '',
        numero: body.numero ?? '',
        bairro: body.bairro ?? '',
        cidade: body.cidade ?? '',
        uf: body.uf ?? '',
      });

      return NextResponse.json({ success: true, client } satisfies ClienteResponseBody, { status: 200 });
    } catch (error: unknown) {
      // O diagnóstico fica aqui — operação, organização, ator, classe do erro e
      // SQLSTATE, sem `message`, `details` nem `hint`, que é onde o Postgres
      // escreve valores da linha (CWE-209, e PII no caso de um contato).
      registrarFalhaInterna('clientes.update.gravar', error, {
        organizacaoId: scope.organizationId,
        atorId: scope.actorId,
      });

      // E o desfecho chega **estruturado**: o Bling confirmou, então repetir a
      // requisição não conserta e pode criar um segundo contato lá.
      return NextResponse.json(
        {
          success: false,
          error: FALHA_PARCIAL_PUBLICA,
          reconcileRequired: true,
          blingId,
        } satisfies ClienteResponseBody,
        { status: 500 },
      );
    }
  };
}
