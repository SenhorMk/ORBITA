import { NextRequest, NextResponse } from 'next/server';
import { getCorrelationId } from '@/lib/observability/correlation';

/**
 * O commit que este processo está servindo, ou `null` quando o build não o
 * carimbou.
 *
 * Existe para que o ambiente diga **qual versão** está servindo, sem depender
 * do painel de quem fez o deploy. Domínio estável com SHA desconhecido não é
 * ambiente fixado — assim como uma migration mesclada não é uma migration
 * aplicada.
 *
 * `null` é a resposta honesta quando a variável não existe. Devolver a string
 * "desconhecido", ou o SHA do último build local, faria uma evidência falsa
 * caber num campo que existe justamente para não deixar isso acontecer.
 */
function commitServido(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  return sha && sha.length > 0 ? sha : null;
}

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);

  return NextResponse.json(
    {
      status: 'alive',
      timestamp: new Date().toISOString(),
      commit: commitServido(),
    },
    {
      status: 200,
      headers: {
        'x-correlation-id': correlationId,
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
