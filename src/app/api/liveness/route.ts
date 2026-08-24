import { NextRequest, NextResponse } from 'next/server';
import { getCorrelationId } from '@/lib/observability/correlation';

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);

  return NextResponse.json(
    {
      status: 'alive',
      timestamp: new Date().toISOString(),
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
