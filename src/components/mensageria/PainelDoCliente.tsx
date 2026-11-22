'use client';

import { useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { PedidoDoCliente } from '@/lib/integrations/contratoDaVerificacao';
import { Aviso } from './Aviso';
import { RetratoDoPedido } from './RetratoDoPedido';
import { useVerificacao } from './useVerificacao';
import { HelpInfo } from '@/components/help/HelpInfo';
import { formatarDataDoPedido } from '@/lib/dataDoPedido';

const CHIP = { height: 28, fontSize: 11 } as const;
const NOTA = { fontSize: 11, color: 'var(--txt3)' } as const;
const TEXTO = { fontSize: 12, color: 'var(--txt)' } as const;

const ROTULO_SEM_CLIENTE = { sem_prova: 'Não confirmado', expirada: 'Confirmação vencida' } as const;

function Pedidos({ titulo, pedidos, onDetalhes }: {
  readonly titulo: string;
  readonly pedidos: readonly PedidoDoCliente[];
  readonly onDetalhes: (pedidoId: string) => void;
}) {
  if (pedidos.length === 0) return <span style={NOTA}>{titulo}: nenhum pedido.</span>;
  return (
    <ul aria-label={titulo} className="flex flex-col" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
      {pedidos.map((pedido) => (
        <li key={pedido.id} className="flex items-center flex-wrap" style={{ gap: 8, ...TEXTO }}>
          <span>{pedido.numero === null ? 'Pedido sem número' : `Pedido ${pedido.numero}`}</span>
          <span style={NOTA}>
            {formatarDataDoPedido(pedido.data, true)} · {pedido.status} · {pedido.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          </span>
          <button type="button" onClick={() => onDetalhes(pedido.id)} className="orbita-chip cursor-pointer" style={CHIP}
            aria-label={`Detalhes do pedido ${pedido.numero ?? 'sem número'}`}>
            Detalhes
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Quem é a pessoa desta conversa (MSG-010). Um cliente com o mesmo telefone é
 * só candidato: os pedidos aparecem depois que o atendente confirma, com a
 * pessoa, quem ela é. A confirmação vale por tempo limitado e pode ser
 * desfeita. Os botões só pedem: o servidor decide e guarda a prova.
 */
export function PainelDoCliente({
  fetchWithAuth,
  conversaId,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly conversaId: string | null;
}) {
  const v = useVerificacao(fetchWithAuth, conversaId);
  const [numero, setNumero] = useState('');
  // O pedido aberto leva a conversa de onde veio: trocar de conversa fecha os detalhes.
  const [aberto, setAberto] = useState<{ readonly conversa: string; readonly pedido: string } | null>(null);
  const pedidoAberto = aberto !== null && aberto.conversa === conversaId ? aberto.pedido : null;
  const abrir = (pedido: string) => {
    if (conversaId !== null) setAberto({ conversa: conversaId, pedido });
  };
  const confirmado = v.verificacao?.estado === 'verificado' ? v.verificacao : null;

  return (
    <div className="flex flex-col flex-none" style={{ gap: 8, padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
      <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
        <span className="orbita-eyebrow" style={{ color: 'var(--txt3)' }}>Cliente</span>
        <HelpInfo ajudaId="sac.cliente" />
        <output aria-label="Cliente da conversa" style={TEXTO}>
          {v.verificacao === null
            ? (v.carregando ? 'Lendo…' : '—')
            : confirmado?.cliente?.nome ?? ROTULO_SEM_CLIENTE[v.verificacao.estado === 'expirada' ? 'expirada' : 'sem_prova']}
        </output>
        {confirmado !== null && (
          <>
            {confirmado.expiraEm !== null && (
              <span style={NOTA}>confirmado até {new Date(confirmado.expiraEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
            )}
            <button type="button" disabled={v.agindo} onClick={() => void v.revogar()} className="orbita-chip cursor-pointer" style={CHIP}>
              Desfazer confirmação
            </button>
          </>
        )}
      </div>

      {v.verificacao !== null && confirmado === null && (
        <>
          <span style={NOTA}>
            Telefone igual não confirma quem está escrevendo. Confirme com a pessoa antes de escolher; os pedidos só aparecem depois.
          </span>
          {v.candidatos.length === 0 && <span style={TEXTO}>Nenhum cliente cadastrado com o telefone deste contato.</span>}
          {v.candidatos.length > 1 && (
            <Aviso tom="atencao">Mais de um cliente usa este telefone. Pergunte à pessoa quem ela é antes de confirmar.</Aviso>
          )}
          {v.candidatos.map((candidato) => (
            <div key={candidato.clienteId} className="flex items-center flex-wrap" style={{ gap: 8 }}>
              <span style={TEXTO}>{candidato.nome}</span>
              {candidato.documentoFinal !== null && <span style={NOTA}>documento final {candidato.documentoFinal}</span>}
              <button type="button" disabled={v.agindo} aria-label={`Confirmar ${candidato.nome}`}
                onClick={() => void v.confirmar(candidato.clienteId)} className="orbita-chip cursor-pointer" style={CHIP}>
                Confirmar que é esta pessoa
              </button>
            </div>
          ))}
        </>
      )}

      {confirmado !== null && v.pedidos !== null && (
        <>
          <Pedidos titulo="Pedidos recentes" pedidos={v.pedidos} onDetalhes={abrir} />
          {pedidoAberto !== null && conversaId !== null && (
            <RetratoDoPedido fetchWithAuth={fetchWithAuth} conversaId={conversaId} pedidoId={pedidoAberto} onFechar={() => setAberto(null)} />
          )}
          <form
            className="flex items-center"
            style={{ gap: 8 }}
            onSubmit={(evento) => {
              evento.preventDefault();
              void v.localizar(numero.trim());
            }}
          >
            <input type="text" aria-label="Número do pedido" placeholder="Buscar pelo número do pedido" value={numero}
              maxLength={40} disabled={confirmado.consultaPorNumeroBloqueada}
              onChange={(evento) => setNumero(evento.target.value)} className="orbita-campo flex-1 min-w-0" />
            <button type="submit" disabled={numero.trim() === '' || confirmado.consultaPorNumeroBloqueada} className="orbita-chip cursor-pointer shrink-0" style={CHIP}>
              Buscar
            </button>
          </form>
          {confirmado.consultaPorNumeroBloqueada && (
            <span style={NOTA}>A busca por número parou depois de várias tentativas sem resultado. Ela volta em alguns minutos.</span>
          )}
          {v.busca !== null && ('pedidos' in v.busca
            ? <Pedidos titulo="Resultado da busca" pedidos={v.busca.pedidos} onDetalhes={abrir} />
            : <span style={TEXTO}>{v.busca.mensagem}</span>)}
        </>
      )}

      {v.erro !== null && <Aviso tom="erro">{v.erro}</Aviso>}
    </div>
  );
}
