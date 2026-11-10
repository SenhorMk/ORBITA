'use client';

/**
 * DEMONSTRAÇÃO — dados fictícios, nenhuma chamada de rede.
 *
 * A mesma tela de Mensageria do produto (`MensageriaVisual`), alimentada por um
 * estado local em vez do espelho do Chatwoot. Existe para gravação de vídeo;
 * nada aqui lê ou escreve em banco, Chatwoot ou Bling.
 */

import { useEffect, useRef, useState } from 'react';

import { MensageriaVisual } from '@/components/mensageria/MensageriaDesktop';
import type { Mensageria } from '@/components/mensageria/useMensageria';
import type { MensagemOtimista } from '@/components/mensageria/estadoDaConversa';
import { AppWindow } from '@/components/shell/AppWindow';
import { Rail } from '@/components/shell/Rail';
import type { ChatwootConversation, ChatwootMessage } from '@/types';

const AGORA = Date.now();
const haMinutos = (minutos: number) => new Date(AGORA - minutos * 60_000).toISOString();

function conversa(id: string, nome: string, telefone: string, status: string, minutos: number): ChatwootConversation {
  return {
    id_local: id,
    contato_id_local: id,
    status,
    channel: 'whatsapp',
    updated_at: haMinutos(minutos),
    contact: { id_local: id, name: nome, phone_number: telefone } as ChatwootConversation['contact'],
  };
}

const CONVERSAS_INICIAIS: ChatwootConversation[] = [
  conversa('c1', 'Mariana Souza', '+55 11 98842-1107', 'open', 2),
  conversa('c2', 'Auto Peças Ribeiro', '+55 31 99731-4420', 'open', 9),
  conversa('c3', 'Lucas Andrade', '+55 21 99610-7734', 'open', 26),
  conversa('c4', 'Mercado Bom Preço', '+55 41 98455-0912', 'open', 58),
  conversa('c5', 'Camila Ferraz', '+55 11 97120-3388', 'resolved', 190),
  conversa('c6', 'Distribuidora Aurora', '+55 62 99288-6601', 'resolved', 420),
];

type Fala = readonly ['in' | 'out', string, number];

const ROTEIROS: Record<string, { nome: string; falas: readonly Fala[] }> = {
  c1: {
    nome: 'Mariana Souza',
    falas: [
      ['in', 'Oi! Fiz o pedido #10482 ontem e queria saber se já saiu para entrega.', 14],
      ['out', 'Oi, Mariana! Vou conferir agora mesmo no sistema, só um instante.', 12],
      ['out', 'Encontrei: o pedido #10482 foi faturado hoje cedo e a nota fiscal já foi emitida.', 11],
      ['in', 'Que ótimo! E vocês ainda têm o kit de pastilhas dianteiras? Queria incluir mais um.', 6],
      ['out', 'Temos sim, 14 unidades em estoque. Posso abrir um novo pedido com o mesmo endereço?', 4],
      ['in', 'Pode sim, por favor! Mesmo endereço e mesma forma de pagamento.', 2],
    ],
  },
  c2: {
    nome: 'Auto Peças Ribeiro',
    falas: [
      ['in', 'Bom dia, preciso de uma cotação para 40 filtros de óleo.', 31],
      ['out', 'Bom dia! Para 40 unidades conseguimos R$ 18,90 cada, com frete incluso.', 24],
      ['in', 'Fechado. Pode faturar no CNPJ de sempre?', 9],
    ],
  },
  c3: {
    nome: 'Lucas Andrade',
    falas: [
      ['in', 'O boleto do pedido #10455 venceu, consegue gerar outro?', 40],
      ['out', 'Consigo sim, Lucas. Já atualizei o vencimento para sexta-feira.', 26],
    ],
  },
  c4: {
    nome: 'Mercado Bom Preço',
    falas: [
      ['in', 'Vocês entregam em Curitiba ainda esta semana?', 70],
      ['out', 'Entregamos! Pedidos fechados até quarta chegam na sexta.', 58],
    ],
  },
  c5: {
    nome: 'Camila Ferraz',
    falas: [
      ['in', 'Recebi o pedido certinho, obrigada!', 200],
      ['out', 'Que bom, Camila! Qualquer coisa é só chamar.', 190],
    ],
  },
  c6: {
    nome: 'Distribuidora Aurora',
    falas: [
      ['in', 'Podem reenviar a nota fiscal do pedido #10398?', 430],
      ['out', 'Reenviada para o e-mail do cadastro.', 420],
    ],
  },
};

function mensagem(conversaId: string, idx: number, tipo: 'in' | 'out', texto: string, minutos: number, nome: string): ChatwootMessage {
  return {
    id_local: `${conversaId}-${idx}`,
    conversa_id_local: conversaId,
    content: texto,
    message_type: tipo === 'out' ? 'outgoing' : 'incoming',
    sender_name: tipo === 'out' ? 'Você' : nome,
    created_at: haMinutos(minutos),
  };
}

