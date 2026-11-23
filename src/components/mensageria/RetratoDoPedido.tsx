'use client';

import { useEffect, useState } from 'react';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import {
  RespostaDoRetratoSchema,
  type EstoqueDoItem,
  type Frescor,
  type PagamentoDoRetrato,
  type RetratoDoPedido as Retrato,
} from '@/lib/integrations/contratoDoRetrato';
import { Aviso } from './Aviso';
import { HelpInfo } from '@/components/help/HelpInfo';
import { PreviaDeTroca } from './PreviaDeTroca';
import { PropostaPersistida } from './PropostaPersistida';

const CHIP = { height: 28, fontSize: 11 } as const;
const NOTA = { fontSize: 11, color: 'var(--txt3)' } as const;
const TEXTO = { fontSize: 12, color: 'var(--txt)' } as const;
const ERRO_DE_LEITURA = 'Não foi possível ler os detalhes deste pedido.';

const reais = (valor: number) => valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dia = (data: string) => new Date(`${data.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');

function rotuloDoEstoque(estoque: EstoqueDoItem): string {
  switch (estoque.situacao) {
    case 'disponivel': return `${estoque.disponivel} disponíveis`;
    case 'indisponivel': return 'Sem estoque disponível';
    case 'inativo': return 'Produto inativo';
    case 'arquivado': return 'Produto fora de linha';
    case 'desconhecido': return 'Estoque desconhecido';
  }
}

function rotuloDoPagamento(pagamento: PagamentoDoRetrato): string {
  const valor = pagamento.valor === null ? '' : ` · ${reais(pagamento.valor)}`;
  switch (pagamento.situacao) {
    case 'pago': return `Pago${pagamento.pagoEm ? ` em ${dia(pagamento.pagoEm)}` : ''}${valor}`;
    case 'parcial': return `Pago em parte${valor}`;
    case 'em_aberto': return `Em aberto${pagamento.vencido ? ', vencido' : ''}${pagamento.vencimento ? ` · vence ${dia(pagamento.vencimento)}` : ''}${valor}`;
    case 'cancelado': return `Cobrança cancelada${valor}`;
    case 'devolvido': return `Valor devolvido${valor}`;
    case 'desconhecido': return pagamento.valor === null ? 'Sem título a receber: pagamento desconhecido' : `Situação não comprovada${valor}`;
  }
}

const MOTIVO = {
  ultima_sincronizacao_falhou: 'a última sincronização falhou',
  antiga: 'sincronizado há mais de um dia',
  sem_sincronizacao: 'nunca sincronizado',
} as const;

/** Uma linha por parte que não está atual. Vazio: tudo atual. */
function avisosDeFrescor(frescor: Retrato['frescor']): string[] {
  const partes: Array<[string, Frescor]> = [['Pedido', frescor.pedido], ['Estoque', frescor.estoque], ['Pagamento', frescor.pagamento]];
  return partes.flatMap(([nome, f]) => (f.motivo === null ? [] : [`${nome}: ${MOTIVO[f.motivo]}.`]));
}

type Estado = { readonly retrato: Retrato } | { readonly erro: string } | null;

async function lerRetrato(fetchWithAuth: AuthenticatedFetch, conversaId: string, pedidoId: string): Promise<NonNullable<Estado>> {
  try {
    const resposta = await fetchWithAuth(`/api/sac/pedidos/retrato?conversaId=${conversaId}&pedidoId=${pedidoId}`);
    const corpo: unknown = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      const erro = (corpo as { error?: unknown } | null)?.error;
      return { erro: typeof erro === 'string' ? erro : ERRO_DE_LEITURA };
    }
    const lido = RespostaDoRetratoSchema.safeParse(corpo);
    return lido.success ? { retrato: lido.data.retrato } : { erro: ERRO_DE_LEITURA };
  } catch {
    return { erro: ERRO_DE_LEITURA };
  }
}

/**
 * Os detalhes de um pedido do cliente confirmado (MSG-011): itens com estoque,
 * pagamento, rastreio e quão recentes são esses dados. Só leitura. O que o
 * ORBITA não sabe aparece como desconhecido; dado velho vem com aviso.
 */
export function RetratoDoPedido({
  fetchWithAuth,
  conversaId,
  pedidoId,
  onFechar,
}: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly conversaId: string;
  readonly pedidoId: string;
  readonly onFechar: () => void;
}) {
  const [guardado, setGuardado] = useState<{ readonly chave: string; readonly estado: NonNullable<Estado> } | null>(null);
  const chave = `${conversaId}:${pedidoId}`;

  useEffect(() => {
    let vivo = true;
    void lerRetrato(fetchWithAuth, conversaId, pedidoId).then((estado) => {
      if (vivo) setGuardado({ chave: `${conversaId}:${pedidoId}`, estado });
    });
    return () => {
      vivo = false;
    };
  }, [fetchWithAuth, conversaId, pedidoId]);

  const estado: Estado = guardado?.chave === chave ? guardado.estado : null;
  const retrato = estado !== null && 'retrato' in estado ? estado.retrato : null;
  const avisos = retrato === null ? [] : avisosDeFrescor(retrato.frescor);

  return (
    <section aria-label="Detalhes do pedido" className="flex flex-col"
      style={{ gap: 6, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 12 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <span className="orbita-eyebrow flex-1" style={{ color: 'var(--txt3)' }}>
          {retrato === null ? 'Detalhes do pedido' : `Pedido ${retrato.pedido.numero ?? 'sem número'} · ${retrato.pedido.status}`}
        </span>
        <HelpInfo ajudaId="sac.pedido" />
        <button type="button" onClick={onFechar} aria-label="Fechar detalhes do pedido" className="orbita-chip cursor-pointer" style={CHIP}>
          Fechar
        </button>
      </div>

      {estado === null && <span style={NOTA}>Lendo…</span>}
      {estado !== null && 'erro' in estado && <Aviso tom="erro">{estado.erro}</Aviso>}

      {retrato !== null && (
        <>
          <PreviaDeTroca key={chave} fetchWithAuth={fetchWithAuth} conversaId={conversaId} pedidoId={pedidoId} itens={retrato.itens} />
          <PropostaPersistida key={chave + ":proposta"} fetchWithAuth={fetchWithAuth} conversaId={conversaId} pedidoId={pedidoId} itens={retrato.itens} />
          {avisos.length > 0 && (
            <Aviso tom="atencao">
              {avisos.join(' ')} Confirme no Bling antes de responder ao cliente.
            </Aviso>
          )}
          <ul aria-label="Itens do pedido" className="flex flex-col" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
            {retrato.itens.map((item) => (
              <li key={item.id} className="flex items-center flex-wrap" style={{ gap: 8, ...TEXTO }}>
                <span>{item.nome}</span>
                <span style={NOTA}>{item.quantidade} × {reais(item.valorUnitario)} · {rotuloDoEstoque(item.estoque)}</span>
              </li>
            ))}
          </ul>
          {retrato.itensOmitidos > 0 && <span style={NOTA}>e mais {retrato.itensOmitidos} itens, não listados aqui.</span>}
          <output aria-label="Pagamento" style={TEXTO}>{rotuloDoPagamento(retrato.pagamento)}</output>
          <output aria-label="Rastreio" style={NOTA}>Rastreio desconhecido: o ORBITA ainda não recebe código de rastreio.</output>
          <span style={NOTA}>Total {reais(retrato.pedido.total)}{retrato.pedido.formaDePagamento ? ` · forma informada: ${retrato.pedido.formaDePagamento}` : ''}</span>
        </>
      )}
    </section>
  );
}
