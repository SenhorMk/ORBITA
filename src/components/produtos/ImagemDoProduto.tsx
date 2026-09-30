'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { ImageIcon } from 'lucide-react';

import type { Produto } from '@/types';
import { ACCEPT_DE_IMAGEM, BUCKET_PRODUTO_IMAGENS } from '@/lib/config/produtoImagemContract';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { supabase } from '@/lib/supabaseClient';

import { enviarFoto, removerFoto, type DesfechoDaFoto, type OperacoesDeFoto } from './fotoDoProduto';

/**
 * A seção "Imagem do produto" do formulário.
 *
 * É independente do "Salvar alterações": a foto é gravada pelas próprias
 * rotas, na hora, e um erro aqui não toca no formulário do produto — nem o
 * contrário.
 *
 * O estado mostrado é o que o servidor confirmou: depois de trocar ou remover,
 * o caminho e a URL vêm da resposta, e o caminho novo passa a ser a precondição
 * da próxima troca. Quem abriu o modal é avisado para reler o catálogo, sem
 * reload de página.
 */

const operacoesDoNavegador: OperacoesDeFoto = {
  async postar(url, corpo) {
    const resposta = await fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
  },
  async enviarAoStorage(caminho, token, arquivo) {
    const { error } = await supabase.storage
      .from(BUCKET_PRODUTO_IMAGENS)
      .uploadToSignedUrl(caminho, token, arquivo, { contentType: arquivo.type, upsert: false });
    return error === null;
  },
};

type Estado =
  | { readonly _tag: 'Ocioso' }
  | { readonly _tag: 'Enviando' }
  | { readonly _tag: 'Removendo' }
  | { readonly _tag: 'Erro'; readonly mensagem: string }
  | { readonly _tag: 'Sucesso'; readonly mensagem: string };

const ID_DO_CAMPO = 'product-detail-foto';

function Previa({ url }: { url: string | null }) {
  return (
    <span
      className="relative flex items-center justify-center shrink-0 overflow-hidden"
      style={{ width: 88, height: 88, borderRadius: 16, background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      <ImageIcon className="absolute w-6 h-6" style={{ color: 'var(--txt3)' }} aria-hidden />
      {url && (
        <Image
          src={url}
          alt="Imagem do produto"
          width={88}
          height={88}
          unoptimized
          className="relative h-full w-full object-cover"
        />
      )}
    </span>
  );
}

function Situacao({ estado, temFotoPropria, temImagem }: { estado: Estado; temFotoPropria: boolean; temImagem: boolean }) {
  if (estado._tag === 'Enviando') return <output className="text-[11px]" style={{ color: 'var(--txt2)' }}>Enviando a foto…</output>;
  if (estado._tag === 'Removendo') return <output className="text-[11px]" style={{ color: 'var(--txt2)' }}>Removendo a foto…</output>;
  if (estado._tag === 'Erro') return <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>{estado.mensagem}</p>;
  if (estado._tag === 'Sucesso') return <output className="text-[11px]" style={{ color: 'var(--accent)' }}>{estado.mensagem}</output>;
  if (temFotoPropria) return null;
  return (
    <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>
      {temImagem ? 'Exibindo a imagem do Bling.' : 'Sem imagem.'}
    </span>
  );
}

export function ImagemDoProduto({
  produto,
  onAlterada,
  operacoes = operacoesDoNavegador,
}: {
  produto: Produto | null;
  /** A foto mudou (ou mudou em outra janela): quem abriu relê o catálogo. */
  onAlterada?: () => void;
  operacoes?: OperacoesDeFoto;
}) {
  const [caminho, setCaminho] = useState<string | null>(produto?.imagem_storage_path ?? null);
  const [url, setUrl] = useState<string | null>(produto?.imagem_url ?? null);
  const [estado, setEstado] = useState<Estado>({ _tag: 'Ocioso' });
  // O estado de React só muda no próximo render; dois cliques no mesmo quadro
  // passariam pelo `disabled`. A trava síncrona fecha essa janela.
  const ocupadoRef = useRef(false);
  const ocupado = estado._tag === 'Enviando' || estado._tag === 'Removendo';

  if (!produto?.id) {
    return (
      <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>
        Salve o produto primeiro para adicionar uma foto.
      </p>
    );
  }
  const produtoId = produto.id;

  const executar = async (inicio: Estado, acao: () => Promise<DesfechoDaFoto>, sucesso: string) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setEstado(inicio);
    try {
      const desfecho = await acao();
      if (desfecho._tag === 'Alterada') {
        setCaminho(desfecho.caminho);
        setUrl(desfecho.url);
        setEstado({ _tag: 'Sucesso', mensagem: sucesso });
        onAlterada?.();
      } else {
        setEstado({ _tag: 'Erro', mensagem: desfecho.mensagem });
        if (desfecho.conflito) onAlterada?.();
      }
    } catch {
      setEstado({ _tag: 'Erro', mensagem: 'Não foi possível concluir agora. Tente de novo em instantes.' });
    } finally {
      ocupadoRef.current = false;
    }
  };

  const aoEscolherArquivo = (evento: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = evento.target.files?.[0];
    // Limpa a escolha para que o mesmo arquivo possa ser escolhido de novo.
    evento.target.value = '';
    if (!arquivo) return;
    void executar(
      { _tag: 'Enviando' },
      () => enviarFoto(arquivo, { produtoId, anterior: caminho }, operacoes),
      caminho ? 'Foto trocada.' : 'Foto adicionada.',
    );
  };

  const aoRemover = () => {
    if (!caminho) return;
    void executar({ _tag: 'Removendo' }, () => removerFoto({ produtoId, anterior: caminho }, operacoes), 'Foto removida.');
  };

  return (
    <div className="flex items-center gap-4">
      <Previa url={url} />
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={ID_DO_CAMPO}
            type="file"
            accept={ACCEPT_DE_IMAGEM}
            disabled={ocupado}
            onChange={aoEscolherArquivo}
            className="peer sr-only"
          />
          <label
            htmlFor={ID_DO_CAMPO}
            aria-disabled={ocupado}
            className="orbita-chip cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
          >
            {caminho ? 'Trocar foto' : 'Adicionar foto'}
          </label>
          {caminho && (
            <button type="button" onClick={aoRemover} disabled={ocupado} className="orbita-chip cursor-pointer">
              Remover foto
            </button>
          )}
        </div>
        <Situacao estado={estado} temFotoPropria={caminho !== null} temImagem={url !== null} />
        <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>JPEG, PNG ou WebP, até 5 MB.</span>
      </div>
    </div>
  );
}
