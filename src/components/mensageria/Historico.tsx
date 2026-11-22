'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';

import { EstadoCarregando, EstadoDeErro, EstadoVazio } from '@/components/ui/estados';
import { horaCurta } from './Avatar';
import type { MensagemOtimista } from './estadoDaConversa';
import { montarLinhaDoTempo, type ItemDaLinhaDoTempo } from './linhaDoTempo';
import type { Mensageria } from './useMensageria';
import estilos from './mensageria.module.css';

/** A partir de quantos pixels do fim a leitura conta como "lendo mensagens antigas". */
const DISTANCIA_DO_FIM_PX = 96;

/** Uma mensagem do espelho — histórico de verdade, já registrado. */
function BolhaDoHistorico({ item }: { readonly item: Extract<ItemDaLinhaDoTempo, { tipo: 'mensagem' }> }) {
  const { autoria, mensagem, continuacao } = item;
  const hora = horaCurta(mensagem.created_at);
  const texto = mensagem.content.trim() === ''
    ? <em style={{ color: 'var(--txt3)' }}>Mensagem sem texto</em>
    : mensagem.content;

  if (autoria.tipo === 'sistema') {
    return (
      <p className={estilos.sistema}>
        <span className="sr-only">Evento do sistema: </span>
        {texto}
        {hora && <span style={{ marginLeft: 6 }}>· {hora}</span>}
      </p>
    );
  }

  const autor = (
    <>
      {autoria.rotulo}
      {autoria.detalhe !== null && <span className={estilos.autorDetalhe}>{autoria.detalhe}</span>}
    </>
  );
  return (
    <article className={estilos.mensagem} data-lado={autoria.tipo === 'cliente' ? 'esquerda' : 'direita'} data-continuacao={continuacao}>
      {continuacao
        ? <span className="sr-only">{autoria.rotulo}{autoria.detalhe ? ` (${autoria.detalhe})` : ''}</span>
        : <span className={estilos.autor}>{autor}</span>}
      <div className={estilos.bolha} data-autor={autoria.tipo}>
        <p className={estilos.texto}>{texto}</p>
        {hora && (
          <span className={estilos.rodapeDaBolha}>
            <time dateTime={mensagem.created_at}>{hora}</time>
          </span>
        )}
      </div>
    </article>
  );
}

/** O rótulo, a cor e a frase de cada estado de um envio que ainda não é histórico. */
const APRESENTACAO_DO_ENVIO: Readonly<Record<MensagemOtimista['estado'], { readonly rotulo: string; readonly cor: string; readonly nota: string | null }>> = {
  enviando: { rotulo: 'Enviando…', cor: 'var(--txt3)', nota: null },
  pendente: { rotulo: 'Na fila de envio', cor: 'var(--txt3)', nota: 'Registrada. Aparece como enviada quando o Chatwoot confirmar.' },
  sem_resposta: { rotulo: 'Sem resposta do servidor', cor: 'var(--warning)', nota: 'Tentar de novo repete o mesmo pedido: não cria uma segunda mensagem.' },
  falhou: { rotulo: 'Não enviada', cor: 'var(--danger)', nota: 'O servidor recusou o pedido: nada foi registrado nem enviado.' },
  incerta: { rotulo: 'Entrega não confirmada', cor: 'var(--warning)', nota: null },
  recusada: { rotulo: 'Recusada pelo Chatwoot', cor: 'var(--danger)', nota: 'O Chatwoot não aplicou esta mensagem. Corrija a causa antes de enviar de novo.' },
  invalidada: { rotulo: 'Não enviada', cor: 'var(--danger)', nota: 'O atendimento mudou de responsável antes do envio; nada saiu.' },
};

/**
 * Uma mensagem que ainda não é histórico — e que não pode parecer que é.
 *
 * O contorno tracejado e o rótulo dizem o estado real. Ela só vira histórico
 * quando o worker grava o recibo do Chatwoot (MSG-008); até lá, nenhum estado
 * afirma entrega. Só aparece botão onde agir é seguro: repetir o mesmo comando
 * (sem resposta) ou reescrever o que comprovadamente não saiu (falhou,
 * recusada). Desconhecida não tem botão: pode ter chegado. "Você" só quando
 * este navegador fez o pedido; o que voltou da fila do servidor é "Atendimento".
 */
