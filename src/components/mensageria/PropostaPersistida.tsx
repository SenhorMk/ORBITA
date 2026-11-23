'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { ItemDoRetrato } from '@/lib/integrations/contratoDoRetrato';
import { EntradaDaPropostaSchema, ResultadoDaDecisaoSchema, ResultadoDaLeituraSchema, type ComandoDeProposta, type PropostaAtual } from '@/lib/integrations/contratoPersistenciaDaTroca';
import { z } from 'zod';
import { Aviso } from './Aviso';

const alternativasSchema = z.object({ alternativas: z.array(z.object({
  produtoId: z.string().uuid(), nome: z.string(), precoUnitarioCentavos: z.number().int(), deltaTotalCentavos: z.number().int(),
})).max(3) });
type Alternativas = z.infer<typeof alternativasSchema>['alternativas'];

type Props = {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly conversaId: string;
  readonly pedidoId: string;
  readonly itens: readonly ItemDoRetrato[];
};

const mensagens: Record<string, string> = {
  sem_permissao: 'Você não tem permissão para essa decisão.',
  nao_encontrado: 'O caso SAC está indisponível.',
  referencia_sem_prova: 'Confirme o cliente e o vínculo do pedido antes de gravar.',
  conflito: 'A versão mudou. Atualize a proposta antes de tentar novamente.',
  ja_decidida: 'A versão já foi decidida.',
  vencida: 'A versão expirou. Salve uma nova versão para revisão.',
  fatos_alterados: 'Os dados verificados mudaram. Revise e salve uma nova versão.',
  operacao_divergente: 'A operação diverge do recibo original.',
  bloqueada: 'As pendências impedem a aprovação.',
  impossivel_ler: 'Não foi possível carregar a proposta.',
};

const pendencias: Record<string, string> = {
  pedido: 'Pedido', item: 'Item', quantidade: 'Quantidade', quantidade_excede_item: 'Quantidade acima da comprada',
  motivo: 'Motivo', confirmar_cliente: 'Verificação do cliente', frescor: 'Pedido desatualizado',
  politica: 'Política D7', compatibilidade: 'Compatibilidade do substituto', frescor_catalogo: 'Catálogo desatualizado',
  substituto_indisponivel: 'Substituto sem disponibilidade',
};

