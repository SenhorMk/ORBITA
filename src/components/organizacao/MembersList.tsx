'use client';

import { Trash2 } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import { AvisoDeAtualizacaoFalhada, EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import { rotuloDoMembro } from '@/lib/organizacao/identidadeDoMembro';
import type { MembroOrganizacao } from './types';
import { HelpInfo } from '@/components/help/HelpInfo';

/**
 * Como o membro é chamado nesta lista.
 *
 * A tela imprimia `user_id`. Numa lista de autoridade — quem participa, e com
 * qual poder — um UUID não deixa ninguém conferir se está removendo a pessoa
 * certa; e é a primeira coisa que se lê ao lado de um botão de remover.
 *
 * `rotuloDoMembro` mora ao lado da política que decidiu o nome, então "sem nome
 * cadastrado" e "identidade indisponível" chegam aqui já separados — a tela não
 * reinventa a distinção nem a perde.
 *
 * Uma resposta de um servidor que ainda não devolva esses campos não traz campo
 * nenhum: aí `origem_do_nome` é `undefined` e o recurso cai em "sem nome
 * cadastrado", que continua sendo verdade e continua sendo legível.
 */
function comoChamar(membro: MembroOrganizacao): string {
  return rotuloDoMembro({
    nome_exibicao: membro.nome_exibicao ?? null,
    origem_do_nome: membro.origem_do_nome ?? 'ausente',
  });
}

/** A cor de cada papel. Owner é o único que a tela nunca oferece para remover. */
const COR_DO_PAPEL: Record<MembroOrganizacao['papel'], string> = {
  owner: 'var(--accent)',
  admin: 'var(--info)',
  member: 'var(--txt2)',
};

const ROTULO_DO_PAPEL: Record<MembroOrganizacao['papel'], string> = {
  owner: 'Dono',
  admin: 'Administrador',
  member: 'Membro',
};

export interface MembersListProps {
  /** Os membros da seleção atual, ou `null` se nenhuma leitura vale para ela. */
  membros: readonly MembroOrganizacao[] | null;
  carregando: boolean;
  erroDeLeitura: string | null;
  erroDeAcao: string | null;
  canManage: boolean;
  onRemove: (userId: string) => Promise<void>;
  onRecarregar: () => void;
}

/**
 * Os membros da organização ativa, e a remoção para quem pode administrar.
 *
 * O owner nunca aparece removível, e o servidor também recusaria — a tela não
 * é a última palavra sobre autorização, só sobre o que ela mostra.
 *
 * **A falha de leitura não vira "nenhum membro".** Numa tela de autoridade a
 * confusão entre zero e "não sei" é pior que um erro: um membro que desaparece
 * da lista sugere que uma revogação já aconteceu. Enquanto nenhuma leitura vale
 * para a seleção atual não existe lista para mostrar — nem a da organização
 * anterior, que é o mesmo dado sob o contexto errado.
 */
export function MembersList({
  membros,
  carregando,
  erroDeLeitura,
  erroDeAcao,
  canManage,
  onRemove,
  onRecarregar,
}: MembersListProps) {
  return (
    <div className="flex flex-col min-h-0" style={{ gap: 8 }} data-testid="members-list">
      <HelpInfo ajudaId="org.membros" />
      <HelpInfo ajudaId="org.papeis-detalhados" />
      {erroDeAcao !== null && (
        <p
          role="alert"
          className="px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--danger)' }}
        >
          {erroDeAcao}
        </p>
      )}

      {membros !== null && erroDeLeitura !== null && (
        <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura} recurso="os membros" />
      )}

      {membros === null && carregando && <EstadoCarregando mensagem="Carregando os membros…" />}

      {membros === null && !carregando && (
        <EstadoDeErro
          titulo="Não foi possível carregar os membros"
          detalhe={erroDeLeitura ?? undefined}
          onTentarDeNovo={onRecarregar}
        />
      )}

      {membros !== null && membros.length === 0 && (
        <EstadoVazio
          titulo="Nenhum membro nesta organização"
          descricao="Crie um convite para trazer alguém — o código é entregue por você, no canal que preferir."
        />
      )}

      {membros !== null && membros.length > 0 && (
        <ul className="flex flex-col overflow-y-auto min-h-0" style={{ gap: 8 }}>
          {membros.map((membro) => (
            <li
              key={membro.user_id}
              className="flex items-center justify-between gap-3"
              style={{
                padding: '11px 14px',
                borderRadius: 16,
                background: 'var(--glass2)',
                border: '1px solid var(--line)',
              }}
            >
              <span className="flex flex-col min-w-0" style={{ gap: 4 }}>
                <span
                  className="truncate"
                  style={{
                    font: '500 13px/1.2 var(--font-archivo), sans-serif',
                    color: membro.nome_exibicao ? 'var(--txt)' : 'var(--txt3)',
                  }}
                >
                  {comoChamar(membro)}
                </span>
                <span style={{ font: '400 10.5px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt3)' }}>
                  desde {new Date(membro.created_at).toLocaleDateString('pt-BR')}
                </span>
              </span>

              <span className="flex items-center shrink-0" style={{ gap: 8 }}>
                <Pilula rotulo={ROTULO_DO_PAPEL[membro.papel]} cor={COR_DO_PAPEL[membro.papel]} />
                {canManage && membro.papel !== 'owner' && (
                  <button
                    type="button"
                    aria-label={`Remover ${comoChamar(membro)}`}
                    onClick={() => { void onRemove(membro.user_id); }}
                    className="w-8 h-8 rounded-xl flex items-center justify-center cursor-pointer"
                    style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--danger)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden />
                    <span className="sr-only">Remover</span>
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
