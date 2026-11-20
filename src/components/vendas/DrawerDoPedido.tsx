'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Archive, Pencil, Receipt, XCircle } from 'lucide-react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { StatusPill } from '@/components/ui/StatusPill';
import { EstadoCarregando, EstadoDeErro } from '@/components/ui/estados';
import { EditOrderModal } from '@/components/EditOrderModal';
import { BlingPedido } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';
import { pedidoContaComoVendaAtiva } from '@/lib/metricas/vendasAtivas';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { HelpInfo } from '@/components/help/HelpInfo';

/**
 * O detalhe de um pedido, agora no drawer de 520px do Design System.
 *
 * A casca mudou; a lógica não. Continuam valendo, do primeiro ao último:
 *
 * - o **snapshot local** de quem abriu o pedido, que é o que mantém um pedido
 *   apagado no Bling legível aqui;
 * - o `404` do ERP tratado como **resposta**, e não como avaria — ele cai no
 *   registro histórico local, e não em "Pedido não encontrado";
 * - as ações que escrevem no ERP desabilitadas quando não há cópia lá ou quando
 *   o pedido está cancelado.
 *
 * A ação destrutiva é **cancelar**, e não apagar. É a regra do produto: pedido
 * errado se cancela, o histórico fica, o título financeiro converge para
 * cancelado, e a correção vira um pedido novo. A tabela já oferecia cancelar; o
 * drawer oferecia apagar, e duas semânticas destrutivas para o mesmo objeto é
 * como alguém apaga o que só queria corrigir. O cancelamento é delegado ao
 * mesmo `CancelamentoDePedido` da tabela — não há uma segunda implementação da
 * busca de situação, do `POST /api/pedidos/status` nem da confirmação.
 */

interface DrawerDoPedidoProps {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  pedidoBlingId: string | null;
  /**
   * O snapshot LOCAL do pedido, quando quem abriu o drawer já o tinha.
   *
   * Um pedido apagado ou cancelado no Bling continua existindo aqui: sem ele,
   * abrir o histórico devolvia apenas "Pedido não encontrado", como se o
   * registro estivesse quebrado — quando o Orbita tem o registro inteiro e é o
   * ERP que não tem mais.
   */
  pedidoLocal?: PedidoEnriquecido | null;
  /** Emite a NF-e pelo mesmo caminho que a lista já usa. */
  onEmitirNfe?: (pedido: PedidoEnriquecido) => void;
  /**
   * Pede o cancelamento do pedido. Quem trata é o mesmo fluxo da tabela; o
   * drawer não abre diálogo próprio nem escreve no ERP por conta própria.
   */
  onCancelar?: (pedido: PedidoEnriquecido) => void;
  /**
   * Abre o pedido só para ler. Padrão `false` — Vendas & Pedidos continua
   * exatamente como está.
   *
   * O Financeiro abre este mesmo drawer a partir de uma entrada, e ali
   * `Detalhes` é leitura. Não passar `onCancelar`/`onEmitirNfe` já desabilitava
   * essas duas, mas `Editar` é interna ao drawer e continuava disponível — uma
   * escrita no ERP a partir de uma tela que não a oferece. Em modo leitura o
   * rodapé inteiro sai: botão morto é pior que botão ausente.
   */
  somenteLeitura?: boolean;
}

/** O pedido sumiu do Bling — não é falha de rede nem erro de leitura. */
const PEDIDO_AUSENTE_NO_BLING = 'PedidoAusenteNoBling';

