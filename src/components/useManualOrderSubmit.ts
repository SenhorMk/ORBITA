import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { buildManualOrderRequest, type ManualOrderRequest } from '@/lib/config/manualOrderContract';
import { fingerprintDaVendaManual } from '@/lib/config/manualOrderFingerprint';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';

import {
  acharPendentePorFingerprint,
  esquecerTentativaPendente,
  registrarTentativaPendente,
} from './tentativaPendente';

export interface ItemPedidoManual {
  produto_id: string;
  bling_id: string;
  nome: string;
  codigo?: string;
  quantidade: number;
  max_quantidade: number;
  valor_unitario: number;
}

interface BuildManualOrderPayloadInput {
  syncBling: boolean;
  selectedCliente: string;
  formaPagamento: string;
  desconto: number | '';
  frete: number | '';
  observacoes: string;
  itens: ItemPedidoManual[];
  /**
   * Âncora de idempotência entre retentativas da MESMA submissão. Estável enquanto `handleSubmit` for
   * chamado para a mesma tentativa (ver `referenciaLocalRef`); nunca
   * regenerado a cada clique.
   */
  referenciaLocal: string;
}

/**
 * Monta o corpo de `POST /api/pedidos/manual` pelo contrato compartilhado com a
 * rota. Nem `total` nem `parcelas` são montados aqui: o valor da venda é
 * derivado no servidor pelos preços do cadastro, e as parcelas são construídas
 * lá com a forma de pagamento real da conta Bling: o cliente não dita o preço.
 */
function buildManualOrderPayload(input: BuildManualOrderPayloadInput): ManualOrderRequest {
  return buildManualOrderRequest({
    syncBling: input.syncBling,
    clienteId: input.selectedCliente,
    itens: input.itens.map((item) => ({ produtoId: item.produto_id, quantidade: item.quantidade })),
    desconto: Number(input.desconto) || 0,
    frete: Number(input.frete) || 0,
    observacoes: input.observacoes.trim() ? input.observacoes.trim() : undefined,
    formaPagamentoRotulo: input.formaPagamento,
    referenciaLocal: input.referenciaLocal,
  });
}

export interface UseManualOrderSubmitInput {
  syncBling: boolean;
  selectedCliente: string;
  formaPagamento: string;
  desconto: number | '';
  frete: number | '';
  observacoes: string;
  itens: ItemPedidoManual[];
  setError: (message: string | null) => void;
  onSuccess?: () => void;
  onOpenChange: (open: boolean) => void;
  resetForm: () => void;
  /**
   * Organização ativa **confirmada pelo servidor**.
   *
   * É o escopo da memória de tentativas pendentes: o ledger do servidor é
   * chaveado por `(organizacao_id, referencia_local)`, e guardar as
   * referências fora desse recorte deixaria a pendência de uma organização ser
   * apagada por uma venda feita em outra. `null` enquanto o servidor não
   * confirmou — e aí nada é lembrado entre instâncias, que é a degradação
   * honesta: sem saber a organização, qualquer escolha de chave seria um
   * palpite.
   */
  organizacaoId: string | null;
}

/** O que `POST /api/pedidos/manual` significa para o modal, resumido em três desfechos. */
type EnvioManualResult =
  | { readonly _tag: 'Erro'; readonly mensagem: string }
  | { readonly _tag: 'SucessoComAvisos'; readonly mensagem: string }
  | { readonly _tag: 'Sucesso' };

/** A chamada de rede em si, separada de `handleSubmit` só pelo limite de tamanho de função do gate de qualidade. */
async function enviarPedidoManual(payload: ManualOrderRequest): Promise<EnvioManualResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetchWithAuth('/api/pedidos/manual', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const data = (await res.json()) as { error?: string; avisos?: string[]; vendaDuplicada?: boolean };

  if (!res.ok) {
    // O Bling sinaliza venda idêntica à anterior por código estruturado; a
    // rota o traduz em `vendaDuplicada`, sem depender do texto da mensagem.
    return {
      _tag: 'Erro',
      mensagem: data.vendaDuplicada
        ? 'Venda duplicada: o Bling recusou um pedido idêntico ao anterior (mesmo cliente, produtos e valores). Altere alguma informação antes de reenviar.'
        : data.error || 'Falha ao processar pedido manual',
    };
  }

  // Avisos são falhas parciais reais (por exemplo, a baixa de estoque no
  // Bling) e o modal fica aberto para que o usuário as leia em vez de
  // vê-las desaparecer.
  if (data.avisos && data.avisos.length > 0) {
    return { _tag: 'SucessoComAvisos', mensagem: `Venda registrada, mas com pendências: ${data.avisos.join(' ')}` };
  }

  return { _tag: 'Sucesso' };
}