function moeda(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function PropostaPersistida(props: Props) {
  const [aberta, setAberta] = useState(false);
  return (
    <details className="grid gap-2 text-xs" onToggle={e => setAberta(e.currentTarget.open)}>
      <summary className="cursor-pointer">Proposta e decisão de troca</summary>
      {aberta && <EditorDaProposta {...props} />}
    </details>
  );
}

type AcaoSemId<T = ComandoDeProposta> = T extends ComandoDeProposta ? Omit<T, 'operacaoId'> : never;

function EditorDaProposta({ fetchWithAuth, conversaId, pedidoId, itens }: Props) {
  const [proposta, setProposta] = useState<PropostaAtual | null>(null);
  const [carregada, setCarregada] = useState(false);
  const [ocupada, setOcupada] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [alternativas, setAlternativas] = useState<Alternativas | null>(null);
  const operacao = useRef<{ assinatura: string; id: string } | null>(null);
  const formulario = useRef<HTMLFormElement>(null);

  const consultar = useCallback(async () => {
    const resposta = await fetchWithAuth('/api/sac/trocas/proposta?' + new URLSearchParams({ conversaId }));
    const dados = ResultadoDaLeituraSchema.safeParse(await resposta.json());
    if (!resposta.ok || !dados.success) throw new Error('impossivel_ler');
    return dados.data.estado === 'ok' ? dados.data : null;
  }, [fetchWithAuth, conversaId]);

  function receberProposta(dados: PropostaAtual | null) {
    setErro(null);
    setProposta(dados);
    setCarregada(true);
  }

  function reportarFalhaDeLeitura() {
    setCarregada(false);
    setErro(mensagens.impossivel_ler);
  }

  async function ler() {
    try {
      receberProposta(await consultar());
    } catch {
      reportarFalhaDeLeitura();
    }
  }

  useEffect(() => {
    let vigente = true;
    void consultar().then(
      dados => { if (vigente) receberProposta(dados); },
      () => { if (vigente) reportarFalhaDeLeitura(); },
    );
    return () => { vigente = false; };
  }, [consultar]);

  async function executar(acao: AcaoSemId) {
    if (ocupada) return;
    const assinatura = JSON.stringify(acao);
    if (operacao.current?.assinatura !== assinatura) operacao.current = { assinatura, id: crypto.randomUUID() };
    setErro(null);
    setOcupada(true);
    try {
      const r = await fetchWithAuth('/api/sac/trocas/proposta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...acao, operacaoId: operacao.current.id }),
      });
      const lido = ResultadoDaDecisaoSchema.safeParse(await r.json());
      if (!r.ok || !lido.success || lido.data.estado !== 'ok') {
        setErro(lido.success ? mensagens[lido.data.estado] ?? 'Operação indisponível.' : 'Resultado indisponível. Tente novamente.');
        return;
      }
      operacao.current = null;
      setAlternativas(null);
      await ler();
    } catch {
      setErro('Resultado indisponível. Tente novamente.');
    } finally {
      setOcupada(false);
    }
  }

  function salvar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const anterior = proposta?.entrada;
    const substituto = form.get('substituto');
    const quantidade = form.get('quantidade') ? Number(form.get('quantidade')) : undefined;
    const podeManterSubstituto = substituto === null && anterior?.pedidoId === pedidoId
      && form.get('item') === anterior.itemId && quantidade === anterior.quantidade;
    const entrada = EntradaDaPropostaSchema.safeParse({
      pedidoId, tipo: form.get('tipo'), itemId: form.get('item') || undefined,
      quantidade,
      motivo: form.get('motivo') || undefined,
      substitutoId: form.get('tipo') === 'troca' ? (podeManterSubstituto ? anterior?.substitutoId : substituto || undefined) : undefined,
    });
    if (!entrada.success) {
      setErro('Confira os dados do rascunho.');
      return;
    }
    void executar(proposta === null
      ? { acao: 'criar', conversaId, entrada: entrada.data }
      : { acao: 'editar', conversaId, versao: proposta.versao, digest: proposta.digest, entrada: entrada.data });
  }

  async function buscarAlternativas() {
    if (!formulario.current) return;
    const form = new FormData(formulario.current);
    const itemId = form.get('item');
    const quantidade = Number(form.get('quantidade'));
    if (typeof itemId !== 'string' || !itemId || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 10_000) {
      setErro('Escolha o item e informe a quantidade antes de consultar alternativas.');
      return;
    }
    setOcupada(true);
    setErro(null);
    setAlternativas(null);
    try {
      const q = new URLSearchParams({ conversaId, pedidoId, itemId, quantidade: String(quantidade) });
      const r = await fetchWithAuth('/api/sac/trocas/proposta?' + q);
      const dados = alternativasSchema.safeParse(await r.json());
      if (!r.ok || !dados.success) throw new Error('alternativas_indisponiveis');
      setAlternativas(dados.data.alternativas);
    } catch {
      setErro('Não foi possível comprovar alternativas para os dados informados.');
    } finally {
      setOcupada(false);
    }
  }

  function limparAlternativas(e: ChangeEvent<HTMLFormElement>) {
    const alvo: EventTarget = e.target;
    if ((alvo instanceof HTMLInputElement || alvo instanceof HTMLSelectElement)
        && ['item', 'tipo', 'quantidade'].includes(alvo.name)) setAlternativas(null);
  }

  const outroPedido = proposta?.entrada.pedidoId !== undefined && proposta.entrada.pedidoId !== pedidoId;
  const entrada = outroPedido ? undefined : proposta?.entrada;
  const decisao = (acao: 'aprovar' | 'rejeitar') => {
    if (proposta) void executar({ acao, conversaId, versao: proposta.versao, digest: proposta.digest });
  };

  return (
    <section className="mt-2 grid gap-2" aria-label="Proposta persistida">
      {erro && <Aviso tom="erro">{erro}</Aviso>}
      {carregada && proposta && <div className="grid gap-1" aria-live="polite">
        <strong>Versão {proposta.versao} · {proposta.situacao}</strong>
        <span>Validade até {new Date(proposta.expiraEm).toLocaleString('pt-BR')}</span>
        {proposta.situacao === 'aprovada' && <strong>Proposta aprovada, troca ainda não executada.</strong>}
        {proposta.fatosAlterados && <span>Os fatos mudaram. Salve uma nova versão antes de aprovar.</span>}
        {proposta.pendencias.length > 0 && <span>Pendências: {proposta.pendencias.map(p => pendencias[p] ?? p).join(', ')}.</span>}
        {outroPedido && <span>Abra o pedido vinculado à proposta para editá-la ou decidir.</span>}
      </div>}
      {carregada && !outroPedido && <form key={proposta?.versao ?? 0} ref={formulario} onSubmit={salvar} onChange={limparAlternativas}>
        <fieldset className="grid gap-2" disabled={ocupada}>
          <label>Tipo da proposta <select name="tipo" className="orbita-campo" defaultValue={entrada?.tipo ?? 'troca'}>
            <option value="troca">Troca</option><option value="devolucao">Devolução</option>
          </select></label>
          <label>Item da proposta <select name="item" className="orbita-campo max-w-full" defaultValue={entrada?.itemId ?? ''}>
            <option value="">A confirmar</option>{itens.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
          </select></label>
          <label>Quantidade da proposta <input name="quantidade" type="number" min={1} max={10_000} step={1} className="orbita-campo w-20" defaultValue={entrada?.quantidade} /></label>
          <label>Motivo da proposta <select name="motivo" className="orbita-campo" defaultValue={entrada?.motivo ?? ''}>
            <option value="">A confirmar</option><option value="avaria">Avaria</option><option value="defeito">Defeito</option>
            <option value="arrependimento">Arrependimento</option><option value="outro">Outro</option>
          </select></label>
          <button type="button" className="orbita-chip justify-self-start" onClick={() => void buscarAlternativas()}>Conferir alternativas elegíveis</button>
          {alternativas?.length === 0 && <span>Nenhum substituto elegível confirmado.</span>}
          {alternativas && alternativas.length > 0 && <label>Substituto elegível
            <select name="substituto" className="orbita-campo max-w-full" defaultValue={entrada?.substitutoId ?? ''}>
              <option value="">A confirmar</option>
              {alternativas.map(a => <option key={a.produtoId} value={a.produtoId}>
                {a.nome} · {moeda(a.precoUnitarioCentavos)} por unidade · diferença de {moeda(a.deltaTotalCentavos)}
              </option>)}
            </select>
          </label>}
          <button type="submit" className="orbita-chip justify-self-start">{proposta ? 'Salvar nova versão' : 'Salvar rascunho'}</button>
        </fieldset>
      </form>}
      {carregada && !outroPedido && <div className="flex flex-wrap gap-2">
        {proposta?.podeAprovar && <button type="button" className="orbita-chip" disabled={ocupada} onClick={() => decisao('aprovar')}>Aprovar proposta</button>}
        {proposta?.podeRejeitar && <button type="button" className="orbita-chip" disabled={ocupada} onClick={() => decisao('rejeitar')}>Rejeitar proposta</button>}
      </div>}
      <button type="button" className="orbita-chip justify-self-start" disabled={ocupada} onClick={() => void ler()}>Recarregar proposta</button>
    </section>
  );
}
