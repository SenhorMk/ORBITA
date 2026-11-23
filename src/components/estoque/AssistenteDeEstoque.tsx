'use client';

import { useState, type FormEvent } from 'react';
import { MessageSquare } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { fetchWithAuth } from '@/lib/fetchWithAuth';

type Resposta = {
  mensagem: string;
  produto?: { nome: string; codigo: string | null; fisico: number; reservado: number; disponivel: number };
  candidatos?: { nome: string; codigo: string | null }[];
};

export function AssistenteDeEstoque() {
  const [aberto, setAberto] = useState(false);
  const [pergunta, setPergunta] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resposta, setResposta] = useState<Resposta | null>(null);

  async function perguntar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (enviando || pergunta.trim().length < 4) return;
    setEnviando(true);
    setResposta(null);
    try {
      const consulta = await fetchWithAuth('/api/assistente/estoque', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pergunta }),
      });
      const resultado = await consulta.json();
      const mensagem = resultado.mensagem ?? resultado.error;
      setResposta(consulta.ok && typeof mensagem === 'string' ? resultado :
        { mensagem: typeof mensagem === 'string' ? mensagem : 'Não foi possível consultar o estoque agora.' });
    } catch {
      setResposta({ mensagem: 'Não foi possível consultar o estoque. Confira sua sessão e tente novamente.' });
    } finally {
      setEnviando(false);
    }
  }

  return <>
    <button type="button" className="orbita-chip cursor-pointer" onClick={() => setAberto(true)}>
      <MessageSquare className="w-4 h-4" aria-hidden /> Assistente de estoque
    </button>
    <Modal aberto={aberto} onAbertoChange={setAberto} titulo="Assistente de estoque"
      descricao="Consulte o saldo disponível no ORBITA por nome ou SKU." descricaoOculta={false}>
      <form onSubmit={perguntar} className="flex flex-col gap-3">
        <label htmlFor="assistente-estoque-pergunta">Pergunta</label>
        <textarea id="assistente-estoque-pergunta" className="orbita-campo min-h-20 py-2" rows={3}
          placeholder="Quanto temos em estoque do produto X?" maxLength={240}
          value={pergunta} onChange={evento => setPergunta(evento.target.value)} readOnly={enviando} />
        <button className="orbita-chip self-start cursor-pointer" type="submit"
          disabled={enviando || pergunta.trim().length < 4}>{enviando ? 'Consultando…' : 'Consultar'}</button>
      </form>
      <div className="mt-4 space-y-2 break-words">
        {resposta?.produto && <p className="font-semibold">
          {resposta.produto.nome}{resposta.produto.codigo ? ' · SKU ' + resposta.produto.codigo : ''}
        </p>}
        <output className="block" aria-live="polite">{resposta?.mensagem}</output>
        {resposta?.produto && <p>Saldo físico: {resposta.produto.fisico}. Reservado: {resposta.produto.reservado}.</p>}
        {resposta?.candidatos && <ul className="list-disc pl-5">
          {resposta.candidatos.map(({ nome, codigo }, i) => <li key={i}>{nome}{codigo ? ' · SKU ' + codigo : ''}</li>)}
        </ul>}
      </div>
    </Modal>
  </>;
}
