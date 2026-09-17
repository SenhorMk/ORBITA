import { z } from 'zod';
import {
  organizationContextStatus,
  type OrganizationContextResult,
} from '@/lib/organizationAuthorization';

/**
 * handlers.ts (intake de direitos do titular)
 * Seam HTTP testável por injeção de dependência (mesmo padrão de
 * `src/app/api/categorias/sync/handlers.ts`). A resposta é sempre a mesma
 * confirmação genérica, verificado ou não — nunca revela se um dado existe
 * antes da identidade ser confirmada (ver ADR seção 1: needs-owner para o
 * canal exato de entrega do código de `cliente_final`).
 */

const IntakeBodySchema = z.discriminatedUnion('titularTipo', [
  z.object({
    titularTipo: z.literal('lojista_user'),
    tipoDireito: z.enum(['acesso', 'exportacao', 'correcao', 'exclusao']),
  }),
  z.object({
    titularTipo: z.literal('cliente_final'),
    tipoDireito: z.enum(['acesso', 'exportacao', 'correcao', 'exclusao']),
    organizacaoId: z.string().uuid(),
    clienteEmail: z.string().email(),
  }),
]);
export type IntakeBody = z.infer<typeof IntakeBodySchema>;

export interface IntakePort {
  /** Resolve o `organizationContext` da sessão, se houver — usado apenas
   * para o caminho `lojista_user` (titular = a própria sessão, nunca um
   * `actorId` enviado no corpo). */
  resolveSessionOrganizationContext(request: Request): Promise<OrganizationContextResult>;
  /** Localiza um cliente pelo e-mail dentro de uma organização específica —
   * usado apenas para *criar* o desafio de verificação internamente; o
   * resultado nunca é exposto na resposta HTTP. */
  findClienteIdByEmail(organizationId: string, email: string): Promise<string | null>;
  /** Registra a solicitação (idempotente) e, se aplicável, o desafio de
   * verificação. Retorna apenas para telemetria interna — nunca é ecoado ao
   * chamador não verificado. */
  registerRequest(params: {
    readonly organizationId: string;
    readonly titularTipo: 'lojista_user' | 'cliente_final';
    readonly titularRefUserId: string | null;
    readonly titularRefClienteId: string | null;
    readonly tipoDireito: 'acesso' | 'exportacao' | 'correcao' | 'exclusao';
    readonly correlationId: string;
  }): Promise<{ readonly requestId: string; readonly isDuplicate: boolean }>;
}

export interface IntakeHandlerDependencies {
  readonly port: IntakePort;
  readonly now?: () => Date;
  readonly correlationId?: () => string;
}

/** Resposta HTTP fixa — mesmo texto, mesmo status, quer o titular exista ou
 * não, quer a verificação tenha sido concluída ou não. É proibido variar
 * esta resposta com base no resultado de `findClienteIdByEmail`. */
const GENERIC_CONFIRMATION = {
  success: true,
  message:
    'Se houver uma solicitação válida associada aos dados informados, ela seguirá para verificação de identidade. Você será contatado pelo canal cadastrado.',
} as const;

export function createTitularIntakeHandlers(deps: IntakeHandlerDependencies) {
  const now = deps.now ?? (() => new Date());
  const correlationId = deps.correlationId ?? (() => crypto.randomUUID());

  return {
    async POST(request: Request): Promise<Response> {
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return Response.json({ success: false, error: 'Corpo da requisição inválido' }, { status: 400 });
      }

      const parsed = IntakeBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return Response.json({ success: false, error: 'Solicitação inválida' }, { status: 400 });
      }
      const body = parsed.data;
      const corrId = correlationId();

      if (body.titularTipo === 'lojista_user') {
        const contextResult = await deps.port.resolveSessionOrganizationContext(request);
        if (contextResult._tag !== 'OrganizationContextResolved') {
          // Sem sessão válida: nunca cria a solicitação, mas ainda assim
          // responde com a confirmação genérica — nunca revela se a sessão
          // era o problema ou se o titular "não existe".
          const status = organizationContextStatus(contextResult);
          if (status === 503) {
            return Response.json({ success: false, error: 'Serviço indisponível' }, { status: 503 });
          }
          return Response.json(GENERIC_CONFIRMATION);
        }

        await deps.port.registerRequest({
          organizationId: contextResult.context.organizationId,
          titularTipo: 'lojista_user',
          // Titular é sempre a própria sessão autenticada — nunca um id vindo do corpo.
          titularRefUserId: contextResult.context.actorId,
          titularRefClienteId: null,
          tipoDireito: body.tipoDireito,
          correlationId: corrId,
        });

        return Response.json(GENERIC_CONFIRMATION);
      }

      // cliente_final: localiza internamente, mas nunca revela o resultado.
      const clienteId = await deps.port.findClienteIdByEmail(body.organizacaoId, body.clienteEmail);
      if (clienteId) {
        await deps.port.registerRequest({
          organizationId: body.organizacaoId,
          titularTipo: 'cliente_final',
          titularRefUserId: null,
          titularRefClienteId: clienteId,
          tipoDireito: body.tipoDireito,
          correlationId: corrId,
        });
      }
      void now();

      return Response.json(GENERIC_CONFIRMATION);
    },
  };
}
