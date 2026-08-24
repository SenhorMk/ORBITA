import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { syncService } from '@/services/sync';
import { verifySessionAndRole } from '@/lib/auth';
import { checkEncryptionConfiguration } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }

    const encryptionConfiguration = checkEncryptionConfiguration();
    if (encryptionConfiguration._tag === 'InvalidEncryptionConfiguration') {
      console.error(
        'Configuração de criptografia inválida:',
        encryptionConfiguration.reason,
      );
      return NextResponse.json(
        { success: false, error: 'Configuração segura do servidor incompleta.' },
        { status: 503 },
      );
    }

    const blingClient = bling.forUser(session.tenant);

    // 1. Verificar se o token do Bling é válido (isso já tenta renovar o refresh_token se estiver expirado)
    let isBlingAlive = false;
    try {
      isBlingAlive = await blingClient.ping();
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      if (errMessage === 'BLING_INVALID_GRANT') {
        return NextResponse.json({
          success: false,
          needsAuth: true,
          error: 'Conexão com Bling expirada. Por favor, conecte a API novamente.'
        }, { status: 401 });
      }
      throw err;
    }

    // 2. Se a API respondeu mas não foi OK por outro motivo
    if (!isBlingAlive) {
      return NextResponse.json({
        success: false,
        error: 'A API do Bling não está respondendo corretamente no momento.'
      }, { status: 502 });
    }

    // 3. Executar o sync completo (Produtos, Clientes, Pedidos)
    const syncResult = await syncService.syncAll(session.tenant);

    return NextResponse.json({
      success: true,
      message: 'Sincronização inicial concluída com sucesso.',
      stats: syncResult.stats
    });
  } catch (error: unknown) {
    console.error('Erro no startup sync:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('em execução')) {
      return NextResponse.json({
        success: true,
        message: 'A sincronização já está rodando em segundo plano.',
        stats: null
      });
    }
    return NextResponse.json(
      { success: false, error: errorMsg || 'Erro interno durante sincronização inicial' },
      { status: 500 }
    );
  }
}