/** Busca os detalhes de um pedido no Bling ERP. O ID é URI-encoded para suportar IDs `#MANUAL-...`. */
async function fetchPedidoDetalhes(id: string): Promise<BlingPedido> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetchWithAuth(`/api/bling/pedidos/${encodeURIComponent(id)}`, {
    headers: (token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    // `404` é uma resposta, não uma avaria: o Bling respondeu que aquele pedido
    // não existe mais lá. Quem chama precisa distinguir isso de "não consegui
    // perguntar" para poder cair no histórico local.
    if (res.status === 404) throw new Error(PEDIDO_AUSENTE_NO_BLING);
    throw new Error(data.error || 'Erro ao carregar detalhes do pedido');
  }
  return data.data;
}

function reais(valor: number | string | null | undefined): string {
  const numero = Number(valor ?? 0);
  return (Number.isFinite(numero) ? numero : 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="orbita-eyebrow">{titulo}</h4>
      {children}
    </section>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs" style={{ color: 'var(--txt3)' }}>{rotulo}</span>
      <span className="text-[13px] text-right" style={{ color: 'var(--txt)' }}>{valor}</span>
    </div>
  );
}

/** O corpo com os dados que o Bling devolveu: cliente, entrega, itens, totais. */
function DetalhesDoErp({ pedido }: { pedido: BlingPedido }) {
  const etiqueta = pedido.transporte?.etiqueta;
  const frete = pedido.transporte?.frete;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <StatusPill status={pedido.situacao?.valor ? String(pedido.situacao.valor) : null} />
        <span className="orbita-numero text-2xl">{reais(pedido.total)}</span>
      </div>

      <Secao titulo="Cliente">
        <div className="flex flex-col gap-1.5">
          <Linha rotulo="Nome" valor={pedido.contato.nome} />
          {pedido.contato.numeroDocumento && (
            <Linha rotulo="Documento" valor={pedido.contato.numeroDocumento} />
          )}
        </div>
      </Secao>

      <Secao titulo="Entrega">
        {etiqueta ? (
          <div className="flex flex-col gap-1.5">
            <Linha
              rotulo="Endereço"
              valor={`${etiqueta.endereco}, ${etiqueta.numero}${etiqueta.complemento ? ` - ${etiqueta.complemento}` : ''}`}
            />
            <Linha rotulo="Bairro" valor={etiqueta.bairro} />
            <Linha rotulo="Cidade" valor={`${etiqueta.municipio} - ${etiqueta.uf}`} />
            <Linha rotulo="CEP" valor={etiqueta.cep} />
            {frete !== undefined && <Linha rotulo="Frete" valor={reais(frete)} />}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--txt3)' }}>
            Sem informações de endereço para este pedido.
          </p>
        )}
      </Secao>

      <Secao titulo={`Itens · ${pedido.itens?.length ?? 0}`}>
        <div className="flex flex-col">
          {pedido.itens?.map((item, idx) => (
            <div
              key={`${item.codigo ?? 'item'}-${idx}`}
              className="flex items-start justify-between gap-4 py-2.5"
              style={{ borderBottom: '1px solid var(--line)' }}
            >
              <div className="flex flex-col min-w-0">
                <span className="text-[13px] truncate" style={{ color: 'var(--txt)' }}>{item.descricao}</span>
                <span
                  className="text-[11px]"
                  style={{ color: 'var(--txt3)', fontFamily: 'var(--font-jetbrains-mono), monospace' }}
                >
                  {item.codigo || '—'} · {item.quantidade} un
                </span>
              </div>
              <div className="flex flex-col items-end shrink-0">
                <span className="orbita-numero text-[14px]">
                  {reais(Number(item.quantidade) * Number(item.valor || 0))}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>
                  {reais(item.valor)} un
                </span>
              </div>
            </div>
          ))}
        </div>
      </Secao>

      {(pedido.observacoes || pedido.observacoesInternas) && (
        <Secao titulo="Observações">
          <div className="flex flex-col gap-2 text-[13px]" style={{ color: 'var(--txt2)' }}>
            {pedido.observacoes && <p className="whitespace-pre-wrap">{pedido.observacoes}</p>}
            {pedido.observacoesInternas && (
              <p className="whitespace-pre-wrap" style={{ color: 'var(--txt3)' }}>
                {pedido.observacoesInternas}
              </p>
            )}
          </div>
        </Secao>
      )}
    </div>
  );
}

