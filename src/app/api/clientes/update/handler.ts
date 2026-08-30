import { NextResponse } from 'next/server';

import { clienteRequestSchema, type ClienteRequest } from '@/lib/config/clienteContract';
import type { BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

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
}

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error } satisfies ClienteResponseBody, { status });
}

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
      return fail('Corpo da requisição não é um JSON válido.', 400);
    }

    const parsed = clienteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const detalhes = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`)
        .join('; ');
      return fail(`Cliente inválido: ${detalhes}`, 400);
    }
    const body = parsed.data;
    const payload = toContatoPayload(body);

    let blingId: string;
    if (body.blingId) {
      const atualizado = await deps.bling.atualizar(body.blingId, payload);
      if (atualizado._tag === 'BlingFailed') {
        return fail(`O Bling recusou a atualização do contato: ${atualizado.failure.message}`, 400);
      }
      blingId = body.blingId;
    } else {
      const criado = await deps.bling.criar(payload);
      if (criado._tag === 'BlingFailed') {
        return fail(`O Bling recusou o cadastro do contato: ${criado.failure.message}`, 400);
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
      });

      return NextResponse.json({ success: true, client } satisfies ClienteResponseBody, { status: 200 });
    } catch (error: unknown) {
      const causa = error instanceof Error ? error.message : String(error);
      return fail(
        `Contato salvo no Bling (id ${blingId}), mas falhou ao gravar no ORBITA: ${causa}. Sincronize os clientes para reconciliar.`,
        500,
      );
    }
  };
}
