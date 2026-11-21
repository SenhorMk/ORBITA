'use client';

import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Archive, Loader2 } from 'lucide-react';
import { z } from 'zod';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { isProdutoSynced } from '@/lib/utils';
import type { Produto } from '@/types';

/**
 * O arquivamento de produto pela tela (PRE-003): só expõe
 * `POST /api/produtos/arquivar`. O servidor decide tudo — `bling_id`,
 * organização — a partir do banco: produto vinculado fica inativo no Bling
 * (nunca excluído), com prova, e só então é arquivado no ORBITA; incerteza no
 * Bling mantém o produto ativo. Arquivar não apaga o produto, a foto nem os
 * pedidos antigos.
 *
 * Na tela são dois passos dentro do MESMO modal (nada de diálogo empilhado nem
 * `window.confirm`): "Arquivar produto" abre a confirmação; "Arquivar" envia
 * UMA requisição. Nada muda de forma otimista: quem abriu o modal relê o
 * catálogo da fonte. Produto já arquivado não oferece a ação.
 */

export type DesfechoDoArquivamento =
  | { readonly _tag: 'Arquivado' }
  | { readonly _tag: 'Falhou'; readonly mensagem: string };

const FALHA_DE_REDE = 'Não foi possível falar com o servidor. O produto continua ativo. Tente de novo.';
const FALHA_GENERICA = 'Não foi possível arquivar o produto. Ele continua ativo. Tente de novo.';

/** O contrato da rota: sucesso, ou a frase pública que o servidor escolheu. Nada além disso é exibido. */
const respostaSchema = z.union([
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string().min(1).max(400) }),
]);

/** `POST /api/produtos/arquivar` com SÓ o id local. `bling_id` e organização o servidor lê do banco. */
export async function submitProdutoArquivamento(id: string): Promise<DesfechoDoArquivamento> {
  let resposta: Response;
  try {
    resposta = await fetchWithAuth('/api/produtos/arquivar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch {
    return { _tag: 'Falhou', mensagem: FALHA_DE_REDE };
  }
  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = null;
  }
  const lido = respostaSchema.safeParse(corpo);
  if (resposta.ok && lido.success && lido.data.success) return { _tag: 'Arquivado' };
  return { _tag: 'Falhou', mensagem: lido.success && !lido.data.success ? lido.data.error : FALHA_GENERICA };
}

function ConfirmacaoDoArquivamento({ produto, aviso }: { produto: Produto; aviso: string | null }) {
  const noBling = isProdutoSynced(produto.bling_id);
  return (
    <div className="flex flex-col gap-4 text-sm leading-relaxed" style={{ color: 'var(--txt2)' }}>
      <p className="m-0">
        {noBling
          ? 'O produto sai da venda: no Bling ele fica inativo (não é excluído) e, só depois da confirmação lá, é arquivado no ORBITA. Pedidos antigos continuam com o produto, o nome e o valor.'
          : 'O produto é arquivado no ORBITA e deixa de aparecer para venda. Pedidos antigos continuam com o produto, o nome e o valor.'}
      </p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="orbita-eyebrow">Nome</dt>
        <dd className="m-0" style={{ color: 'var(--txt)' }}>{produto.nome || 'Produto sem nome'}</dd>
        <dt className="orbita-eyebrow">SKU</dt>
        <dd className="m-0 font-mono" style={{ color: 'var(--txt)' }}>{produto.codigo || '—'}</dd>
        {noBling && (
          <>
            <dt className="orbita-eyebrow">ID Bling</dt>
            <dd className="m-0 font-mono" style={{ color: 'var(--txt)' }}>{produto.bling_id}</dd>
          </>
        )}
      </dl>
      {aviso && (
        <p
          role="alert"
          className="m-0 px-4 py-2.5 text-xs"
          style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt)' }}
        >
          {aviso}
        </p>
      )}
    </div>
  );
}

