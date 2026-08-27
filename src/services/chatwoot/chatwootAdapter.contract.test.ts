import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatwootAdapter } from './chatwootAdapter';

/**
 * Contract tests against a real, controlled HTTP fake server (no `vi.mock`,
 * no module mocking) exercising the exact wire behavior the production
 * adapter depends on: headers, URL/account routing, schema validation, error
 * classification, and timeout handling. See
 * `.agents/skills/orbita-integrations` and the ticket 11 contract.
 */
describe('ChatwootAdapter contract (fake Chatwoot HTTP server)', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: { path: string; headers: http.IncomingHttpHeaders; body: string } | null = null;
  let nextResponse: { status: number; headers?: Record<string, string>; body: string; delayMs?: number } | null =
    null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        lastRequest = {
          path: req.url || '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };

        const planned = nextResponse;
        const send = () => {
          if (!planned) {
            res.writeHead(500).end('no planned response configured');
            return;
          }
          res.writeHead(planned.status, planned.headers || {});
          res.end(planned.body);
        };

        if (planned?.delayMs) {
          setTimeout(send, planned.delayMs);
        } else {
          send();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  afterEach(() => {
    lastRequest = null;
    nextResponse = null;
  });

  function adapterFor(accountId: string) {
    return ChatwootAdapter.forTesting({
      apiUrl: baseUrl,
      apiToken: 'contract-test-token',
      accountId,
      conexaoId: `conexao-${accountId}`,
    });
  }

  it('sends the api_access_token header on every request', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ payload: [] }) };
    await adapterFor('42').getConversations();
    expect(lastRequest?.headers['api_access_token']).toBe('contract-test-token');
  });

  it('scopes every request to the configured account id in the URL', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ payload: [] }) };
    await adapterFor('777').getConversations();
    expect(lastRequest?.path).toBe('/api/v1/accounts/777/conversations');
  });

  it('rejects a schema-invalid conversations response as invalid-response', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ payload: [{ id: 'not-numeric-and-no-status-field' }] }) };
    const result = await adapterFor('42').getConversations();
    // id coerces from a numeric-looking string only; a non-numeric string fails coercion.
    expect(result).toEqual({ _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false });
  });

  it('classifies HTTP 401 as a permanent, non-retryable failure', async () => {
    nextResponse = { status: 401, body: 'unauthorized' };
    const result = await adapterFor('42').getConversations();
    expect(result).toEqual({
      _tag: 'ChatwootFailed',
      reason: 'http',
      status: 401,
      message: 'unauthorized',
      retryable: false,
    });
  });

  it('classifies HTTP 403 as a permanent, non-retryable failure', async () => {
    nextResponse = { status: 403, body: 'forbidden' };
    const result = await adapterFor('42').getConversations();
    expect(result).toMatchObject({ _tag: 'ChatwootFailed', reason: 'http', status: 403, retryable: false });
  });

  it('classifies HTTP 429 as a retryable rate-limit failure honoring Retry-After', async () => {
    nextResponse = { status: 429, headers: { 'Retry-After': '17' }, body: 'slow down' };
    const result = await adapterFor('42').getConversations();
    expect(result).toEqual({
      _tag: 'ChatwootFailed',
      reason: 'rate-limited',
      status: 429,
      retryAfterSeconds: 17,
      retryable: true,
    });
  });

  it('classifies HTTP 500 as a retryable transient failure', async () => {
    nextResponse = { status: 500, body: 'boom' };
    const result = await adapterFor('42').getConversations();
    expect(result).toMatchObject({ _tag: 'ChatwootFailed', reason: 'http', status: 500, retryable: true });
  });

  it('classifies a request that exceeds the timeout budget as retryable', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ payload: [] }), delayMs: 60_000 };
    const result = await Promise.race([
      adapterFor('42').getConversations(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('test watchdog')), 15_000)),
    ]);
    expect(result).toEqual({ _tag: 'ChatwootFailed', reason: 'timeout', retryable: true });
  }, 20_000);

  it('keeps two organizations with overlapping external account ids fully isolated', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ payload: [{ id: 1, status: 'open' }] }) };
    const orgA = adapterFor('100');
    const requestA = await orgA.getConversations();
    const pathA = lastRequest?.path;

    nextResponse = { status: 200, body: JSON.stringify({ payload: [{ id: 1, status: 'resolved' }] }) };
    const orgB = adapterFor('200');
    const requestB = await orgB.getConversations();
    const pathB = lastRequest?.path;

    expect(pathA).toBe('/api/v1/accounts/100/conversations');
    expect(pathB).toBe('/api/v1/accounts/200/conversations');
    expect(requestA).not.toEqual(requestB);
    expect(orgA.conexaoId).not.toBe(orgB.conexaoId);
  });

  it('sends a message and parses the created message response', async () => {
    nextResponse = {
      status: 200,
      body: JSON.stringify({ id: 909, content: 'oi', message_type: 'outgoing', created_at: '2026-01-01T00:00:00Z' }),
    };
    const result = await adapterFor('42').sendMessage(555, 'oi');
    expect(result).toEqual({
      _tag: 'ChatwootSuccess',
      data: { id: 909, content: 'oi', message_type: 'outgoing', created_at: '2026-01-01T00:00:00Z' },
    });
    expect(lastRequest?.path).toBe('/api/v1/accounts/42/conversations/555/messages');
    expect(JSON.parse(lastRequest?.body || '{}')).toEqual({ content: 'oi', message_type: 'outgoing', private: false });
  });

  it('toggles conversation status against the correct path and body', async () => {
    nextResponse = { status: 200, body: JSON.stringify({ success: true, current_status: 'resolved' }) };
    const result = await adapterFor('42').toggleConversationStatus(555, 'resolved');
    expect(result).toEqual({ _tag: 'ChatwootSuccess', data: { success: true, current_status: 'resolved' } });
    expect(lastRequest?.path).toBe('/api/v1/accounts/42/conversations/555/toggle_status');
    expect(JSON.parse(lastRequest?.body || '{}')).toEqual({ status: 'resolved' });
  });
});
