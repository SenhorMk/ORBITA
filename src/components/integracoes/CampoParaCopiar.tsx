'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Um endereço decidido pelo servidor, pronto para ser colado **fora** do ORBITA.
 *
 * Os dois casos são o mesmo caso: a URL de retorno do OAuth vai para o cadastro
 * do aplicativo no Bling, a URL do webhook vai para a configuração no Chatwoot.
 * Nos dois, o valor vem do servidor e nunca de `window.location.origin` — num
 * deploy de preview a origem do navegador é um host efêmero, e um endereço
 * cadastrado lá fora quebra no próximo deploy.
 */
export function CampoParaCopiar({
  rotulo,
  valor,
  rotuloDoBotao,
}: {
  readonly rotulo: string;
  readonly valor: string;
  readonly rotuloDoBotao: string;
}) {
  const [copiado, setCopiado] = useState(false);
  const [falhaAoCopiar, setFalhaAoCopiar] = useState(false);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (temporizador.current) clearTimeout(temporizador.current);
  }, []);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(valor);
      setFalhaAoCopiar(false);
      setCopiado(true);
      if (temporizador.current) clearTimeout(temporizador.current);
      temporizador.current = setTimeout(() => setCopiado(false), 2000);
    } catch {
      // O navegador pode recusar a área de transferência. Dizer isso é melhor
      // que um "Copiado" que não copiou nada.
      setFalhaAoCopiar(true);
    }
  }

  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <span className="orbita-eyebrow">{rotulo}</span>
      <div className="flex items-center" style={{ gap: 8 }}>
        <input
          readOnly
          value={valor}
          aria-label={rotulo}
          onFocus={(evento) => evento.currentTarget.select()}
          className="orbita-campo orbita-campo--mono flex-1 min-w-0"
        />
        <button type="button" onClick={() => { void copiar(); }} className="orbita-acao shrink-0" aria-label={rotuloDoBotao}>
          {copiado ? <><Check className="w-4 h-4" /> Copiado</> : <><Copy className="w-4 h-4" /> Copiar</>}
        </button>
      </div>
      {falhaAoCopiar && (
        <p role="alert" className="text-xs" style={{ color: 'var(--warning)' }}>
          O navegador não permitiu copiar automaticamente. Selecione o endereço acima e copie à mão.
        </p>
      )}
    </div>
  );
}
