'use client';

import { Check } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import { AvisoDeAtualizacaoFalhada, EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import type { Organizacao } from './types';

export interface OrganizationListProps {
  /** As organizações da leitura que vale na sessão atual; vazia enquanto não houver uma. */
  organizacoes: readonly Organizacao[];
  activeOrgId: string | null;
  switchingOrgId: string | null;
  /**
   * Por que a troca esta suspensa agora, ou `null` quando ela esta liberada.
   *
   * Existe por causa do token de convite, que volta uma vez so e nao pode ser
   * recuperado: trocar de organizacao com uma criacao em voo, ou com o codigo
   * ainda na tela, ou perde o token ou o mostra ao lado do tenant errado. A
   * frase e mostrada a quem tentar, porque um botao desabilitado sem motivo e
   * a tela recusando sem dizer o que houve.
   */
  motivoParaNaoTrocar: string | null;
  carregando: boolean;
  erroDeLeitura: string | null;
  onSwitch: (orgId: string) => void;
  onRecarregar: () => void;
}

/**
 * As organizações do usuário, com a ativa marcada e a troca pelo CAS.
 *
 * A troca não acontece aqui: o clique chama quem sabe comparar a versão e
 * conversar com o servidor. Esta lista só diz qual é a ativa — e, quando a
 * leitura falha, diz que falhou. Uma tela que respondesse "você não tem
 * organização" a quem é owner de duas é o pior erro possível no eixo
 * multi-tenant, e é exatamente o que uma lista vazia significaria aqui.
 */
export function OrganizationList({
  organizacoes,
  activeOrgId,
  switchingOrgId,
  motivoParaNaoTrocar,
  carregando,
  erroDeLeitura,
  onSwitch,
  onRecarregar,
}: OrganizationListProps) {
  // As cinco leituras possíveis, na ordem em que a verdade importa: uma falha
  // sem lista boa NUNCA pode ser apresentada como "você não tem organização".
  if (carregando) return <EstadoCarregando mensagem="Carregando as suas organizações…" />;

  if (organizacoes.length === 0) {
    return erroDeLeitura !== null ? (
      <EstadoDeErro
        titulo="Não foi possível carregar as suas organizações"
        detalhe={erroDeLeitura}
        onTentarDeNovo={onRecarregar}
      />
    ) : (
      <EstadoVazio
        titulo="Nenhuma organização ainda"
        descricao="Crie a sua primeira organização para começar, ou aceite um convite que tenham enviado a você."
      />
    );
  }

  return (
    <div className="flex flex-col min-h-0" style={{ gap: 8 }}>
      {erroDeLeitura !== null && (
        <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura} recurso="as suas organizações" />
      )}
      {motivoParaNaoTrocar !== null && (
        <p
          className="px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--warning)' }}
        >
          {motivoParaNaoTrocar}
        </p>
      )}
      <ul className="flex flex-col overflow-y-auto min-h-0" style={{ gap: 8 }}>
        {organizacoes.map((org) => {
          const ativa = activeOrgId === org.id;
          const trocando = switchingOrgId === org.id;
          return (
            <li
              key={org.id}
              className="flex items-center justify-between gap-3"
              style={{
                padding: '11px 14px',
                borderRadius: 16,
                background: ativa ? 'var(--chip)' : 'var(--glass2)',
                border: `1px solid ${ativa ? 'var(--accent)' : 'var(--line)'}`,
              }}
            >
              <span className="flex flex-col min-w-0" style={{ gap: 3 }}>
                <span
                  className="truncate"
                  style={{ font: '600 13.5px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                >
                  {org.nome}
                </span>
                <span
                  className="truncate"
                  style={{ font: '400 10.5px/1.2 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}
                >
                  {org.slug}
                </span>
              </span>

              {ativa ? (
                <Pilula rotulo="Ativa" cor="var(--accent)" />
              ) : (
                <button
                  type="button"
                  onClick={() => onSwitch(org.id)}
                  disabled={switchingOrgId !== null || motivoParaNaoTrocar !== null}
                  title={motivoParaNaoTrocar ?? undefined}
                  className="orbita-chip cursor-pointer shrink-0"
                >
                  {trocando ? 'Trocando…' : <><Check className="w-3.5 h-3.5" /> Tornar ativa</>}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
