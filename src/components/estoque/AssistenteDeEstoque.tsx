'use client';

import { useState, type FormEvent } from 'react';
import { MessageSquare } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import type { PropostaDeBaixa, ReciboDeBaixa } from '@/services/assistenteAdministrativo/baixaDeDemonstracao';

type Resposta = {
  mensagem: string;
  produto?: { id: string; nome: string; codigo: string | null; fisico: number; reservado: number; disponivel: number };
  candidatos?: { nome: string; codigo: string | null }[];
};

export function AssistenteDeEstoque() {
  const [aberto, setAberto] = useState(false);
  const [pergunta, setPergunta] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resposta, setResposta] = useState<Resposta | null>(null);
  const [produtoConsultado, setProdutoConsultado] = useState<string>();
  const [proposta, setProposta] = useState<PropostaDeBaixa | null>(null);
  const [recibo, setRecibo] = useState<ReciboDeBaixa | null>(null);

  async function confirmar() {
    if (!proposta || enviando) return;
    setEnviando(true);
    setResposta(null);
    try {
      const retorno = await fetchWithAuth('/api/assistente/estoque/confirmar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chave: proposta.chave }),
      });
      const dados = await retorno.json();
      if (retorno.ok && dados.estado === 'baixado') {
        setRecibo(dados.recibo);
        setProposta(null);
      } else {
        setResposta({ mensagem: dados.mensagem ?? 'Confirmação indisponível. Tente a mesma proposta.' });
      }
    } catch {
      setResposta({ mensagem: 'O resultado ainda não foi confirmado. Tente a mesma proposta.' });
    } finally {
      setEnviando(false);
    }
  }

  async function perguntar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (enviando || proposta || pergunta.trim().length < 4) return;
    setRecibo(null);
    setEnviando(true);
    setResposta(null);
    try {
      const consulta = await fetchWithAuth('/api/assistente/estoque', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pergunta, produtoConsultado }),
      });
      const resultado = await consulta.json();
      if (consulta.ok && resultado.estado === 'proposta') {
        setProposta(resultado.proposta);
        return;
      }
      if (consulta.ok && resultado.produto) setProdutoConsultado(resultado.produto.id);
      else if (resultado.estado === 'ambiguo' || resultado.estado === 'sem_produto') setProdutoConsultado(undefined);
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
          disabled={enviando || proposta !== null || pergunta.trim().length < 4}>{enviando ? 'Consultando…' : 'Consultar'}</button>
      </form>
      <div className="mt-4 space-y-2 break-words">
        {proposta && <section className="space-y-2" aria-label="Proposta de baixa">
          <p className="font-semibold">Confirmar baixa de {proposta.quantidade} unidade de {proposta.produto}?</p>
          <p>Saldo disponível na proposta: {proposta.saldoDisponivel}.</p>
          <div className="flex flex-wrap gap-2">
            <button className="orbita-chip" type="button" disabled={enviando} onClick={confirmar}>Confirmar baixa</button>
            <button className="orbita-chip" type="button" disabled={enviando} onClick={() => { setProposta(null); setResposta(null); }}>Cancelar</button>
          </div>
        </section>}
        {recibo && <div className="space-y-2">
          <output className="block" aria-live="polite">Baixa registrada. Novo saldo disponível: {recibo.saldoDisponivel}.</output>
          <p>Auditoria: <code>{recibo.auditoriaId}</code></p>
        </div>}
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
