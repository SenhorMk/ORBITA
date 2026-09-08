'use client';

import { useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';

import type { ActiveOrg, Organizacao } from '@/components/organizacao/types';

interface OrganizacaoAtivaProps {
  organizacoes: Organizacao[];
  ativa: ActiveOrg | null;
  carregando: boolean;
  /** Id da organização cuja troca está em curso, ou `null`. */
  trocandoParaId: string | null;
  /**
   * Troca a organização ativa. É **o mesmo** `handleSwitchOrganization` do
   * fluxo de organizações — a rota com o contrato CAS
   * (`organizacao_id` + `expected_version`). O shell não tem caminho próprio
   * para isto e não deve ganhar um.
   */
  onTrocar: (organizacaoId: string) => void | Promise<void>;
}

/**
 * A organização ativa, visível em qualquer aba.
 *
 * Antes do Ticket 01 o tenant só aparecia entrando na aba "Organização". Num
 * produto multi-tenant, não saber a que empresa os números na tela pertencem é
 * um defeito, não uma economia de espaço.
 *
 * Com uma única organização não há seletor: mostrar um menu de um item só é
 * ruído. O seletor aparece quando existe de fato para onde trocar.
 */
export function OrganizacaoAtiva({
  organizacoes,
  ativa,
  carregando,
  trocandoParaId,
  onTrocar,
}: OrganizacaoAtivaProps) {
  const [aberto, setAberto] = useState(false);

  if (carregando && ativa === null) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl px-3 py-1.5" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}>
        <Building2 className="w-3.5 h-3.5" style={{ color: 'var(--txt3)' }} aria-hidden />
        <span className="text-xs font-semibold" style={{ color: 'var(--txt3)' }}>Carregando organização…</span>
      </div>
    );
  }

  if (ativa === null) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl px-3 py-1.5" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}>
        <Building2 className="w-3.5 h-3.5" style={{ color: 'var(--txt3)' }} aria-hidden />
        <span className="text-xs font-semibold" style={{ color: 'var(--txt3)' }}>Sem organização ativa</span>
      </div>
    );
  }

  const conteudo = (
    <>
      <Building2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--txt3)' }} aria-hidden />
      <span className="flex flex-col items-start leading-tight">
        <span className="orbita-eyebrow">Organização</span>
        <span className="text-xs font-bold" style={{ color: 'var(--txt)' }}>{ativa.organizacao.nome}</span>
      </span>
    </>
  );

  const podeTrocar = organizacoes.length > 1;

  if (!podeTrocar) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl px-3 py-1.5" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}>
        {conteudo}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAberto((estava) => !estava)}
        aria-expanded={aberto}
        aria-label={`Organização ativa: ${ativa.organizacao.nome}. Trocar de organização`}
        className="flex items-center gap-2.5 rounded-xl px-3 py-1.5 cursor-pointer"
        style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}
      >
        {conteudo}
        <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--txt3)' }} aria-hidden />
      </button>

      {aberto && (
        <>
          <button
            type="button"
            aria-label="Fechar seletor de organização"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setAberto(false)}
          />
          <ul
            aria-label="Organizações"
            className="absolute left-0 top-full mt-2 z-50 min-w-[260px] list-none p-1.5 rounded-2xl"
            style={{ background: 'var(--modal)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-modal)' }}
          >
            {organizacoes.map((org) => {
              const eAtiva = org.id === ativa.organizacao.id;
              const trocando = trocandoParaId === org.id;
              return (
                <li key={org.id}>
                  <button
                    type="button"
                    aria-current={eAtiva ? 'true' : undefined}
                    // Trocar para a organização já ativa não tem efeito nenhum e
                    // gastaria uma versão de seleção à toa.
                    disabled={eAtiva || trocandoParaId !== null}
                    onClick={() => {
                      setAberto(false);
                      void onTrocar(org.id);
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-left text-xs font-semibold disabled:cursor-default"
                    style={{ color: eAtiva ? 'var(--txt)' : 'var(--txt2)' }}
                  >
                    <span className="truncate">{org.nome}</span>
                    {eAtiva && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />}
                    {trocando && <span className="orbita-eyebrow shrink-0">trocando…</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
