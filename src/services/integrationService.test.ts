import { describe, expect, it, vi } from 'vitest';

import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import type { EventoComercial } from './auditoriaComercial';
import { vincularSacAoErp, type ContatoDoSac, type RegistroDoSacPort } from './integrationService';

// O adapter Supabase do módulo não é exercitado aqui; o comando real é provado
// em pgTAP (`registrar_cliente_do_sac`).
vi.mock('../lib/supabaseServer', () => ({ supabaseServer: {} }));

const ORG = '11111111-1111-4111-8111-111111111111';
const ATENDENTE = '44444444-4444-4444-8444-444444444444';
/** SAFETY: o escopo é entrada do teste; um `member` que sincroniza o SAC. */
const scope = { organizationId: ORG, actorId: ATENDENTE, role: 'member' } as unknown as VerifiedOrganizationScope;

const contato = (telefone: string, nome = 'Contato'): ContatoDoSac => ({
  nome, email: 'contato@exemplo.com', telefone, telefoneNormalizado: telefone,
});

function montar(contatos: ContatoDoSac[], existentes: string[], falharEm?: string) {
  const registrados: string[] = [];
  const eventos: EventoComercial[] = [];
  const port: RegistroDoSacPort = {
    async contatosComTelefone(s) { expect(s.organizationId).toBe(ORG); return contatos; },
    async telefonesDeClientes() { return new Set(existentes); },
    async registrar(s, c) {
      expect(s).toBe(scope);
      if (c.telefoneNormalizado === falharEm) throw Object.assign(new Error('x'), { code: '40001' });
      registrados.push(c.telefoneNormalizado);
      return 'criado';
    },
  };
  return { port, registrados, eventos, auditar: async (_s: VerifiedOrganizationScope, e: EventoComercial) => { eventos.push(e); } };
}

describe('vínculo SAC → ERP (PRE-006C)', () => {
  it('membro do SAC cria só os telefones novos, uma vez cada, e a trilha tem só contagens', async () => {
    const m = montar([contato('+5548999990001', 'Ana'), contato('+5548999990002'), contato('+5548999990002')], ['+5548999990001']);

    const r = await vincularSacAoErp(scope, m.port, m.auditar, 'corr_sac');

    expect(r).toEqual({ criados: 1, jaExistentes: 0, falhas: 0 });
    expect(m.registrados).toEqual(['+5548999990002']);
    expect(m.eventos).toEqual([{
      acao: 'customer.sac_contacts_registered', recurso: 'clientes', recursoId: null, correlationId: 'corr_sac',
      metadata: { criados: 1, ja_existentes: 0, falhas: 0, desfecho: 'concluido' },
    }]);
    expect(JSON.stringify(m.eventos)).not.toMatch(/\+55|Ana|exemplo\.com/u);
  });

  it('falha de um registro é parcial: os demais seguem e o evento diz quantos falharam', async () => {
    const m = montar([contato('+551'), contato('+552')], [], '+551');

    const r = await vincularSacAoErp(scope, m.port, m.auditar, 'corr_sac');

    expect(r).toEqual({ criados: 1, jaExistentes: 0, falhas: 1 });
    expect(m.eventos[0]!.metadata).toMatchObject({ criados: 1, falhas: 1, desfecho: 'parcial' });
  });

  it('nada novo: nenhum registro e nenhum evento a cada sincronização', async () => {
    const m = montar([contato('+551')], ['+551']);

    await vincularSacAoErp(scope, m.port, m.auditar, 'corr_sac');

    expect(m.registrados).toEqual([]);
    expect(m.eventos).toEqual([]);
  });
});
