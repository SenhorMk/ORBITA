'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { ImageIcon } from 'lucide-react';

import type { Produto } from '@/types';
import {
  ACCEPT_DE_IMAGEM,
  BUCKET_PRODUTO_IMAGENS,
  TAMANHO_MAXIMO_DA_IMAGEM_MB,
  estadoDaFotoNoBling,
  type EstadoDaFotoNoBling,
} from '@/lib/config/produtoImagemContract';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { supabase } from '@/lib/supabaseClient';

import { enviarFoto, removerFoto, sincronizarFoto, type OperacoesDeFoto } from './fotoDoProduto';

/**
 * A seção "Imagem do produto" do formulário.
 *
 * É independente do "Salvar alterações": a foto é gravada pelas próprias
 * rotas, na hora, e um erro aqui não toca no formulário do produto — nem o
 * contrário.
 *
 * O estado mostrado é o que o servidor confirmou: depois de trocar ou remover,
 * o caminho, a URL e o estado no Bling vêm da resposta, e o caminho novo passa
 * a ser a precondição da próxima troca. Quem abriu o modal é avisado para
 * reler o catálogo, sem reload de página.
 *
 * O estado no Bling é derivado do produto persistido (desejado × confirmado),
 * então uma pendência continua visível depois de recarregar a página. "Tentar
 * sincronizar novamente" usa a foto já salva — nenhum arquivo é pedido de novo.
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
  | { readonly _tag: 'Sincronizando' }
  | { readonly _tag: 'Erro'; readonly mensagem: string }
  | { readonly _tag: 'Sucesso'; readonly mensagem: string };

const ID_DO_CAMPO = 'product-detail-foto';

/** A frase depois de adicionar/trocar ou remover, pelo estado em que o Bling ficou. */
export function mensagemDoDesfecho(acao: 'enviar' | 'remover', bling: EstadoDaFotoNoBling): string {
  if (acao === 'remover') {
    if (bling === 'pendente') return 'Foto removida do ORBITA. Remoção no Bling pendente.';
    if (bling === 'sem_vinculo') return 'Foto removida do ORBITA. O produto não está vinculado ao Bling.';
    return 'Foto removida.';
  }
  if (bling === 'sincronizada') return 'Foto atualizada.';
  if (bling === 'sem_vinculo') return 'Foto salva no ORBITA. O produto ainda não está vinculado ao Bling.';
  return 'Foto salva no ORBITA. Sincronização com o Bling pendente.';
}

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

const TEXTO = 'text-[11px]';

function Situacao({ estado, temFotoPropria, temImagem }: { estado: Estado; temFotoPropria: boolean; temImagem: boolean }) {
  if (estado._tag === 'Enviando') return <output className={TEXTO} style={{ color: 'var(--txt2)' }}>Enviando a foto…</output>;
  if (estado._tag === 'Removendo') return <output className={TEXTO} style={{ color: 'var(--txt2)' }}>Removendo a foto…</output>;
  if (estado._tag === 'Sincronizando') return <output className={TEXTO} style={{ color: 'var(--txt2)' }}>Sincronizando com o Bling…</output>;
  if (estado._tag === 'Erro') return <p role="alert" className={TEXTO} style={{ color: 'var(--danger)' }}>{estado.mensagem}</p>;
  if (estado._tag === 'Sucesso') return <output className={TEXTO} style={{ color: 'var(--accent)' }}>{estado.mensagem}</output>;
  if (temFotoPropria) return null;
  return <span className={TEXTO} style={{ color: 'var(--txt3)' }}>{temImagem ? 'Exibindo a imagem do Bling.' : 'Sem imagem.'}</span>;
}

