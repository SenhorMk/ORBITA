'use client';

import { AlertCircle, Inbox, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Os três estados que toda lista precisa ter desenhados.
 *
 * A regra que os separa é a razão de existirem: **zero e "não sei" são coisas
 * diferentes**. Uma lista vazia diz que não há nada; uma leitura que falhou diz
 * que não foi possível saber. Numa tela que mostra dinheiro, confundir as duas
 * é o pior erro possível — foi por isso que o endpoint do painel deixou de
 * engolir exceção, e a tela não pode reintroduzir o defeito do outro lado.
 */

function Moldura({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 text-center px-6 py-14 rounded-2xl"
      style={{ background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      {children}
    </div>
  );
}

export function EstadoCarregando({ mensagem = 'Carregando…' }: { mensagem?: string }) {
  return (
    <Moldura>
      <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--txt3)' }} aria-hidden />
      <output className="text-xs font-semibold" style={{ color: 'var(--txt2)' }}>
        {mensagem}
      </output>
    </Moldura>
  );
}

export function EstadoVazio({ titulo, descricao }: { titulo: string; descricao?: string }) {
  return (
    <Moldura>
      <Inbox className="w-5 h-5" style={{ color: 'var(--txt3)' }} aria-hidden />
      <p className="text-sm font-semibold" style={{ color: 'var(--txt)' }}>
        {titulo}
      </p>
      {descricao && (
        <p className="text-xs max-w-md" style={{ color: 'var(--txt3)' }}>
          {descricao}
        </p>
      )}
    </Moldura>
  );
}

export function EstadoDeErro({
  titulo,
  detalhe,
  onTentarDeNovo,
}: {
  titulo: string;
  detalhe?: string;
  onTentarDeNovo?: () => void;
}) {
  return (
    <Moldura>
      <AlertCircle className="w-5 h-5" style={{ color: 'var(--danger)' }} aria-hidden />
      <p className="text-sm font-semibold" role="alert" style={{ color: 'var(--danger)' }}>
        {titulo}
      </p>
      {detalhe && (
        <p className="text-xs max-w-md" style={{ color: 'var(--txt2)' }}>
          {detalhe}
        </p>
      )}
      {onTentarDeNovo && (
        <button type="button" onClick={onTentarDeNovo} className="orbita-chip cursor-pointer mt-1">
          Tentar de novo
        </button>
      )}
    </Moldura>
  );
}

/**
 * O aviso de que a **atualização** falhou, com dados bons ainda na tela.
 *
 * Diferente do `EstadoDeErro`: aqui existe uma leitura anterior válida, e
 * apagá-la para mostrar um erro trocaria informação verdadeira por nenhuma. Os
 * números continuam, com a ressalva de que envelheceram.
 */
export function AvisoDeAtualizacaoFalhada({
  detalhe,
  /** O que envelheceu, no plural e com artigo: "os pedidos", "o catálogo". */
  recurso = 'os pedidos',
}: {
  detalhe?: string;
  recurso?: string;
}) {
  return (
    <div
      className="flex items-start gap-2 px-4 py-2.5 rounded-xl text-xs"
      role="alert"
      style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--warning)' }}
    >
      <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
      <span>
        Não foi possível atualizar {recurso} agora — o que está na tela é a última leitura que deu certo.
        {detalhe ? ` (${detalhe})` : ''}
      </span>
    </div>
  );
}
