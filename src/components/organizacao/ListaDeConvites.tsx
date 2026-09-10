'use client';

import { Pilula } from '@/components/ui/StatusPill';
import { AvisoDeAtualizacaoFalhada, EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import type { Convite } from './types';

/**
 * A aparência de cada status de convite.
 *
 * As quatro palavras são os quatro valores que a coluna `status` de
 * `convites_organizacao` realmente aceita (migration 21) — nenhuma outra entra
 * aqui. `pending` é `--warning` porque é o único que ainda pede ação de
 * alguém: o código está com quem o criou, e precisa ser entregue.
 */
const APARENCIA: Record<Convite['status'], { readonly rotulo: string; readonly cor: string }> = {
  pending: { rotulo: 'Aguardando', cor: 'var(--warning)' },
  accepted: { rotulo: 'Aceito', cor: 'var(--accent)' },
  revoked: { rotulo: 'Revogado', cor: 'var(--danger)' },
  expired: { rotulo: 'Expirado', cor: 'var(--txt3)' },
};

const PAPEL: Record<Convite['papel'], string> = {
  admin: 'Administrador',
  member: 'Membro',
};

export interface ListaDeConvitesProps {
  /** Os convites da seleção atual, ou `null` se nenhuma leitura vale para ela. */
  convites: readonly Convite[] | null;
  carregando: boolean;
  erroDeLeitura: string | null;
  onRecarregar: () => void;
}

/**
 * Os convites da organização ativa, com o status de cada um.
 *
 * **Nenhum código aparece aqui, e isso é deliberado.** O token existe uma vez
 * só, no retorno da criação, e é lá que a tela o mostra. Listar convites não o
 * traz de volta — o servidor não o devolve na listagem, e persistir o que ele
 * devolveu para reexibir depois seria guardar uma credencial no navegador. Um
 * convite pendente cujo código se perdeu é resolvido criando outro.
 *
 * **Uma leitura que falhou não vira "nenhum convite".** Um convite pendente
 * que desaparece da lista é um convite que ninguém revoga e ninguém acompanha.
 */
export function ListaDeConvites({ convites, carregando, erroDeLeitura, onRecarregar }: ListaDeConvitesProps) {
  if (convites === null) {
    return carregando ? (
      <EstadoCarregando mensagem="Carregando os convites…" />
    ) : (
      <EstadoDeErro
        titulo="Não foi possível carregar os convites"
        detalhe={erroDeLeitura ?? undefined}
        onTentarDeNovo={onRecarregar}
      />
    );
  }

  if (convites.length === 0) {
    return (
      <EstadoVazio
        titulo="Nenhum convite criado"
        descricao="Crie um convite e entregue o código à pessoa pelo canal que preferir."
      />
    );
  }

  return (
    <div className="flex flex-col min-h-0" style={{ gap: 8 }}>
      {erroDeLeitura !== null && <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura} recurso="os convites" />}
      <ul className="flex flex-col overflow-y-auto min-h-0" style={{ gap: 8 }}>
        {convites.map((convite) => {
          const { rotulo, cor } = APARENCIA[convite.status];
          return (
            <li
              key={convite.id}
              className="flex items-center justify-between gap-3"
              style={{
                padding: '11px 14px',
                borderRadius: 16,
                background: 'var(--glass2)',
                border: '1px solid var(--line)',
              }}
            >
              <span className="flex flex-col min-w-0" style={{ gap: 3 }}>
                <span
                  className="truncate"
                  style={{ font: '500 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                >
                  {convite.email}
                </span>
                <span style={{ font: '400 10.5px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt3)' }}>
                  {PAPEL[convite.papel]}
                </span>
              </span>
              <Pilula rotulo={rotulo} cor={cor} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
