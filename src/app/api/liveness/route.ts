import { NextRequest, NextResponse } from 'next/server';
import { getCorrelationId } from '@/lib/observability/correlation';

/**
 * O commit que este processo está servindo, ou `null` quando o build não o
 * carimbou.
 *
 * Existe por uma exigência do Ticket 09: a apresentação precisa dizer **qual
 * versão** foi demonstrada, e até aqui não havia como perguntar isso ao
 * ambiente — só ao painel de quem fez o deploy. Domínio estável com SHA
 * desconhecido não é ambiente fixado; é o mesmo problema das migrations, em
 * que "mesclado" foi confundido com "aplicado".
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