/**
 * Decide qual referência esta submissão usa.
 *
 * Uma retentativa da MESMA venda tem de reenviar a MESMA referência, para o
 * ledger do servidor reconhecê-la; uma venda DIFERENTE tem de ganhar
 * referência nova, senão o servidor a recusa como conflito de conteúdo. Quem
 * decide qual das duas é o caso é o fingerprint — não a ordem dos cliques, nem
 * o modal ter sido reaberto.
 *
 * Duas camadas de memória, e a ordem importa: `localStorage` primeiro, porque
 * é a que sobrevive ao reload; o `Map` em
 * memória depois, como rede para quando `localStorage` está indisponível
 * (aba anônima, quota), onde a proteção volta a valer só dentro da instância.
 */
function resolverReferencia(
  organizacaoId: string | null,
  fingerprint: string,
  emMemoria: Map<string, string>,
): string {
  const persistida = organizacaoId ? acharPendentePorFingerprint(organizacaoId, fingerprint)?.referencia : undefined;
  const referencia = persistida ?? emMemoria.get(fingerprint) ?? crypto.randomUUID();

  emMemoria.set(fingerprint, referencia);
  if (organizacaoId) registrarTentativaPendente(organizacaoId, { referencia, fingerprint });

  return referencia;
}

/**
 * Envio da venda manual, isolado do componente para caber no limite de
 * tamanho de função do gate de qualidade.
 *
 * Dono da referência local de idempotência. A referência é estável enquanto o
 * usuário retenta a MESMA venda — inclusive depois de um erro, de um reload da
 * página, ou do modal fechando e reabrindo — e é NOVA quando a venda é outra.
 * Ela é "a referência daquela venda", indexada pelo fingerprint do conteúdo e
 * escopada por organização: ver `tentativaPendente.ts`.
 *
 * Uma referência só é esquecida quando o desfecho dela é CONHECIDO — sucesso
 * sem avisos do envio, ou uma reconciliação que a liberou. Esquecer por qualquer outro
 * motivo removeria a âncora de uma tentativa que ninguém resolveu, que é
 * exatamente o que a proteção existe para impedir.
 */
export function useManualOrderSubmit(input: UseManualOrderSubmitInput) {
  const [loading, setLoading] = useState(false);
  const { setError, organizacaoId } = input;
  const referenciasEmMemoria = useRef<Map<string, string>>(new Map());

  const handleSubmit = async () => {
    if (!input.selectedCliente) {
      setError('Selecione um cliente.');
      return;
    }
    if (input.itens.length === 0) {
      setError('Adicione pelo menos um item ao pedido.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const dadosDaVenda = {
        syncBling: input.syncBling,
        selectedCliente: input.selectedCliente,
        formaPagamento: input.formaPagamento,
        desconto: input.desconto,
        frete: input.frete,
        observacoes: input.observacoes,
        itens: input.itens,
      };

      // O fingerprint não depende da referência (ela é a chave, não o
      // conteúdo), então montar o corpo com uma referência provisória para
      // calculá-lo é seguro — e é o que permite decidir, em seguida, QUAL
      // referência esta submissão merece.
      const fingerprint = await fingerprintDaVendaManual(
        buildManualOrderPayload({ ...dadosDaVenda, referenciaLocal: crypto.randomUUID() }),
      );
      // Gravada ANTES do envio: a partir daqui a âncora sobrevive mesmo que a
      // aba feche no meio da chamada.
      const referenciaLocal = resolverReferencia(organizacaoId, fingerprint, referenciasEmMemoria.current);

      const resultado = await enviarPedidoManual(buildManualOrderPayload({ ...dadosDaVenda, referenciaLocal }));
      if (resultado._tag === 'Erro') {
        setError(resultado.mensagem);
        return;
      }
      if (resultado._tag === 'SucessoComAvisos') {
        setError(resultado.mensagem);
        input.onSuccess?.();
        return;
      }

      // Desfecho CONHECIDO e bem-sucedido: só aqui a âncora pode ser esquecida.
      referenciasEmMemoria.current.delete(fingerprint);
      if (organizacaoId) esquecerTentativaPendente(organizacaoId, referenciaLocal);

      input.onSuccess?.();
      input.onOpenChange(false);
      input.resetForm();
    } catch (err: unknown) {
      setError(descreverErro(err));
    } finally {
      setLoading(false);
    }
  };

  return { loading, handleSubmit };
}
