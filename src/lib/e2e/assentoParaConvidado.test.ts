/**
 * Ticket 23 — o seed precisa deixar **uma vaga** para o convidado da spec.
 *
 * `organization.spec.ts` cria um convite e o aceita. Ela falhava antes do
 * aceite, com `403 LIMIT_EXCEEDED`, e a recusa estava **certa**: o seed dava a
 * `org-a` exatamente três membros, e o limite do plano Starter é três. Não é
 * defeito de autorização nem de entitlement — é colisão entre o tamanho do
 * fixture e o limite do plano.
 *
 * Este arquivo amarra as duas pontas que colidiram, e nenhuma delas é copiada
 * para cá:
 *
 * - a **contagem de membros** vem de `buildSeedManifest`, o próprio plano do
 *   seed;
 * - o **limite do plano** vem de `database/33_planos_limites_entitlements.sql`,
 *   que é onde o Starter é definido.
 *
 * Copiar qualquer um dos dois faria o teste concordar consigo mesmo enquanto o
 * ambiente diverge — e foi assim que a spec passou meses sem rodar.
 *
 * A decisão do entitlement é tomada por `evaluateEntitlementPolicy`, a função de
 * verdade. O que se prova aqui é que, com o seed que existe, o convite da spec
 * **cabe**.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildSeedManifest,
  ORGANIZACAO_DO_CONVITE,
  PERSONA_CONVIDADA,
} from './syntheticSeedData';
import {
  evaluateEntitlementPolicy,
  type EntitlementOperation,
} from '@/domain/entitlements/entitlementPolicy';

const SQL_DOS_PLANOS = path.resolve(__dirname, '../../../database/33_planos_limites_entitlements.sql');

/**
 * O `limite_membros` do plano Starter, lido do SQL que o semeia.
 *
 * O Starter é o plano que uma organização nova recebe — e o `entitlements` do
 * banco cai nele por padrão quando não há assinatura. É contra ele que a spec
 * esbarra.
 */
export function limiteDeMembrosDoStarter(sql: string): number {
  const linha = /\(\s*'Starter'\s*,\s*'starter'\s*,\s*(\d+)\s*,/u.exec(sql);
  if (!linha) {
    throw new Error(
      'Não achei a linha do plano Starter em 33_planos_limites_entitlements.sql. '
        + 'Se o seed dos planos mudou de forma, este teste precisa acompanhar — e não adivinhar.',
    );
  }
  return Number(linha[1]);
}

/** Quantos membros o seed cria numa organização. */
export function membrosSemeadosEm(organizationKey: string): number {
  return buildSeedManifest({ runId: 'fixo-para-teste' }).personas.filter(
    (persona) => persona.organizationKey === organizationKey,
  ).length;
}

const CONVIDAR_MEMBRO: EntitlementOperation = {
  category: 'resource_mutation',
  name: 'convidar_membro',
  limitedResource: 'membros',
};

function decisaoDoConvite(membros: number, limite: number) {
  return evaluateEntitlementPolicy(
    { kind: 'active', since: '2026-09-01T00:00:00Z' },
    CONVIDAR_MEMBRO,
    {
      limite_membros: limite,
      limite_conexoes_bling: 1,
      limite_conexoes_chatwoot: 1,
      recursos: {},
    },
    { membros, conexoes_bling: 0, conexoes_chatwoot: 0 },
  );
}

describe('o seed deixa vaga para o convidado da spec de organização', () => {
  it('a organização do convite existe e tem exatamente o dono como membro', () => {
    const manifesto = buildSeedManifest({ runId: 'fixo-para-teste' });

    expect(manifesto.organizations.map((o) => o.key)).toContain(ORGANIZACAO_DO_CONVITE);
    // Exatamente um: se o dono sumir, o convite não tem quem o crie; se entrar
    // mais gente, a vaga que a spec precisa começa a encolher. As duas coisas
    // quebram a spec, e nenhuma delas apareceria numa asserção só de "cabe".
    expect(membrosSemeadosEm(ORGANIZACAO_DO_CONVITE)).toBe(1);
  });

  it('a organização que a spec convida cabe mais um membro, no limite real do Starter', () => {
    const limite = limiteDeMembrosDoStarter(fs.readFileSync(SQL_DOS_PLANOS, 'utf8'));
    const membros = membrosSemeadosEm(ORGANIZACAO_DO_CONVITE);

    // É esta a asserção que estava vermelha antes do ticket 23: 3 membros
    // semeados contra um limite de 3, e o convite recusado antes do aceite.
    expect(decisaoDoConvite(membros, limite)).toEqual({ allowed: true });
  });

  // O outro lado, e ele importa tanto quanto: o limite continua valendo. Uma
  // correção que afrouxasse o entitlement apagaria a garantia que ele existe
  // para dar, e este caso ficaria verde do mesmo jeito sem ele.
  it('o limite continua recusando quando a organização está cheia', () => {
    const limite = limiteDeMembrosDoStarter(fs.readFileSync(SQL_DOS_PLANOS, 'utf8'));

    expect(decisaoDoConvite(limite, limite)).toEqual({
      allowed: false,
      code: 'LIMIT_EXCEEDED',
      reason: `Limite de "membros" atingido (${limite}/${limite}).`,
    });
  });

  it('o convidado dedicado não tem vínculo nenhum no seed', () => {
    const convidado = buildSeedManifest({ runId: 'fixo-para-teste' }).personas.find(
      (persona) => persona.key === PERSONA_CONVIDADA,
    );

    expect(convidado).toBeDefined();
    // Sem vínculo é o ponto: convidar quem já é membro cria um convite que
    // ninguém precisa aceitar para virar membro, e a spec passaria sem provar
    // o aceite.
    expect(convidado!.organizationKey).toBeNull();
  });

  // `member-a` continua existindo e continua em `org-a`: a correção não pode
  // ser reaproveitá-lo como convidado.
  it('`member-a` segue sendo membro de `org-a`, e não vira o convidado', () => {
    const personas = buildSeedManifest({ runId: 'fixo-para-teste' }).personas;
    const memberA = personas.find((persona) => persona.key === 'member-a');

    expect(memberA?.organizationKey).toBe('org-a');
  });

  it('a matriz de papéis de `org-a` continua inteira', () => {
    const personas = buildSeedManifest({ runId: 'fixo-para-teste' }).personas;
    const papeisEmOrgA = personas
      .filter((persona) => persona.organizationKey === 'org-a')
      .map((persona) => persona.role)
      .sort();

    expect(papeisEmOrgA).toEqual(['admin', 'member', 'owner']);
  });
});
