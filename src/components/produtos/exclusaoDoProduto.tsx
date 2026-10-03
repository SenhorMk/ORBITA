'use client';

import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { z } from 'zod';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { isProdutoSynced } from '@/lib/utils';
import type { Produto } from '@/types';

/**
 * A exclusão de produto pela tela: só expõe o fluxo seguro que já existe em
 * `POST /api/produtos/delete`. O servidor decide tudo — `bling_id`,
 * organização, foto — a partir do banco: produto vinculado sai do Bling
 * primeiro (situação E → DELETE → GET 404) e só então do ORBITA; incerteza no
 * Bling preserva o produto local.
 *
 * Na tela são dois passos dentro do MESMO modal (nada de diálogo empilhado nem
 * `window.confirm`): "Excluir produto" abre a confirmação; "Excluir
 * definitivamente" envia UMA requisição. Nada é removido de forma otimista: o
 * produto continua na lista até o servidor confirmar, e quem abriu o modal relê
 * o catálogo da fonte.
 */

export type DesfechoDaExclusao =
  | { readonly _tag: 'Excluido' }
  | { readonly _tag: 'Falhou'; readonly mensagem: string };

const FALHA_DE_REDE = 'Não foi possível falar com o servidor. O produto foi mantido. Tente de novo.';
const FALHA_GENERICA = 'Não foi possível excluir o produto. Ele foi mantido. Tente de novo.';

/** O contrato da rota: sucesso, ou a frase pública que o servidor escolheu. Nada além disso é exibido. */
const respostaSchema = z.union([
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string().min(1).max(400) }),
]);

/** `POST /api/produtos/delete` com SÓ o id local. `bling_id`, organização e foto o servidor lê do banco. */
export async function submitProdutoDelete(id: string): Promise<DesfechoDaExclusao> {
  let resposta: Response;
  try {
    resposta = await fetchWithAuth('/api/produtos/delete', {
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
  if (resposta.ok && lido.success && lido.data.success) return { _tag: 'Excluido' };
  return { _tag: 'Falhou', mensagem: lido.success && !lido.data.success ? lido.data.error : FALHA_GENERICA };
}

function ConfirmacaoDaExclusao({ produto, aviso }: { produto: Produto; aviso: string | null }) {
  const noBling = isProdutoSynced(produto.bling_id);
  return (
    <div className="flex flex-col gap-4 text-sm leading-relaxed" style={{ color: 'var(--txt2)' }}>
      <p className="m-0">
        {noBling
          ? 'Este produto será excluído do Bling e, somente depois da confirmação da exclusão no Bling, será removido do ORBITA. Esta ação não pode ser desfeita.'
          : 'Este produto será removido do ORBITA. Esta ação não pode ser desfeita.'}
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
 * O estado da exclusão no modal do produto.
 *
 * - `botao`: "Excluir produto" para o rodapé (`RodapeDeModal.destrutiva`);
 *   `null` em produto novo.
 * - `confirmacao`: com a confirmação aberta, as props que trocam o modal para a
 *   etapa destrutiva (cabeçalho, rodapé, não dispensável durante o envio) e o
 *   corpo. `null` no formulário normal.
 *
 * `bloqueada` (salvando, ou foto em envio) impede começar a excluir: salvar e
 * excluir nunca correm juntos pelo mesmo modal. A trava síncrona fecha a
 * janela de dois cliques no mesmo quadro, antes de o `disabled` renderizar.
 */
export function useExclusaoDoProduto({
  aberto,
  produto,
  bloqueada,
  onDeleted,
  onClose,
}: {
  aberto: boolean;
  produto: Produto | null;
  bloqueada: boolean;
  onDeleted?: () => void;
  onClose: () => void;
}): {
  readonly botao: ReactNode;
  readonly confirmacao: { readonly modal: Partial<ComponentProps<typeof Modal>>; readonly corpo: ReactNode } | null;
  readonly excluindo: boolean;
} {
  /** A confirmação pertence a UM produto: abrir outro volta ao formulário. */
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  const [excluindo, setExcluindo] = useState(false);
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
    setExcluindo(true);
    setAviso(null);
    const desfecho = await submitProdutoDelete(id);
    travaRef.current = false;
    setExcluindo(false);
    if (desfecho._tag === 'Falhou') {
      setAviso(desfecho.mensagem);
      return;
    }
    setConfirmandoId(null);
    onClose();
    onDeleted?.();
  };

  const botao = id === null ? null : (
    <button
      type="button"
      onClick={() => { setAviso(null); setConfirmandoId(id); }}
      disabled={bloqueada}
      className="orbita-chip cursor-pointer"
      style={{ color: 'var(--danger)' }}
    >
      <Trash2 className="w-3.5 h-3.5" aria-hidden />
      Excluir produto
    </button>
  );

  if (!confirmando || produto === null) return { botao, confirmacao: null, excluindo };

  const modal: Partial<ComponentProps<typeof Modal>> = {
    tamanho: 'sm',
    destrutivo: true,
    dispensavel: !excluindo,
    // `dispensavel` só segura ESC e clique fora; o X do cabeçalho fecha por
    // `onAbertoChange(false)`. Enquanto a exclusão corre, NENHUM pedido de
    // fechar vale — o sucesso fecha por código, e a falha devolve o controle.
    onAbertoChange: (abertoAgora) => {
      if (!abertoAgora && !travaRef.current) onClose();
    },
    eyebrow: 'Excluir produto',
    titulo: `Excluir “${produto.nome || 'Produto sem nome'}”?`,
    descricao: 'Confirmação de exclusão de produto.',
    rodape: (
      <RodapeDeModal
        secundaria={
          <button
            type="button"
            onClick={() => { setConfirmandoId(null); setAviso(null); }}
            disabled={excluindo}
            className="orbita-chip cursor-pointer"
          >
            Voltar
          </button>
        }
        primaria={
          <button
            type="button"
            onClick={() => { void confirmar(); }}
            disabled={excluindo}
            aria-busy={excluindo}
            className="orbita-chip cursor-pointer"
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
          >
            {excluindo && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
            {excluindo ? 'Excluindo…' : 'Excluir definitivamente'}
          </button>
        }
      />
    ),
  };
  return { botao, confirmacao: { modal, corpo: <ConfirmacaoDaExclusao produto={produto} aviso={aviso} /> }, excluindo };
}
