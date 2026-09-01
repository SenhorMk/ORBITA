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

  it('acusa o atalho de sessão em qualquer rota', () => {
    expect(violaDistincaoDeAutorizacao('src/app/api/organizacoes/[id]/convites/route.ts', importacao)).toBe(true);
    expect(violaDistincaoDeAutorizacao('src/app/api/convites/aceitar/route.ts', importacao)).toBe(true);
    expect(violaDistincaoDeAutorizacao('src/app/api/pedidos/manual/route.ts', importacao)).toBe(true);
    expect(
      violaDistincaoDeAutorizacao(
        'src/app/api/organizacoes/[id]/membros/route.ts',
        '  const session = await verifySessionAndRole(req);',
      ),
    ).toBe(true);
  });

  // Ticket 22 — `resolveActorContext` bebe da mesma fonte legada, e o
  // inventário original do ticket não o via. A guarda cobre os dois.
  it('acusa também `resolveActorContext`, o outro seam legado', () => {
    expect(
      violaDistincaoDeAutorizacao(
        'src/app/api/categorias/sync/route.ts',
        "import { resolveActorContext } from '@/lib/auth';",
      ),
    ).toBe(true);
    expect(
      violaDistincaoDeAutorizacao(
        'src/app/api/bling/pedidos/[id]/route.ts',
        '  resolveActor: resolveActorContext,',
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

  // A regra é sobre rotas. `src/lib/auth.ts` ainda **define** os seams, e é
  // onde eles morrem na fatia C — acusá-lo aqui só tornaria a guarda impossível
  // de satisfazer antes da hora.
  it('não alcança o módulo que define os seams', () => {
    expect(violaDistincaoDeAutorizacao('src/lib/auth.ts', importacao)).toBe(false);
    expect(violaDistincaoDeAutorizacao('src/services/sync.ts', importacao)).toBe(false);
  });
});