const HISTORICOS_INICIAIS: Record<string, ChatwootMessage[]> = Object.fromEntries(
  Object.entries(ROTEIROS).map(([id, { nome, falas }]) => [
    id,
    falas.map(([tipo, texto, minutos], idx) => mensagem(id, idx, tipo, texto, minutos, nome)),
  ]),
);

/** O que o "cliente" responde depois que o atendente envia, em rodízio. */
const RESPOSTAS = [
  'Perfeito, muito obrigada! 🙌',
  'Combinado. Fico no aguardo da confirmação.',
  'Show, atendimento rápido demais. Valeu!',
];

function useMensageriaDemo(): Mensageria {
  const [conversas, setConversas] = useState(CONVERSAS_INICIAIS);
  const [historicos, setHistoricos] = useState(HISTORICOS_INICIAIS);
  const [selecionadaId, setSelecionadaId] = useState<string | null>('c1');
  const [rascunho, setRascunho] = useState('');
  const [otimistas, setOtimistas] = useState<MensagemOtimista[]>([]);
  const [sincronizando, setSincronizando] = useState(false);
  const contador = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const depois = (ms: number, acao: () => void) => timers.current.push(setTimeout(acao, ms));

  const selecionada = conversas.find((c) => c.id_local === selecionadaId) ?? null;

  const acrescentar = (conversaId: string, tipo: 'in' | 'out', texto: string) => {
    const agora = new Date().toISOString();
    contador.current += 1;
    const nova: ChatwootMessage = {
      id_local: `${conversaId}-n${contador.current}`,
      conversa_id_local: conversaId,
      content: texto,
      message_type: tipo === 'out' ? 'outgoing' : 'incoming',
      sender_name: tipo === 'out' ? 'Você' : ROTEIROS[conversaId]?.nome,
      created_at: agora,
    };
    setHistoricos((atual) => ({ ...atual, [conversaId]: [...(atual[conversaId] ?? []), nova] }));
    setConversas((atual) => {
      const alvo = atual.find((c) => c.id_local === conversaId);
      if (!alvo) return atual;
      return [{ ...alvo, updated_at: agora }, ...atual.filter((c) => c.id_local !== conversaId)];
    });
  };

  const enviar = () => {
    const texto = rascunho.trim();
    if (texto === '' || selecionada === null) return;
    const conversaId = selecionada.id_local;
    contador.current += 1;
    const id = -contador.current;
    const resposta = RESPOSTAS[contador.current % RESPOSTAS.length];
    setRascunho('');
    setOtimistas((atual) => [...atual, { id, commandId: `demo-${id}`, conteudo: texto, estado: 'enviando', erro: null, criadaEm: new Date().toISOString() }]);
    depois(700, () => {
      setOtimistas((atual) => atual.filter((o) => o.id !== id));
      acrescentar(conversaId, 'out', texto);
    });
    depois(3200, () => acrescentar(conversaId, 'in', resposta));
  };

  return {
    conversas,
    carregandoConversas: false,
    erroDeConversas: null,
    recarregarConversas: () => {},
    selecionada,
    selecionar: (c) => setSelecionadaId(c?.id_local ?? null),
    historico: selecionada ? (historicos[selecionada.id_local] ?? []) : [],
    otimistas,
    carregandoHistorico: false,
    erroDeHistorico: null,
    recarregarHistorico: () => {},
    rascunho,
    escreverRascunho: setRascunho,
    enviando: otimistas.length > 0,
    enviar,
    tentarDeNovo: () => {},
    recuperarRascunho: () => {},
    alterandoStatus: false,
    alternarStatus: () => {
      if (selecionada === null) return;
      setConversas((atual) =>
        atual.map((c) =>
          c.id_local === selecionada.id_local ? { ...c, status: c.status === 'open' ? 'resolved' : 'open' } : c,
        ),
      );
    },
    sincronizando,
    sincronizar: () => {
      setSincronizando(true);
      depois(1400, () => setSincronizando(false));
    },
    avisoDaSincronizacao: null,
    integracaoIndisponivel: null,
    tempoRealDeConversas: true,
    tempoRealDeMensagens: true,
  };
}

export default function DemoDaMensageria() {
  const mensageria = useMensageriaDemo();

  return (
    <AppWindow>
      <Rail
        activeTab="sac"
        setActiveTab={() => {}}
        session={{ email: 'demo@orbita.app', name: 'Demonstração' }}
        onLogout={() => {}}
      />
      <div className="orbita-conteudo">
        <main className="flex-1 min-h-0 flex flex-col">
          <MensageriaVisual mensageria={mensageria} />
        </main>
      </div>
    </AppWindow>
  );
}
