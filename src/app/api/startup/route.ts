import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { syncService } from '@/services/sync';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { checkEncryptionConfiguration } from '@/lib/crypto';
import { descreverErro } from '@/lib/erroLegivel';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // Ticket 22 — o portão legado saiu; a resolução de escopo logo abaixo já
    // fazia a mesma pergunta pela fonte certa.
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    // A sincronização inicial escreve o catálogo inteiro da organização; é ação
    // de gestão, como `POST /api/sync`, e não leitura.
    if (!escopoTemCapacidade(scope, 'organization:manage')) {
      return NextResponse.json(
        { success: false, error: 'Acesso negado: apenas quem administra a organização pode sincronizar' },
        { status: 403 },
      );
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

    const blingClient = bling.forVerifiedOrganization(scope);

    // 1. Verificar se o token do Bling é válido (isso já tenta renovar o refresh_token se estiver expirado)
    let isBlingAlive = false;
    try {
      isBlingAlive = await blingClient.ping();
    } catch (err: unknown) {
      const errMessage = descreverErro(err);
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
    const syncResult = await syncService.syncAll(scope);

    return NextResponse.json({
      success: true,
      message: 'Sincronização inicial concluída com sucesso.',
      stats: syncResult.stats
    });
  } catch (error: unknown) {
    registrarFalhaInterna('startup.sync', error);
    const errorMsg = descreverErro(error);
    if (errorMsg.includes('em execução')) {
      return NextResponse.json({
        success: true,
        message: 'A sincronização já está rodando em segundo plano.',
        stats: null
      });
    }
    return NextResponse.json(
      { success: false, error: 'Erro interno durante sincronização inicial' },
      { status: 500 }
    );
  }
}
