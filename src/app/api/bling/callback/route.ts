import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { encrypt, decrypt } from '@/lib/crypto';
import { readOAuthTransaction } from '@/lib/oauth-transaction';
import { exchangeBlingAuthorizationCode } from '@/services/blingOAuth';

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
  let recordId: string | null = null;
  let tableName = 'integracoes_bling';
  let expiresColumn = 'token_expires_at';

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
    recordId = data.id;
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

  // Salvar tokens no banco
  const payload: any = {
    access_token: encrypt(tokenData.access_token),
    refresh_token: encrypt(tokenData.refresh_token),
    [expiresColumn]: expiresAt,
  };

  let saveErr: any = null;

  if (recordId) {
    const { error } = await supabaseServer.from(tableName).update(payload).eq('id', recordId);
    saveErr = error;
  } else if (userId) {
    // Nenhum registro ainda — inserir
    const { error } = await supabaseServer.from('integracoes_bling').insert({
      user_id: userId,
      client_id: clientId,
      client_secret: encrypt(clientSecret),
      access_token: encrypt(tokenData.access_token),
      refresh_token: encrypt(tokenData.refresh_token),
      token_expires_at: expiresAt,
    });
    saveErr = error;
  }

  if (saveErr) {
    console.error('[callback] Erro ao salvar tokens:', saveErr.message);
    return clearOAuthTransaction(
      htmlPage('error', 'Tokens gerados, mas não foi possível persistir a conexão.'),
    );
  }

  console.log('[callback] ✅ Tokens salvos com sucesso na tabela:', tableName);

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

function htmlPage(type: 'success' | 'error', message: string): NextResponse {
  if (type === 'success') {
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><title>Bling Conectado!</title>
<meta http-equiv="refresh" content="2;url=/" />
<style>
  body{font-family:sans-serif;background:#0d0818;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1f35;border:1px solid #22c55e44;border-radius:24px;padding:48px;text-align:center;max-width:440px}
  h1{color:#22c55e;font-size:24px;margin:0 0 8px}
  p{color:#94a3b8;margin:0 0 24px}
  .spinner{width:40px;height:40px;border:3px solid #334155;border-top-color:#7c3aed;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
  <div class="spinner"></div>
  <h1>✅ Bling Conectado!</h1>
  <p>Tokens gerados e salvos com sucesso.<br/>Redirecionando para o Orbita...</p>
</div></body></html>`;
    return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  const escapedMessage = typeof message === 'string' 
    ? message.replace(/</g, '&lt;').replace(/>/g, '&gt;') 
    : String(message);

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><title>Erro</title>
<style>
  body{font-family:sans-serif;background:#0d0818;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1f35;border:1px solid #ef444433;border-radius:24px;padding:48px;text-align:center;max-width:500px}
  h1{color:#ef4444;font-size:22px;margin:0 0 12px}
  p{color:#94a3b8;font-size:13px;word-break:break-word}
  a{display:inline-block;margin-top:20px;background:#1e293b;color:#94a3b8;padding:10px 24px;border-radius:10px;text-decoration:none;border:1px solid #334155}
</style></head>
<body><div class="card">
  <h1>❌ Erro na Conexão</h1>
  <p>${escapedMessage}</p>
  <a href="/">← Voltar ao Orbita</a>
</div></body></html>`;
  return new NextResponse(html, { status: 400, headers: { 'Content-Type': 'text/html' } });
}
