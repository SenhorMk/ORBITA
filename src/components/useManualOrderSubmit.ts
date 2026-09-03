import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { buildManualOrderRequest, type ManualOrderRequest } from '@/lib/config/manualOrderContract';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';

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
   * Ticket 30, fatia 3, 3ª rodada — âncora de idempotência entre
   * retentativas da MESMA submissão. Estável enquanto `handleSubmit` for
   * chamado para a mesma tentativa (ver `referenciaLocalRef`); nunca
   * regenerado a cada clique.
   */
  referenciaLocal: string;
}

/**
 * Monta o corpo de `POST /api/pedidos/manual` pelo contrato compartilhado com a
 * rota. Nem `total` nem `parcelas` são montados aqui: o valor da venda é
 * derivado no servidor pelos preços do cadastro, e as parcelas são construídas
 * lá com a forma de pagamento real da conta Bling. A versão anterior montava
 * `parcelas` que a rota simplesmente não lia.
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

/**
 * Ticket 30, fatia 3 — 4ª rodada de revisão. `referenciaLocalRef` sozinha
 * (um `useRef`) só sobrevive enquanto a instância do componente existir: um
 * reload da página, o modal fechando e reabrindo, ou a aba fechando e sendo
 * reaberta apagam o `ref` e uma retentativa geraria uma referência NOVA — o
 * ledger do servidor veria como uma tentativa nova de verdade, e chamaria o
 * Bling de novo para uma venda que já podia estar em voo. `localStorage`
 * sobrevive a tudo isso; é o servidor (a tabela `tentativas_venda_manual`)
 * que continua sendo a fonte de verdade — isto é só o que permite ao
 * NAVEGADOR lembrar qual referência usar para retomar.
 */
const CHAVE_TENTATIVA_PENDENTE = 'orbita:pedidos-manual:tentativa-pendente';

function lerReferenciaLocalPersistida(): string | null {
  try {
    return window.localStorage.getItem(CHAVE_TENTATIVA_PENDENTE);
  } catch {
    // localStorage indisponível (modo privado, quota, ambiente sem DOM) — a
    // proteção contra retentativa fica limitada à vida da instância do
    // componente, não é motivo para impedir o envio.
    return null;
  }
}

function persistirReferenciaLocal(referencia: string): void {
  try {
    window.localStorage.setItem(CHAVE_TENTATIVA_PENDENTE, referencia);
  } catch {
    // idem
  }
}

function limparReferenciaLocalPersistida(): void {
  try {
    window.localStorage.removeItem(CHAVE_TENTATIVA_PENDENTE);
  } catch {
    // idem
  }
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
    // rota o traduz em `vendaDuplicada`. Antes isso era detectado comparando
    // a mensagem por substring, com os escapes gravados literalmente no
    // fonte — comparação que nunca casava.
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
 * Envio da venda manual, isolado do componente para caber no limite de
 * tamanho de função do gate de qualidade.
 *
 * Dona da referência local de idempotência (ticket 30, fatia 3). Estável
 * enquanto o usuário retenta a MESMA submissão — inclusive depois de um
 * erro, de um reload da página, ou do modal fechando e reabrindo, porque
 * `referenciaLocalRef` retoma de `localStorage` na inicialização (4ª rodada
 * de revisão: um `useRef` sozinho não sobrevive a nada disso, e uma
 * retentativa com referência nova faria o ledger do servidor tratá-la como
 * tentativa genuinamente nova, liberando uma segunda chamada ao Bling). Só
 * é zerada depois de um sucesso de verdade (`resetReferenciaLocal`).
 */
export function useManualOrderSubmit(input: UseManualOrderSubmitInput) {
  const [loading, setLoading] = useState(false);
  const { setError } = input;
  // Lazy init: só roda uma vez, na primeira renderização — inclusive quando
  // essa "primeira renderização" é depois de um reload, e é exatamente
  // quando isto importa: retoma a referência pendente se houver uma.
  const referenciaLocalRef = useRef<string | null>(null);
  if (referenciaLocalRef.current === null) {
    referenciaLocalRef.current = lerReferenciaLocalPersistida();
  }

  const resetReferenciaLocal = () => {
    referenciaLocalRef.current = null;
    limparReferenciaLocalPersistida();
  };

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
      // Gera a referência só na primeira tentativa; uma retentativa (o
      // usuário clicando "Finalizar" de novo depois de um erro, um reload,
      // ou reabrindo o modal) reenvia a MESMA, para que o servidor a
      // reconheça. Persistida ANTES do envio — sobrevive a partir daqui
      // mesmo que a aba feche no meio da chamada.
      referenciaLocalRef.current ??= crypto.randomUUID();
      persistirReferenciaLocal(referenciaLocalRef.current);
      const payload = buildManualOrderPayload({
        syncBling: input.syncBling,
        selectedCliente: input.selectedCliente,
        formaPagamento: input.formaPagamento,
        desconto: input.desconto,
        frete: input.frete,
        observacoes: input.observacoes,
        itens: input.itens,
        referenciaLocal: referenciaLocalRef.current,
      });

      const resultado = await enviarPedidoManual(payload);
      if (resultado._tag === 'Erro') {
        setError(resultado.mensagem);
        return;
      }
      if (resultado._tag === 'SucessoComAvisos') {
        setError(resultado.mensagem);
        input.onSuccess?.();
        return;
      }

      input.onSuccess?.();
      input.onOpenChange(false);
      resetReferenciaLocal();
      input.resetForm();
    } catch (err: unknown) {
      setError(descreverErro(err));
    } finally {
      setLoading(false);
    }
  };

  return { loading, handleSubmit, resetReferenciaLocal };
}
