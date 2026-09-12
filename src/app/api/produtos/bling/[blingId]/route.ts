import { NextResponse } from 'next/server';
import { z } from 'zod';

import { organizationContextStatus } from '@/lib/organizationAuthorization';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { organizationContextToScope } from '@/lib/verifiedOrganizationScope';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import {
  produtoFormatoSchema,
  produtoSituacaoSchema,
  produtoTipoSchema,
} from '@/lib/config/produtoContract';
import { bling } from '@/services/bling';

/**
 * `GET /api/produtos/bling/[blingId]` — os obrigatórios REAIS de um produto
 * que já existe no ERP.
 *
 * Existe porque o formulário de produto não pode inventá-los. `tipo`,
 * `situacao` e `formato` são obrigatórios no `PUT` do Bling e **não** são
 * persistidos localmente: abrir um produto sincronizado com `P`/`A`/`S` fixos e
 * salvar sobrescreve no ERP o que estava lá — um serviço vira produto, um
 * inativo volta a ativo, uma composição vira simples.
 *
 * Devolve **somente** os quatro campos que o formulário precisa preencher.
 * Nada de eco do produto inteiro do provedor: o que não sai daqui não precisa
 * ser revisado depois. O token nunca chega ao navegador — a chamada ao ERP
 * acontece aqui, com as credenciais da organização verificada.
 */

/** O que o provedor devolve e este endpoint aceita publicar. */
const obrigatoriosDoBlingSchema = z.object({
  tipo: produtoTipoSchema,
  situacao: produtoSituacaoSchema,
  formato: produtoFormatoSchema,
  unidade: z.string().trim().min(1).max(6),
});

export type ObrigatoriosDoProdutoNoBling = z.infer<typeof obrigatoriosDoBlingSchema>;

export interface ProdutoBlingResponseBody {
  readonly success: boolean;
  readonly obrigatorios?: ObrigatoriosDoProdutoNoBling;
  readonly error?: string;
}

const blingIdSchema = z.string().regex(/^\d+$/u);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ blingId: string }> },
): Promise<NextResponse> {
  const { blingId } = await params;

  const idValidado = blingIdSchema.safeParse(blingId);
  if (!idValidado.success) {
    return NextResponse.json(
      { success: false, error: 'Id do produto no Bling inválido.' } satisfies ProdutoBlingResponseBody,
      { status: 400 },
    );
  }

  // A mesma capacidade que gravar o catálogo exige: quem lê isto é quem está a
  // um clique de escrever no ERP com o resultado.
  const contextResult = await resolveActiveRequestOrganizationContext(request);
  if (contextResult._tag !== 'OrganizationContextResolved') {
    const status = organizationContextStatus(contextResult);
    return NextResponse.json(
      {
        success: false,
        error: status === 503 ? 'Serviço de autorização indisponível' : 'Não autorizado',
      } satisfies ProdutoBlingResponseBody,
      { status },
    );
  }
  if (!contextResult.context.capabilities.has('organization:manage')) {
    return NextResponse.json(
      { success: false, error: 'Capacidade insuficiente para gerenciar o catálogo' } satisfies ProdutoBlingResponseBody,
      { status: 403 },
    );
  }

  const scope = organizationContextToScope(contextResult.context);

  try {
    const produto = await bling.forVerifiedOrganization(scope).getProduto(idValidado.data);

    // `getProduto` devolve `null` quando o ERP não respondeu ou não tem o
    // produto. Os dois casos são o mesmo para quem chama: não há valor
    // autoritativo, e portanto não há o que preencher no formulário.
    const obrigatorios = obrigatoriosDoBlingSchema.safeParse(produto ?? {});
    if (!obrigatorios.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Não foi possível obter os dados obrigatórios deste produto no Bling.',
        } satisfies ProdutoBlingResponseBody,
        { status: 502 },
      );
    }

    return NextResponse.json(
      { success: true, obrigatorios: obrigatorios.data } satisfies ProdutoBlingResponseBody,
      { status: 200 },
    );
  } catch (error: unknown) {
    registrarFalhaInterna('produtos.bling.obrigatorios', error, {
      organizacaoId: scope.organizationId,
      atorId: scope.actorId,
    });
    return NextResponse.json(
      { success: false, error: MENSAGEM_PUBLICA_DE_FALHA } satisfies ProdutoBlingResponseBody,
      { status: 500 },
    );
  }
}
