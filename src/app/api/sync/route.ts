import { NextResponse } from 'next/server';
import { syncService } from '@/services/sync';
import { verifySessionAndRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (session.role !== 'dono') {
      return NextResponse.json({ success: false, error: 'Acesso negado: Apenas dono pode sincronizar' }, { status: 403 });
    }

    const result = await syncService.syncAll(session.tenant);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Erro na API de sincronização:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Erro interno na sincronização' },
      { status: 500 }
    );
  }
}

