import { supabaseServer } from '../lib/supabaseServer';
import type { VerifiedOrganizationScope } from '../lib/verifiedOrganizationScope';
import { registrarFalhaInterna } from '../lib/observability/falhaInterna';
import type { AuditarComercial } from './auditoriaComercial';

/** Um contato do Chatwoot já espelhado, com telefone normalizado. */
export interface ContatoDoSac {
  readonly nome: string | null;
  readonly email: string | null;
  readonly telefone: string | null;
  readonly telefoneNormalizado: string;
}

/**
 * Leitura e registro do vínculo SAC → ERP, sempre na organização verificada.
 *
 * `registrar` é o comando `registrar_cliente_do_sac` (migration 80): trava
 * consultiva por (organização, telefone), só insere, nunca sobrescreve.
 */
export interface RegistroDoSacPort {
  contatosComTelefone(scope: VerifiedOrganizationScope): Promise<readonly ContatoDoSac[]>;
  telefonesDeClientes(scope: VerifiedOrganizationScope): Promise<ReadonlySet<string>>;
  registrar(scope: VerifiedOrganizationScope, contato: ContatoDoSac): Promise<'criado' | 'ja_existia'>;
}

export interface ResultadoDoVinculoSac {
  readonly criados: number;
  readonly jaExistentes: number;
  readonly falhas: number;
}

/**
 * Cria no ERP, como cliente local, o contato do SAC cujo telefone ainda não
 * existe na organização.
 *
 * **Quem pode:** qualquer membro que sincroniza o SAC (`organization:access`).
 * O atendimento precisa disso, e o efeito é estreito: um cliente novo com
 * `bling_id` temporário, só com nome, e-mail e telefone do contato — nenhum
 * cliente existente é alterado, nada vai ao Bling. Restringir a quem
 * administra pararia a mensageria dos atendentes; uma capacidade própria do
 * SAC é decisão de produto (inventário, PRE-006C).
 *
 * **Concorrência:** a leitura dos telefones é só um filtro; a decisão é da
 * função do banco, sob trava. Duas sincronizações simultâneas criam o cliente
 * uma vez.
 */
export async function vincularSacAoErp(
  scope: VerifiedOrganizationScope,
  port: RegistroDoSacPort,
  auditar: AuditarComercial,
  correlationId: string,
): Promise<ResultadoDoVinculoSac> {
  const [contatos, telefones] = await Promise.all([port.contatosComTelefone(scope), port.telefonesDeClientes(scope)]);
  const vistos = new Set(telefones);
  let criados = 0;
  let jaExistentes = 0;
  let falhas = 0;

  for (const contato of contatos) {
    if (vistos.has(contato.telefoneNormalizado)) continue;
    vistos.add(contato.telefoneNormalizado);
    try {
      if ((await port.registrar(scope, contato)) === 'criado') criados += 1;
      else jaExistentes += 1;
    } catch (erro: unknown) {
      falhas += 1;
      registrarFalhaInterna('sac.registrar_cliente', erro, { organizacaoId: scope.organizationId, atorId: scope.actorId });
    }
  }

  if (criados > 0 || falhas > 0) {
    await auditar(scope, {
      acao: 'customer.sac_contacts_registered',
      recurso: 'clientes',
      recursoId: null,
      correlationId,
      metadata: { criados, ja_existentes: jaExistentes, falhas, desfecho: falhas > 0 ? 'parcial' : 'concluido' },
    });
  }
  return { criados, jaExistentes, falhas };
}

/** O adapter Supabase do vínculo: service role, com `organizacao_id` explícito em toda leitura. */
export const registroDoSacSupabase: RegistroDoSacPort = {
  async contatosComTelefone(scope) {
    const { data, error } = await supabaseServer
      .from('chatwoot_contacts')
      .select('name, email, phone_number, phone_normalizado')
      .eq('organizacao_id', scope.organizationId)
      .not('phone_normalizado', 'is', null);
    if (error) throw error;
    return (data ?? []).map((c) => ({
      nome: typeof c.name === 'string' ? c.name : null,
      email: typeof c.email === 'string' ? c.email : null,
      telefone: typeof c.phone_number === 'string' ? c.phone_number : null,
      telefoneNormalizado: String(c.phone_normalizado),
    }));
  },
  async telefonesDeClientes(scope) {
    const { data, error } = await supabaseServer
      .from('clientes')
      .select('telefone_normalizado')
      .eq('organizacao_id', scope.organizationId)
      .not('telefone_normalizado', 'is', null);
    if (error) throw error;
    return new Set((data ?? []).map((c) => String(c.telefone_normalizado)));
  },
  async registrar(scope, contato) {
    const { data, error } = await supabaseServer.rpc('registrar_cliente_do_sac', {
      p_organizacao_id: scope.organizationId,
      p_ator_id: scope.actorId,
      p_nome: contato.nome,
      p_email: contato.email,
      p_telefone: contato.telefone,
      p_telefone_normalizado: contato.telefoneNormalizado,
    });
    if (error) throw error;
    const linha = Array.isArray(data) ? data[0] : data;
    const desfecho = (linha as { desfecho?: unknown } | null)?.desfecho;
    if (desfecho === 'criado' || desfecho === 'ja_existia') return desfecho;
    throw new Error('registrar_cliente_do_sac devolveu um desfecho fora do contrato');
  },
};
