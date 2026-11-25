import type { ReactNode } from 'react';
import { Bot, Cog } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import type { PapelMembro } from '@/lib/organizationContext';
import { rotuloDoMembro } from '@/lib/organizacao/identidadeDoMembro';
import type { Atividade, AutorDaAtividade } from '@/lib/auditoria/historicoDeAtividades';
import {
  dataEHoraDaAtividade,
  horaDaAtividade,
  iniciais,
  tituloDaAtividade,
} from '@/lib/auditoria/apresentacaoDoHistorico';

const PAPEL: Record<PapelMembro, string> = { owner: 'Dono', admin: 'Administrador', member: 'Membro' };
const MONO = '400 11px/1.5 var(--font-jetbrains-mono), monospace';

function Avatar({ autor }: { readonly autor: AutorDaAtividade }) {
  const base = {
    width: 34, height: 34, borderRadius: 12, border: '1px solid var(--line)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
  } as const;
  if (autor.tipo === 'bot') {
    return <span aria-hidden style={{ ...base, background: 'var(--chip)', color: 'var(--warning)' }}><Bot className="w-4 h-4" /></span>;
  }
  if (autor.tipo === 'sistema') {
    return <span aria-hidden style={{ ...base, background: 'var(--chip)', color: 'var(--txt3)' }}><Cog className="w-4 h-4" /></span>;
  }
  return (
    <span aria-hidden style={{ ...base, background: 'var(--chip)', color: 'var(--txt)', font: '600 12px/1 var(--font-archivo), sans-serif' }}>
      {iniciais(autor.nome_exibicao)}
    </span>
  );
}

/** "Maria Silva · Administrador", "Bot de atendimento (IA)" ou "Sistema automático". */
function QuemFez({ autor, viaAssistente }: { readonly autor: AutorDaAtividade; readonly viaAssistente: boolean }) {
  const texto = { color: 'var(--txt2)' };
  if (autor.tipo === 'bot') return <span style={texto}>Bot de atendimento (IA)</span>;
  if (autor.tipo === 'sistema') return <span style={texto}>Sistema automático</span>;
  return (
    <span className="flex items-center flex-wrap" style={{ gap: 6 }}>
      <span style={{ color: 'var(--txt)', fontWeight: 600 }}>{rotuloDoMembro(autor)}</span>
      <span aria-hidden style={{ color: 'var(--txt3)' }}>·</span>
      {autor.papel
        ? <span style={texto}>{PAPEL[autor.papel]}</span>
        : <span style={{ color: 'var(--danger)' }}>Não é mais membro</span>}
      {viaAssistente && <Pilula rotulo="via assistente" cor="var(--info)" />}
    </span>
  );
}

function Detalhe({ rotulo, children }: { readonly rotulo: string; readonly children: ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--txt3)' }}>{rotulo}</dt>
      <dd className="m-0 min-w-0 break-all" style={{ color: 'var(--txt2)' }}>{children}</dd>
    </>
  );
}

/**
 * Uma ação do histórico: quem fez, o quê e quando, com o rastro técnico
 * (código, registro, requisição, ID do usuário) recolhido em "Detalhes".
 */
export function LinhaDoHistorico({ atividade }: { readonly atividade: Atividade }) {
  const { autor } = atividade;
  return (
    <li className="flex" style={{ gap: 12, padding: '12px 4px', borderTop: '1px solid var(--line)' }}>
      <Avatar autor={autor} />
      <div className="flex flex-col flex-1 min-w-0" style={{ gap: 4 }}>
        <div className="flex items-start justify-between" style={{ gap: 12 }}>
          <span className="flex items-center flex-wrap" style={{ gap: 8, font: '600 13.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--txt)' }}>
            {tituloDaAtividade(atividade.acao, autor, atividade.descricao)}
            {atividade.gravidade === 'critical' && <Pilula rotulo="Precisa de conferência" cor="var(--danger)" />}
            {atividade.gravidade === 'warning' && <Pilula rotulo="Atenção" cor="var(--warning)" />}
          </span>
          <time dateTime={atividade.createdAt} title={dataEHoraDaAtividade(atividade.createdAt)}
            className="flex-none" style={{ font: MONO, color: 'var(--txt3)' }}>
            {horaDaAtividade(atividade.createdAt)}
          </time>
        </div>
        <div className="text-xs"><QuemFez autor={autor} viaAssistente={atividade.viaAssistente} /></div>
        <details className="text-xs">
          <summary className="cursor-pointer w-fit" style={{ color: 'var(--txt3)' }}>Detalhes</summary>
          <dl className="grid m-0" style={{ gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', marginTop: 8, font: MONO }}>
            <Detalhe rotulo="O que houve">{atividade.descricao}</Detalhe>
            <Detalhe rotulo="Quando">{dataEHoraDaAtividade(atividade.createdAt)}</Detalhe>
            <Detalhe rotulo="Ação">{atividade.acao}</Detalhe>
            <Detalhe rotulo="Registro">{atividade.recurso}{atividade.recursoId ? ` ${atividade.recursoId}` : ''}</Detalhe>
            {atividade.correlationId && <Detalhe rotulo="Requisição">{atividade.correlationId}</Detalhe>}
            {autor.tipo === 'pessoa' && <Detalhe rotulo="Usuário">{autor.userId}</Detalhe>}
          </dl>
        </details>
      </div>
    </li>
  );
}
