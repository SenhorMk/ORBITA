import { describe, expect, it } from 'vitest';

import { readBearerToken } from './bearer-token';

describe('readBearerToken', () => {
  it('returns a bearer token from the authorization header', () => {
    const request = new Request('https://orbita.test/api/dashboard', {
      headers: { Authorization: 'Bearer signed-access-token' },
    });

    expect(readBearerToken(request)).toEqual({
      _tag: 'BearerTokenFound',
      token: 'signed-access-token',
    });
  });

  it('does not accept a token supplied only in the query string', () => {
    const request = new Request('https://orbita.test/api/dashboard?token=leaked-token');

    expect(readBearerToken(request)).toEqual({ _tag: 'BearerTokenMissing' });
  });

  it.each(['mock-dono', 'mock-colaborador', 'dev-fallback'])(
    'rejects the development token %s',
    (token) => {
      const request = new Request('https://orbita.test/api/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(readBearerToken(request)).toEqual({ _tag: 'DevelopmentTokenRejected' });
    },
  );
});
