import { NextResponse } from 'next/server';
import { supabaseServer } from '../../../../lib/supabaseServer';
import { encrypt, decrypt } from '../../../../lib/crypto';
import { readOAuthTransaction } from '../../../../lib/oauth-transaction';
import { exchangeBlingAuthorizationCode } from '../../../../services/blingOAuth';
import { credentialsVault } from '../../../../lib/integrations/credentialsVault';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');
  const errorParam = searchParams.get('error');
  const cookieHeader = request.headers.get('cookie') || '';
  const transactionMatch = cookieHeader.match(/orbita_oauth_transaction=([^;]+)/);
  const transactionCookie = transactionMatch
    ? decodeURIComponent(transactionMatch[1])
    : null;

  if (!stateParam || !transactionCookie) {
    return clearOAuthTransaction(
      htmlPage('error', 'Transação OAuth ausente ou inválida. Tente conectar novamente.'),
    );
  }

  const transaction = readOAuthTransaction(transactionCookie, stateParam);
  if (transaction._tag === 'InvalidOAuthTransaction') {
    return clearOAuthTransaction(
      htmlPage('error', 'Transação OAuth expirada ou inválida. Tente conectar novamente.'),
    );
  }
  const userId = transaction.userId;
  const organizacaoId = transaction.organizacaoId;

  if (errorParam) {
    console.warn('[callback] Bling recusou a autorização.', { error: errorParam });
    return clearOAuthTransaction(
      htmlPage('error', 'O Bling recusou a autorização.'),
    );
  }
  if (!code) {
    return clearOAuthTransaction(
      htmlPage('error', 'Código de autorização não retornado pelo Bling.'),
    );
  }

  let clientId: string | null = null;
  let clientSecret: string | null = null;
  let legacyRecordId: string | null = null;

  // 1. Tentar recuperar credenciais da organização
  if (organizacaoId) {
    const { data: conn } = await supabaseServer
      .from('conexoes_integracao')
      .select('id, metadata')
      .eq('organizacao_id', organizacaoId)
      .eq('provedor', 'bling')
      .maybeSingle();

    if (conn?.id) {
      const creds = await credentialsVault.getDecryptedCredentials(organizacaoId, conn.id);
      if (creds?.client_id && creds?.client_secret) {
        clientId = creds.client_id as string;
        clientSecret = creds.client_secret as string;
      }
    }
  }

  // 2. Fallback para integracoes_bling legada
  if (!clientId || !clientSecret) {
    const { data, error } = await supabaseServer
      .from('integracoes_bling')
      .select('id, client_id, client_secret')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[callback] Falha ao carregar integração Bling:', error.message);
    }

    if (data?.client_id && data?.client_secret) {
      clientId = data.client_id;
      clientSecret = decrypt(data.client_secret);
      legacyRecordId = data.id;
    }
  }

  if (!clientId || !clientSecret) {
    return clearOAuthTransaction(
      htmlPage('error', 'Credenciais não encontradas. Salve as configurações primeiro.'),
    );
  }

  console.log('[callback] Credenciais encontradas. Trocando code por token no Bling...');

  const tokenData = await exchangeBlingAuthorizationCode({
    clientId,
    clientSecret,
    code,
  });

  if (tokenData._tag === 'BlingOAuthTokenExchangeFailed') {
    console.error('[callback] Falha tipada na troca de token Bling.', {
      reason: tokenData.reason,
      status: tokenData.status,
    });
    return clearOAuthTransaction(
      htmlPage('error', 'Não foi possível concluir a conexão com o Bling.'),
    );
  }
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1_000).toISOString();

  console.info('[callback] Tokens do Bling recebidos.');

  // 3. Persistir tokens na conexão de organização (Cofre Privado)
  if (organizacaoId) {
    const { data: conn, error: connErr } = await supabaseServer
      .from('conexoes_integracao')
      .upsert(
        {
          organizacao_id: organizacaoId,
          provedor: 'bling',
          nome: 'Principal',
          status: 'conectado',
          metadata: { client_id: clientId },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organizacao_id, provedor, nome' },
      )
      .select('id')
      .single();

    if (connErr || !conn?.id) {
      console.error('[callback] Erro ao persistir conexao_integracao:', connErr?.message);
    } else {
      await credentialsVault.saveEncryptedCredentials(organizacaoId, conn.id, {
        client_id: clientId,
        client_secret: clientSecret,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_expires_at: expiresAt,
      });
      console.info('[callback] Conexao e credenciais privadas salvas no cofre da organizacao.');
    }
  }

  // 4. Manter compatibilidade com integracoes_bling legada durante migração
  if (legacyRecordId) {
    await supabaseServer
      .from('integracoes_bling')
      .update({
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token),
        token_expires_at: expiresAt,
      })
      .eq('id', legacyRecordId);
  } else if (userId) {
    await supabaseServer.from('integracoes_bling').upsert(
      {
        user_id: userId,
        client_id: clientId,
        client_secret: encrypt(clientSecret),
        access_token: encrypt(tokenData.access_token),
        refresh_token: encrypt(tokenData.refresh_token),
        token_expires_at: expiresAt,
      },
      { onConflict: 'user_id' },
    );
  }

  console.log('[callback] ✅ Tokens salvos com sucesso.');

  return clearOAuthTransaction(htmlPage('success', ''));
}

function clearOAuthTransaction(response: NextResponse): NextResponse {
  response.cookies.set('orbita_oauth_transaction', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/api/bling/callback',
  });
  return response;
}

function htmlPage(status: 'success' | 'error', message: string, statusCode: number = status === 'error' ? 400 : 200) {
  const isSuccess = status === 'success';
  const icon = isSuccess ? '✅' : '❌';
  const title = isSuccess ? 'Conexão Realizada!' : 'Erro na Conexão';
  const desc = isSuccess
    ? 'Sua conta do Bling foi vinculada com sucesso. Você já pode fechar esta janela.'
    : message;
  const color = isSuccess ? '#10b981' : '#ef4444';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ORBITA</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #09090b;
      color: #f4f4f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1rem;
    }
    .card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .icon { font-size: 3.5rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.75rem 0; color: #fff; }
    p { font-size: 0.95rem; color: #a1a1aa; line-height: 1.5; margin: 0 0 1.5rem 0; }
    .btn {
      display: inline-block;
      background: ${color};
      color: #fff;
      font-weight: 500;
      font-size: 0.9rem;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${desc}</p>
    <button class="btn" onclick="window.close()">Fechar Janela</button>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'BLING_AUTH_COMPLETE', status: '${status}' }, '*');
      setTimeout(() => window.close(), 2500);
    }
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
