import { describe, it, expect } from 'vitest';
import { checkModuleBoundaries, violaDistincaoDeAutorizacao } from './check-module-boundaries.mjs';

describe('checkModuleBoundaries script', () => {
  it('valida a estrutura atual do codebase sem violar limites de domínio ou inversão de camada', () => {
    const result = checkModuleBoundaries();
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// Ticket 20 — a guarda que impede o atalho de voltar. Ela precisa ser exercitada
// contra uma linha que viola, e não só contra o código já corrigido: uma regra
// que nunca disparou não é prova de que dispararia.
describe('guarda da distinção de autorização', () => {
  const importacao = "import { verifySessionAndRole } from '@/lib/auth';";

  it('acusa o atalho em rota de organização e em rota de convite', () => {
    expect(violaDistincaoDeAutorizacao('src/app/api/organizacoes/[id]/convites/route.ts', importacao)).toBe(true);
    expect(violaDistincaoDeAutorizacao('src/app/api/convites/aceitar/route.ts', importacao)).toBe(true);
    expect(
      violaDistincaoDeAutorizacao(
        'src/app/api/organizacoes/[id]/membros/route.ts',
        '  const session = await verifySessionAndRole(req);',
      ),
    ).toBe(true);
  });

  it('não acusa as fronteiras que preservam a distinção', () => {
    const linha = '  const authorization = await authorizeRequestOrganizationCapability(req, orgId, \'organization:manage\');';
    expect(violaDistincaoDeAutorizacao('src/app/api/organizacoes/[id]/convites/route.ts', linha)).toBe(false);
    expect(
      violaDistincaoDeAutorizacao(
        'src/app/api/convites/aceitar/route.ts',
        "  const identity = await resolveAuthenticatedIdentity(req);",
      ),
    ).toBe(false);
  });

  it('não alcança os chamadores legados fora dessa fronteira', () => {
    expect(violaDistincaoDeAutorizacao('src/app/api/config/route.ts', importacao)).toBe(false);
    expect(violaDistincaoDeAutorizacao('src/lib/auth.ts', importacao)).toBe(false);
  });
});
