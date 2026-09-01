import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkModuleBoundaries,
  violaDistincaoDeAutorizacao,
  violaResolvedorLegado,
  violacoesDaLinha,
} from './check-module-boundaries.mjs';

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

// Ticket 22, fatia C — `resolveTenantOrgId` ficou de propósito, com zero
// chamadores de produção, mas ainda devolve o `userId` como organização quando
// não acha vínculo. A guarda impede que ela ganhe chamador novo enquanto existe.
describe('guarda do resolvedor de tenancy legado', () => {
  const chamada = '  const orgId = await resolveTenantOrgId(supabaseServer, tenant);';

  it('acusa um chamador novo em código de produção', () => {
    expect(violaResolvedorLegado('src/app/api/pedidos/manual/route.ts', chamada)).toBe(true);
    expect(violaResolvedorLegado('src/services/sync.ts', chamada)).toBe(true);
    expect(violaResolvedorLegado('src/repositories/produtoRepository.ts', chamada)).toBe(true);
  });

  it('não acusa o arquivo que define a função', () => {
    expect(violaResolvedorLegado('src/lib/organizationContext.ts', chamada)).toBe(false);
    expect(
      violaResolvedorLegado('src/lib/organizationContext.ts', 'export async function resolveTenantOrgId('),
    ).toBe(false);
  });

  it('não acusa linha que não menciona a função', () => {
    expect(
      violaResolvedorLegado('src/services/sync.ts', '  const escopo = await resolveVerifiedOrganizationScope(request);'),
    ).toBe(false);
  });
});

// A regra existir não é a regra rodar. `violaResolvedorLegado` já vinha
// exportada e provada linha a linha, mas `checkModuleBoundaries` não a chamava —
// então o portão passava por cima de um chamador novo sem dizer nada, enquanto
// três documentos afirmavam que ele guardava. É a família 1 desta série:
// fronteira testada de um lado só. Este teste exercita a **ligação**, não o
// predicado: ele roda o verificador de verdade sobre um arquivo que viola.
describe('as quatro regras estão ligadas ao agregador', () => {
  // Cada linha aqui viola exatamente uma regra. Se alguém acrescentar uma regra
  // e esquecer de ligá-la, o caso dela nasce faltando nesta tabela — que é o
  // ponto: a omissão fica visível, em vez de virar guarda silenciosa.
  const casos: ReadonlyArray<readonly [string, string, string]> = [
    ['domain-isolation', 'src/services/sync.ts', "import { NextResponse } from 'next/server';"],
    ['layer-inversion', 'src/repositories/produtoRepository.ts', "import { sync } from '@/services/sync';"],
    ['authorization-distinction', 'src/app/api/nfe/route.ts', "import { verifySessionAndRole } from '@/lib/auth';"],
    ['tenancy-legacy-resolver', 'src/services/sync.ts', '  const orgId = await resolveTenantOrgId(db, userId);'],
  ];

  it.each(casos)('aplica a regra `%s`', (regra, arquivo, linha) => {
    expect(violacoesDaLinha(arquivo, linha).map((v: { rule: string }) => v.rule)).toContain(regra);
  });

  it('não acusa uma linha que não viola nada', () => {
    expect(violacoesDaLinha('src/services/sync.ts', "import { z } from 'zod';")).toEqual([]);
  });
});

describe('a guarda do resolvedor legado está ligada ao verificador', () => {
  it('reporta `tenancy-legacy-resolver` ao varrer um chamador de produção', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-boundaries-'));
    try {
      fs.writeFileSync(
        path.join(base, 'chamadorNovo.ts'),
        'const orgId = await resolveTenantOrgId(supabaseServer, userId);',
        'utf8',
      );

      const resultado = checkModuleBoundaries(base);

      expect(resultado.valid).toBe(false);
      expect(resultado.violations.map((v) => v.rule)).toContain('tenancy-legacy-resolver');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('não reporta nada quando o arquivo varrido não chama a função', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-boundaries-'));
    try {
      fs.writeFileSync(
        path.join(base, 'fronteiraCerta.ts'),
        'const escopo = await resolveVerifiedOrganizationScope(request);',
        'utf8',
      );

      expect(checkModuleBoundaries(base)).toEqual({ valid: true, violations: [] });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