/**
 * O que se mostra quando o pedido não existe mais no Bling.
 *
 * O Orbita guarda o registro para histórico e auditoria; o ERP é que não tem
 * mais. Esta situação **não** pode voltar a cair no bloco de erro genérico e
 * dizer só "Pedido não encontrado", como se o registro estivesse quebrado.
 */
function RegistroHistoricoLocal({ pedidoLocal }: { pedidoLocal: PedidoEnriquecido | null }) {
  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-col gap-2 p-4 rounded-2xl"
        style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>
          <Archive className="w-4 h-4" aria-hidden />
          Registro histórico local
        </div>
        <p className="text-xs" style={{ color: 'var(--txt2)' }}>
          Este pedido não existe mais no Bling. O Orbita mantém o registro para histórico e
          auditoria, e é ele que está sendo mostrado abaixo.
        </p>
      </div>

      {pedidoLocal ? (
        <div className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <StatusPill status={pedidoLocal.status} />
            <span className="orbita-numero text-2xl">{reais(pedidoLocal.total)}</span>
          </div>
          <Secao titulo="Pedido">
            <div className="flex flex-col gap-1.5">
              <Linha rotulo="Número" valor={`#${pedidoLocal.numero}`} />
              <Linha rotulo="Cliente" valor={pedidoLocal.cliente?.nome ?? 'Cliente Consumidor'} />
              {pedidoLocal.cliente?.cpf_cnpj && (
                <Linha rotulo="Documento" valor={pedidoLocal.cliente.cpf_cnpj} />
              )}
              <Linha rotulo="Entrada" valor={new Date(pedidoLocal.data).toLocaleString('pt-BR')} />
              {pedidoLocal.frete !== undefined && <Linha rotulo="Frete" valor={reais(pedidoLocal.frete)} />}
              <Linha rotulo="Total" valor={reais(pedidoLocal.total)} />
            </div>
          </Secao>
        </div>
      ) : (
        <p className="text-xs" style={{ color: 'var(--txt3)' }}>
          O snapshot local não foi carregado nesta tela.
        </p>
      )}
    </div>
  );
}