/**
 * O estado do arquivamento no modal do produto.
 *
 * - `botao`: "Arquivar produto" para o rodapé (`RodapeDeModal.destrutiva`);
 *   `null` em produto novo ou já arquivado.
 * - `confirmacao`: com a confirmação aberta, as props que trocam o modal para a
 *   etapa destrutiva (cabeçalho, rodapé, não dispensável durante o envio) e o
 *   corpo. `null` no formulário normal.
 *
 * `bloqueada` (salvando, ou foto em envio) impede começar a arquivar: salvar e
 * arquivar nunca correm juntos pelo mesmo modal. A trava síncrona fecha a
 * janela de dois cliques no mesmo quadro, antes de o `disabled` renderizar.
 */
export function useArquivamentoDoProduto({
  aberto,
  produto,
  bloqueada,
  onArquivado,
  onClose,
}: {
  aberto: boolean;
  produto: Produto | null;
  bloqueada: boolean;
  onArquivado?: () => void;
  onClose: () => void;
}): {
  readonly botao: ReactNode;
  readonly confirmacao: { readonly modal: Partial<ComponentProps<typeof Modal>>; readonly corpo: ReactNode } | null;
  readonly arquivando: boolean;
} {
  /** A confirmação pertence a UM produto: abrir outro volta ao formulário. */
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  const [arquivando, setArquivando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const travaRef = useRef(false);
  const [abertoAntes, setAbertoAntes] = useState(aberto);

  // Fechar o modal descarta a confirmação: reabrir volta ao formulário.
  if (aberto !== abertoAntes) {
    setAbertoAntes(aberto);
    if (!aberto) {
      setConfirmandoId(null);
      setAviso(null);
    }
  }

  const id = produto?.id ?? null;
  const confirmando = id !== null && confirmandoId === id;

  const confirmar = async () => {
    if (id === null || travaRef.current) return;
    travaRef.current = true;
    setArquivando(true);
    setAviso(null);
    const desfecho = await submitProdutoArquivamento(id);
    travaRef.current = false;
    setArquivando(false);
    if (desfecho._tag === 'Falhou') {
      setAviso(desfecho.mensagem);
      return;
    }
    setConfirmandoId(null);
    onClose();
    onArquivado?.();
  };

  const botao = id === null || produto?.situacao === 'arquivado' ? null : (
    <button
      type="button"
      onClick={() => { setAviso(null); setConfirmandoId(id); }}
      disabled={bloqueada}
      className="orbita-chip cursor-pointer"
    >
      <Archive className="w-3.5 h-3.5" aria-hidden />
      Arquivar produto
    </button>
  );

  if (!confirmando || produto === null) return { botao, confirmacao: null, arquivando };

  const modal: Partial<ComponentProps<typeof Modal>> = {
    tamanho: 'sm',
    dispensavel: !arquivando,
    // `dispensavel` só segura ESC e clique fora; o X do cabeçalho fecha por
    // `onAbertoChange(false)`. Enquanto o arquivamento corre, NENHUM pedido de
    // fechar vale — o sucesso fecha por código, e a falha devolve o controle.
    onAbertoChange: (abertoAgora) => {
      if (!abertoAgora && !travaRef.current) onClose();
    },
    eyebrow: 'Arquivar produto',
    titulo: `Arquivar “${produto.nome || 'Produto sem nome'}”?`,
    descricao: 'Confirmação de arquivamento de produto.',
    rodape: (
      <RodapeDeModal
        secundaria={
          <button
            type="button"
            onClick={() => { setConfirmandoId(null); setAviso(null); }}
            disabled={arquivando}
            className="orbita-chip cursor-pointer"
          >
            Voltar
          </button>
        }
        primaria={
          <button
            type="button"
            onClick={() => { void confirmar(); }}
            disabled={arquivando}
            aria-busy={arquivando}
            className="orbita-chip cursor-pointer"
          >
            {arquivando && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
            {arquivando ? 'Arquivando…' : 'Arquivar'}
          </button>
        }
      />
    ),
  };
  return { botao, confirmacao: { modal, corpo: <ConfirmacaoDoArquivamento produto={produto} aviso={aviso} /> }, arquivando };
}
