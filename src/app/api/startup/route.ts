import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { syncService, type SyncAllResult } from '@/services/sync';
import { escopoTemCapacidade, resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { checkEncryptionConfiguration } from '@/lib/crypto';
import { descreverErro } from '@/lib/erroLegivel';

export const dynamic = 'force-dynamic';

/**
 * Traduz o resultado da sincronização inicial em resposta HTTP.
 *
 * A resposta depende de `resultado.success`, e não só de a chamada ter
 * voltado: o serviço encerra o job como `failed` em vez de rejeitar, então
 * "falhou" e "concluiu" retornam normalmente, e sem esta distinção a tela
 * diria que a sincronização inicial deu certo com zero registros.
 */
function respostaDaSincronizacao(resultado: SyncAllResult): NextResponse {
  if (resultado.success) {
    return NextResponse.json({
      success: true,
      message: 'Sincronização inicial concluída com sucesso.',
      stats: resultado.stats,
    });
  }

  // "Já estava rodando" só vale para `running`, que é o único estado que prova
  // que alguém pegou o trabalho. `queued` **não prova nada**: pode ser que
  // ninguém tenha conseguido nem tentar — foi assim que esta rota voltou a
  // anunciar sucesso falso depois que `processJob` deixou de encerrar o job em
  // falha ambígua de aquisição de lease.
  if (resultado.status === 'running') {
    return NextResponse.json({
      success: true,
      message: 'A sincronização já está rodando em segundo plano.',
      stats: null,
    });
  }

  // Nada foi executado, e o job continua pendente. A resposta é não bem-sucedida
  // de propósito: 202 seria lida como "aceito e em andamento" por qualquer
  // cliente que olhe só o status, e não é isso que aconteceu.
  //
  // A mensagem não promete retomada. Quando a falha acontece antes da lease, não
  // há lease para expirar e **não existe recuperação automática**: o trabalho
  // fica pendente até alguém chamar de novo. Dizer "será retomado" seria a mesma
  // classe de mentira que o "já está rodando" que esta rota acabou de perder.
  if (resultado.status === 'preparation_failed' || resultado.status === 'queued') {
    return NextResponse.json(
      {
        success: false,
        error: 'Não foi possível iniciar a sincronização agora. O trabalho segue pendente; tente novamente.',
      },
      { status: 503 },
    );
  }

  // O desfecho não pôde ser confirmado. Cobre dois caminhos — processou e
  // falhou sem conseguir gravar `failed`, ou processou até o fim e a gravação de
  // `completed` não respondeu. **A mensagem não pode afirmar que falhou**: no
  // segundo caminho o trabalho terminou, e só o registro é que ficou incerto.
  if (resultado.status === 'finalization_failed') {
    return NextResponse.json(
      {
        success: false,
        error: 'Não foi possível confirmar o resultado da sincronização. Tente novamente.',
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { success: false, error: 'Erro interno durante sincronização inicial' },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    // Identidade e vínculo com a organização vêm do escopo verificado.
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
    return respostaDaSincronizacao(await syncService.syncAll(scope));
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
