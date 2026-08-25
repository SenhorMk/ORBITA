import { describe, expect, it } from 'vitest';
import {
  createOrgInputSchema,
  resolveActiveOrganization,
  switchOrgInputSchema,
} from './organizationContext';

describe('Organization Context & Schemas', () => {
  it('validates valid create organization input', () => {
    const input = {
      nome: 'Empresa Teste',
      slug: 'empresa-teste',
    };
    const result = createOrgInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects invalid create organization input with short name or invalid characters in slug', () => {
    const input = {
      nome: 'A',
      slug: 'empresa teste com espaco!',
    };
    const result = createOrgInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('validates switch organization input', () => {
    const input = {
      organizacao_id: '95000000-0000-4000-8000-000000000001',
      expected_version: 0,
    };
    const result = switchOrgInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects invalid uuid in switch organization input', () => {
    const input = {
      organizacao_id: 'not-a-uuid',
    };
    const result = switchOrgInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('resolves active organization with preferred ID when membership is valid', async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  papel: 'owner',
                  organizacoes: {
                    id: '95000000-0000-4000-8000-000000000001',
                    nome: 'Empresa Alpha',
                    slug: 'empresa-alpha',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveActiveOrganization(mockSupabase as any, 'user-1', '95000000-0000-4000-8000-000000000001');
    expect(result).not.toBeNull();
    expect(result?.organizacao.nome).toBe('Empresa Alpha');
    expect(result?.papel).toBe('owner');
  });
});