/** O estado persistente no Bling, com a nova tentativa quando há pendência. */
function SituacaoNoBling({ bling, ocupado, onTentar }: { bling: EstadoDaFotoNoBling; ocupado: boolean; onTentar: () => void }) {
  if (bling === 'sem_foto') return null;
  if (bling === 'sincronizada') return <span className={TEXTO} style={{ color: 'var(--txt3)' }}>Sincronizada com o Bling.</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={TEXTO} style={{ color: 'var(--warning)' }}>
        {bling === 'pendente'
          ? 'Sincronização com o Bling pendente.'
          : 'Produto sem vínculo com o Bling: sincronize o catálogo e tente de novo.'}
      </span>
      <button type="button" onClick={onTentar} disabled={ocupado} className="orbita-chip cursor-pointer">
        Tentar sincronizar novamente
      </button>
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
  const [bling, setBling] = useState<EstadoDaFotoNoBling>(() => estadoDaFotoNoBling({
    blingId: produto?.bling_id, desejado: produto?.imagem_storage_path, confirmado: produto?.imagem_bling_sync_path,
  }));
  const [estado, setEstado] = useState<Estado>({ _tag: 'Ocioso' });
  // O estado de React só muda no próximo render; dois cliques no mesmo quadro
  // passariam pelo `disabled`. A trava síncrona fecha essa janela.
  const ocupadoRef = useRef(false);
  const ocupado = estado._tag === 'Enviando' || estado._tag === 'Removendo' || estado._tag === 'Sincronizando';

  if (!produto?.id) {
    return (
      <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>
        Salve o produto primeiro para adicionar uma foto.
      </p>
    );
  }
  const produtoId = produto.id;

  /** Uma operação por vez; o desfecho atualiza foto, estado no Bling e a mensagem. */
  const executar = async (inicio: Estado, acao: () => Promise<{ mensagem: string; conflito?: boolean; ok: boolean }>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setEstado(inicio);
    try {
      const desfecho = await acao();
      setEstado(desfecho.ok ? { _tag: 'Sucesso', mensagem: desfecho.mensagem } : { _tag: 'Erro', mensagem: desfecho.mensagem });
      if (desfecho.ok || desfecho.conflito) onAlterada?.();
    } catch {
      setEstado({ _tag: 'Erro', mensagem: 'Não foi possível concluir agora. Tente de novo em instantes.' });
    } finally {
      ocupadoRef.current = false;
    }
  };

  const alterar = (inicio: Estado, acao: 'enviar' | 'remover', chamada: () => ReturnType<typeof enviarFoto>) =>
    executar(inicio, async () => {
      const desfecho = await chamada();
      if (desfecho._tag === 'Falhou') return { ok: false, mensagem: desfecho.mensagem, conflito: desfecho.conflito };
      setCaminho(desfecho.caminho);
      setUrl(desfecho.url);
      setBling(desfecho.bling);
      return { ok: true, mensagem: mensagemDoDesfecho(acao, desfecho.bling) };
    });

  const aoEscolherArquivo = (evento: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = evento.target.files?.[0];
    // Limpa a escolha para que o mesmo arquivo possa ser escolhido de novo.
    evento.target.value = '';
    if (!arquivo) return;
    void alterar({ _tag: 'Enviando' }, 'enviar', () => enviarFoto(arquivo, { produtoId, anterior: caminho }, operacoes));
  };

  const aoRemover = () => {
    if (!caminho) return;
    void alterar({ _tag: 'Removendo' }, 'remover', () => removerFoto({ produtoId, anterior: caminho }, operacoes));
  };

  const aoTentarDeNovo = () =>
    void executar({ _tag: 'Sincronizando' }, async () => {
      const desfecho = await sincronizarFoto(produtoId, operacoes);
      if (desfecho._tag === 'Falhou') return { ok: false, mensagem: desfecho.mensagem };
      setBling(desfecho.bling);
      return desfecho.bling === 'sincronizada' || desfecho.bling === 'sem_foto'
        ? { ok: true, mensagem: 'Foto sincronizada com o Bling.' }
        : { ok: false, mensagem: mensagemDoDesfecho(caminho === null ? 'remover' : 'enviar', desfecho.bling) };
    });

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
        {estado._tag !== 'Sincronizando' && <SituacaoNoBling bling={bling} ocupado={ocupado} onTentar={aoTentarDeNovo} />}
        <span className={TEXTO} style={{ color: 'var(--txt3)' }}>JPEG, PNG ou WebP, até {TAMANHO_MAXIMO_DA_IMAGEM_MB} MB.</span>
      </div>
    </div>
  );
}
