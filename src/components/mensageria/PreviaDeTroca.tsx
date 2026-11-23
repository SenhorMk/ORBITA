'use client';

import { useState, type FormEvent } from 'react';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { ItemDoRetrato } from '@/lib/integrations/contratoDoRetrato';
import { PreviaDaTrocaSchema, SolicitacaoDeTrocaSchema, type PreviaDaTroca } from '@/lib/integrations/contratoDaPropostaDeTroca';
import { Aviso } from './Aviso';

const rotulos = {
  pedido: 'Pedido', item: 'Item', quantidade: 'Quantidade', quantidade_excede_item: 'Quantidade excede o item',
  motivo: 'Motivo', substituto: 'Substituto desejado', confirmar_cliente: 'Confirmar o cliente da conversa',
  frescor: 'Pedido sem sincronização atual', ranking: 'Substitutos elegíveis ainda não confirmados',
  politica: 'Política de elegibilidade pendente',
} as const;

export function PreviaDeTroca({ fetchWithAuth, conversaId, pedidoId, itens }: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly conversaId: string;
  readonly pedidoId: string;
  readonly itens: readonly ItemDoRetrato[];
}) {
  const [iniciado, setIniciado] = useState(false);
  const [previa, setPrevia] = useState<PreviaDaTroca | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function preparar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const quantidade = form.get('quantidade');
    const dados = SolicitacaoDeTrocaSchema.safeParse({
      conversaId, pedidoId, tipo: form.get('tipo'),
      itemId: form.get('item') || undefined, motivo: form.get('motivo') || undefined,
      quantidade: quantidade ? Number(quantidade) : undefined,
      substitutoPretendido: form.get('substituto') || undefined,
    });
    setPrevia(null);
    if (!dados.success) {
      setErro('Confira a quantidade e os demais dados.');
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      const resposta = await fetchWithAuth('/api/sac/trocas/previa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados.data),
      });
      const lido = await resposta.json();
      const resultado = PreviaDaTrocaSchema.safeParse(lido);
      if (!resposta.ok || !resultado.success) throw new Error('Não foi possível conferi-la neste caso.');
      setPrevia(resultado.data);
    } catch {
      setErro('Não foi possível preparar a prévia. Confira o caso e a verificação do cliente.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <details className="text-xs" onToggle={e => { if (e.currentTarget.open) setIniciado(true); }}>
      <summary className="cursor-pointer">Preparar troca ou devolução</summary>
      {iniciado && <form className="mt-2 grid gap-2" onSubmit={preparar}>
        <fieldset className="grid gap-2" disabled={enviando}>
          <label>Solicitação <select name="tipo" className="orbita-campo"><option value="troca">Troca</option><option value="devolucao">Devolução</option></select></label>
          <label>Item <select name="item" className="orbita-campo max-w-full"><option value="">A confirmar</option>
            {itens.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
          </select></label>
          <label>Quantidade <input name="quantidade" type="number" min={1} max={10_000} step={1} className="orbita-campo w-20" /></label>
          <label>Motivo <select name="motivo" className="orbita-campo"><option value="">A confirmar</option>
            <option value="avaria">Avaria</option><option value="defeito">Defeito</option>
            <option value="arrependimento">Arrependimento</option><option value="outro">Outro</option>
          </select></label>
          <label>Substituto desejado <input name="substituto" maxLength={120} className="orbita-campo max-w-full" /></label>
          <button type="submit" className="orbita-chip justify-self-start">{enviando ? 'Conferindo…' : 'Conferir prévia'}</button>
        </fieldset>
      </form>}
      {erro && <Aviso tom="erro">{erro}</Aviso>}
      {previa && <ResumoDaPrevia previa={previa} />}
    </details>
  );
}

function ResumoDaPrevia({ previa }: { readonly previa: PreviaDaTroca }) {
  const item = previa.pedido?.item;
  return (
    <section className="mt-2 grid gap-1 break-words" aria-label="Prévia da proposta" aria-live="polite">
      <strong>Prévia para conferência</strong>
      <span>Sem gravação ou aprovação nesta etapa.</span>
      <span>Caso {previa.casoId}</span>
      {previa.pedido && <span>Pedido {previa.pedido.numero ?? 'sem número'} · Espelho Bling · Atualizado em {new Date(previa.pedido.sincronizadoEm).toLocaleString('pt-BR')}</span>}
      {item && <span>{item.nome} · {item.quantidadeComprada} no pedido · {(item.precoUnitarioCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: item.moeda })} por unidade no pedido</span>}
      {previa.proximaPergunta && <span>Pergunta sugerida: {previa.proximaPergunta.pergunta}</span>}
      <span>Pendências: {previa.pendencias.map((p) => rotulos[p]).join(', ')}.</span>
    </section>
  );
}
