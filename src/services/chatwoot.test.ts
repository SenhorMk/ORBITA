import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseServer', () => ({
  supabaseServer: {
    from: vi.fn(),
  },
}));

import { ChatwootClient } from './chatwoot';

describe('ChatwootClient Contract & Resilience Tests', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-key-12345678901234567890';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-key-12345678901234567890';
  });

  const config = {
    apiUrl: 'https://chatwoot.test',
    apiToken: 'test-token-123',
    accountId: '42',
  };

  it('handles valid getConversations responses', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payload: [{ id: 101, status: 'open' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await client.getConversations(mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootSuccess',
      data: [{ id: 101, status: 'open' }],
    });
  });

  it('handles invalid / malformed JSON responses in getConversations', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('invalid json payload', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await client.getConversations(mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootFailed',
      reason: 'invalid-response',
    });
  });

  it('handles HTTP error responses (e.g. 500 Internal Server Error)', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Server error', { status: 500 })
    );

    const result = await client.getConversations(mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootFailed',
      reason: 'http',
      status: 500,
    });
  });

  it('handles rate-limited responses (HTTP 429) with Retry-After header', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'Retry-After': '45' },
      })
    );

    const result = await client.getConversations(mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootFailed',
      reason: 'rate-limited',
      status: 429,
      retryAfterSeconds: 45,
    });
  });

  it('handles network and timeout errors gracefully', async () => {
    const client = new ChatwootClient(config);
    const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
    const mockFetch = vi.fn().mockRejectedValue(timeoutError);

    const result = await client.getConversations(mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootFailed',
      reason: 'timeout',
    });
  });

  it('handles valid getMessages responses', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payload: [{ id: 501, content: 'Oi' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await client.getMessages(101, mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootSuccess',
      data: [{ id: 501, content: 'Oi' }],
    });
  });

  it('handles valid sendMessage request and response', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 502, content: 'Resposta' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await client.sendMessage(101, 'Resposta', mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootSuccess',
      data: { id: 502, content: 'Resposta' },
    });
  });

  it('handles valid toggleConversationStatus request', async () => {
    const client = new ChatwootClient(config);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, current_status: 'resolved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await client.toggleConversationStatus(101, 'resolved', mockFetch);
    expect(result).toEqual({
      _tag: 'ChatwootSuccess',
      data: { success: true, current_status: 'resolved' },
    });
  });

  it('normalizes Brazilian phone numbers to E.164', () => {
    const client = new ChatwootClient();
    expect(client.normalizePhoneNumber('(11) 98765-4321')).toBe('+5511987654321');
    expect(client.normalizePhoneNumber('5511987654321')).toBe('+5511987654321');
    expect(client.normalizePhoneNumber('+5511987654321')).toBe('+5511987654321');
    expect(client.normalizePhoneNumber('')).toBe('');
  });
});