export function DrawerDoPedido({
  aberto,
  onAbertoChange,
  pedidoBlingId,
  pedidoLocal,
  onEmitirNfe,
  onCancelar,
  somenteLeitura = false,
}: DrawerDoPedidoProps) {
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ausenteNoBling, setAusenteNoBling] = useState(false);
  const [pedido, setPedido] = useState<BlingPedido | null>(null);
  const [edicaoAberta, setEdicaoAberta] = useState(false);

  const canceladoLocalmente = pedidoLocal ? !pedidoContaComoVendaAtiva(pedidoLocal) : false;
  // Sem cópia no ERP, nada que escreva lá faz sentido — e um pedido cancelado
  // não recebe NF-e nem edição.
  const acoesNoErpIndisponiveis = ausenteNoBling || canceladoLocalmente;

  const buscarPedido = useCallback(async (id: string, montado: () => boolean = () => true) => {
    try {
      if (montado()) {
        setCarregando(true);
        setErro(null);
        setAusenteNoBling(false);
      }
      const data = await fetchPedidoDetalhes(id);
      if (montado()) setPedido(data);
    } catch (err: unknown) {
      if (!montado()) return;
      if (err instanceof Error && err.message === PEDIDO_AUSENTE_NO_BLING) {
        setAusenteNoBling(true);
      } else {
        setErro(descreverErro(err));
      }
    } finally {
      if (montado()) setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (!aberto || !pedidoBlingId) return;
    let montado = true;
    void (async () => {
      await buscarPedido(pedidoBlingId, () => montado);
    })();
    return () => {
      montado = false;
    };
  }, [aberto, pedidoBlingId, buscarPedido]);

  const numero = pedido?.numero ?? pedidoLocal?.numero ?? '';
  const quando = pedido?.data ?? pedidoLocal?.data;

  return (
    <>
      <Modal
        aberto={aberto}
        onAbertoChange={onAbertoChange}
        tamanho="drawer"
        eyebrow={`Pedido #${numero}${quando ? ` · ${new Date(quando).toLocaleString('pt-BR')}` : ''}`}
        titulo={pedido?.contato?.nome ?? pedidoLocal?.cliente?.nome ?? 'Detalhes do pedido'}
        descricao="Detalhes do pedido, lidos do Bling quando ele ainda existe lá."
        rodape={somenteLeitura ? undefined : (
          <RodapeDeModal
            destrutiva={
              <button
                type="button"
                onClick={() => pedidoLocal && onCancelar?.(pedidoLocal)}
                disabled={!onCancelar || !pedidoLocal || acoesNoErpIndisponiveis}
                className="orbita-chip cursor-pointer"
                style={{ color: 'var(--danger)' }}
                title={
                  ausenteNoBling
                    ? 'O pedido já não existe no Bling — não há o que cancelar lá.'
                    : canceladoLocalmente
                      ? 'Este pedido já está cancelado.'
                      : undefined
                }
              >
                <XCircle className="w-3.5 h-3.5" />
                Cancelar pedido
              </button>
            }
            secundaria={
              <button
                type="button"
                onClick={() => {
                  if (!pedido) return;
                  if (String(pedido.situacao?.valor || '').toLowerCase().includes('emitid')) {
                    alert('Pedidos com NF-e emitida não podem ser editados.');
                    return;
                  }
                  setEdicaoAberta(true);
                }}
                disabled={!pedido || acoesNoErpIndisponiveis}
                className="orbita-chip cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" />
                Editar
              </button>
            }
            primaria={
              <button
                type="button"
                onClick={() => pedidoLocal && onEmitirNfe?.(pedidoLocal)}
                disabled={!pedido || acoesNoErpIndisponiveis || !onEmitirNfe || !pedidoLocal}
                className="orbita-chip cursor-pointer"
                style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
              >
                <Receipt className="w-3.5 h-3.5" />
                Emitir NF-e
              </button>
            }
          />
        )}
      >
      <HelpInfo ajudaId="vendas.detalhe" />
        {carregando && <EstadoCarregando mensagem="Buscando dados no Bling ERP…" />}

        {erro && !carregando && (
          <EstadoDeErro
            titulo="Não foi possível ler este pedido no Bling"
            detalhe={erro}
            onTentarDeNovo={() => pedidoBlingId && buscarPedido(pedidoBlingId)}
          />
        )}

        {ausenteNoBling && !carregando && <RegistroHistoricoLocal pedidoLocal={pedidoLocal ?? null} />}

        {pedido && !carregando && !ausenteNoBling && <DetalhesDoErp pedido={pedido} />}

        {canceladoLocalmente && !carregando && (
          <div
            className="flex items-start gap-2 mt-6 px-4 py-3 rounded-xl text-xs"
            style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--danger)' }}
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
            <span>
              Pedido cancelado. Ele continua no histórico, e as ações que escrevem no ERP —
              editar e emitir NF-e — ficam indisponíveis.
            </span>
          </div>
        )}
      </Modal>

      {/* A edição do pedido é feita pelo `EditOrderModal`, reaproveitado aqui
          com a lógica dele intacta. */}
      <EditOrderModal
        open={edicaoAberta && !somenteLeitura}
        onOpenChange={setEdicaoAberta}
        pedido={pedido}
        onSuccess={() => {
          setEdicaoAberta(false);
          if (pedidoBlingId) void buscarPedido(pedidoBlingId);
          window.dispatchEvent(new CustomEvent('pedido-apagado'));
        }}
      />
    </>
  );
}