function BolhaNaoConfirmada({
  otimista,
  aoTentarDeNovo,
  aoRecuperar,
}: {
  readonly otimista: MensagemOtimista;
  readonly aoTentarDeNovo: () => void;
  readonly aoRecuperar: () => void;
}) {
  const { rotulo, cor, nota } = APRESENTACAO_DO_ENVIO[otimista.estado];
  const emAndamento = otimista.estado === 'enviando' || otimista.estado === 'pendente';
  return (
    <article className={estilos.envio}>
      <span className={estilos.autor}>
        {otimista.local ? 'Você' : 'Atendimento'}
        {horaCurta(otimista.criadaEm) && <span className={estilos.autorDetalhe}>{horaCurta(otimista.criadaEm)}</span>}
      </span>
      <div className={estilos.bolhaDoEnvio} style={{ borderColor: emAndamento ? 'var(--bar)' : cor }}>
        <span className={estilos.estadoDoEnvio} style={{ color: cor }}>
          <span className={estilos.ponto} style={{ background: cor }} aria-hidden />
          <span>{rotulo}</span>
        </span>
        <p className={estilos.texto} style={{ color: 'var(--txt2)' }}>{otimista.conteudo}</p>
        {otimista.erro !== null && (
          <output className="m-0 block" role={otimista.estado === 'falhou' ? 'alert' : undefined} style={{ fontSize: 11.5, color: 'var(--txt2)' }}>
            {otimista.erro}
          </output>
        )}
        {nota !== null && <p className={estilos.notaDoEnvio}>{nota}</p>}
        {otimista.estado === 'sem_resposta' && (
          <button type="button" onClick={aoTentarDeNovo} className="orbita-chip cursor-pointer self-start" style={{ height: 28, fontSize: 11 }}>
            Tentar de novo
          </button>
        )}
        {(otimista.estado === 'falhou' || otimista.estado === 'recusada' || otimista.estado === 'invalidada') && (
          <button type="button" onClick={aoRecuperar} className="orbita-chip cursor-pointer self-start" style={{ height: 28, fontSize: 11 }}>
            Recuperar texto
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * O histórico rolável, com carregando, erro e vazio distintos entre si.
 *
 * Ele desce sozinho para o fim só quando o operador já está no fim (ou acabou
 * de enviar daqui). Quem está lendo mensagens antigas não é arrancado de onde
 * está: aparece um botão para ir às recentes, com quantas chegaram.
 */
export function Historico({ mensageria }: { readonly mensageria: Mensageria }) {
  const area = useRef<HTMLDivElement | null>(null);
  const noFim = useRef(true);
  const totalAnterior = useRef(0);
  const [longeDoFim, setLongeDoFim] = useState(false);
  const [vistasAte, setVistasAte] = useState(0);
  const { historico, otimistas, selecionada } = mensageria;
  const nomeDoContato = selecionada?.contact?.name ?? null;
  const itens = useMemo(() => montarLinhaDoTempo(historico, nomeDoContato), [historico, nomeDoContato]);
  const total = historico.length + otimistas.length;
  const ultimoEnvio = otimistas.at(-1);
  const acabouDeEnviar = ultimoEnvio !== undefined && ultimoEnvio.local && ultimoEnvio.estado === 'enviando';
  const estadosDosEnvios = otimistas.map((o) => o.estado).join(',');

  // Rolar pelo `scrollTop` da própria área, e não por `scrollIntoView`: é a
  // mesma rolagem, sem depender de uma API que o jsdom não implementa.
  useLayoutEffect(() => {
    const elemento = area.current;
    const cresceu = total > totalAnterior.current;
    totalAnterior.current = total;
    if (elemento === null) return;
    if (noFim.current || (cresceu && acabouDeEnviar)) {
      elemento.scrollTop = elemento.scrollHeight;
      noFim.current = true;
    }
  }, [total, acabouDeEnviar, estadosDosEnvios, mensageria.carregandoHistorico]);

  const aoRolar = () => {
    const elemento = area.current;
    if (elemento === null) return;
    const perto = elemento.scrollHeight - elemento.scrollTop - elemento.clientHeight <= DISTANCIA_DO_FIM_PX;
    noFim.current = perto;
    // Ao sair do fim, tudo o que havia até ali já tinha sido visto.
    if ((perto || !longeDoFim) && vistasAte !== total) setVistasAte(total);
    if (perto !== !longeDoFim) setLongeDoFim(!perto);
  };

  const irParaAsRecentes = () => {
    const elemento = area.current;
    if (elemento === null) return;
    elemento.scrollTop = elemento.scrollHeight;
    noFim.current = true;
    setLongeDoFim(false);
    setVistasAte(total);
  };

  const novas = longeDoFim ? Math.max(0, total - vistasAte) : 0;
  const vazio =
    !mensageria.carregandoHistorico &&
    mensageria.erroDeHistorico === null &&
    historico.length === 0 &&
    otimistas.length === 0;

  return (
    <div className={estilos.historicoMoldura}>
      <div ref={area} onScroll={aoRolar} className={estilos.historico} role="log" aria-label="Histórico da conversa">
        {mensageria.carregandoHistorico && <EstadoCarregando mensagem="Lendo o histórico desta conversa…" />}

        {mensageria.erroDeHistorico !== null && (
          <EstadoDeErro
            titulo="Não foi possível ler o histórico"
            detalhe={mensageria.erroDeHistorico}
            onTentarDeNovo={mensageria.recarregarHistorico}
          />
        )}

        {vazio && (
          <EstadoVazio
            titulo="Conversa sem mensagens"
            descricao="Esta conversa existe no espelho, mas não tem nenhuma mensagem registrada."
          />
        )}

        {itens.map((item) => (item.tipo === 'dia'
          ? <p key={item.chave} className={estilos.dia}>{item.rotulo}</p>
          : <BolhaDoHistorico key={item.chave} item={item} />))}

        {otimistas.map((otimista) => (
          <BolhaNaoConfirmada
            key={otimista.id}
            otimista={otimista}
            aoTentarDeNovo={() => mensageria.tentarDeNovo(otimista.id)}
            aoRecuperar={() => mensageria.recuperarRascunho(otimista.id)}
          />
        ))}
      </div>

      {longeDoFim && (
        <button type="button" onClick={irParaAsRecentes} className={estilos.irParaRecentes}>
          <ArrowDown className="w-3.5 h-3.5" aria-hidden />
          {novas > 0 ? `Ir para as recentes · ${novas} ${novas === 1 ? 'nova' : 'novas'}` : 'Ir para as recentes'}
        </button>
      )}
    </div>
  );
}
