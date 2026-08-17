import { describe, expect, it } from 'vitest';

import { verifySessionAndRole } from './auth';

describe('verifySessionAndRole', () => {
  it('rejects a token supplied only through the query string', async () => {
    const request = new Request('https://orbita.test/api/bling/authorize?token=leaked-token');
    const authUserLookup = {
      getUser: async (): Promise<never> => {
        throw new Error('Query-string tokens must not reach the identity provider.');
      },
    };

    await expect(verifySessionAndRole(request, authUserLookup)).resolves.toBeNull();
  });
});
