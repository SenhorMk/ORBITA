'use client';

import { useEffect, useState } from 'react';

/**
 * Quanto tempo passou desde `momento`, em texto curto.
 *
 * Só descreve o que é conhecido. Nunca arredonda para um horário que não
 * aconteceu, e nunca inventa "agora" quando não há nada registrado.
 */
export function descreverTempoDesde(momento: Date, agora: number = Date.now()): string {
  const segundos = Math.max(0, Math.floor((agora - momento.getTime()) / 1000));
  if (segundos < 60) return 'há instantes';
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

interface EstadoDaSincronizacaoProps {
  /**
   * Quando a última sincronização com o Bling **terminou com sucesso**, ou
   * `null` quando isso não é conhecido.
   *
   * O estado atual do produto só registra isso dentro da sessão em curso: o
   * valor volta a `null` a cada recarga da página. Por isso o texto de `null`
   * não afirma "nunca sincronizou" — ele diz que não há registro, que é a única
   * coisa verdadeira que se pode dizer daqui. Passar a ler a última
   * sincronização do servidor mudaria contrato de sync e é de outra fatia.
   */
  ultimaSincronizacao: Date | null;
  /** Se há uma sincronização em curso agora. */
  sincronizando?: boolean;
}

/**
 * O estado do Bling no topo da janela: ponto, rótulo e há quanto tempo.
 *
 * O ponto colorido nunca é a única pista — o texto ao lado diz a mesma coisa.
 */
export function EstadoDaSincronizacao({ ultimaSincronizacao, sincronizando = false }: EstadoDaSincronizacaoProps) {
  // O texto envelhece sozinho: sem este tique, "há 1 min" ficaria congelado até
  // que outra coisa qualquer redesenhasse a tela.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const intervalo = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(intervalo);
  }, []);

  const conhecido = ultimaSincronizacao !== null;
  const cor = sincronizando ? 'var(--info)' : conhecido ? 'var(--accent)' : 'var(--txt3)';

  const rotulo = sincronizando
    ? 'Sincronizando Bling'
    : conhecido
      ? 'Bling sincronizado'
      : 'Bling';

  const detalhe = sincronizando
    ? 'em andamento'
    : conhecido
      ? descreverTempoDesde(ultimaSincronizacao, agora)
      : 'sem sincronização registrada nesta sessão';

  return (
    <div
      className="flex items-center gap-2.5 rounded-xl px-3 py-1.5"
      style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cor }} aria-hidden />
      <span className="orbita-eyebrow">{rotulo}</span>
      <span className="text-xs font-semibold" style={{ color: 'var(--txt2)' }}>
        {detalhe}
      </span>
    </div>
  );
}
