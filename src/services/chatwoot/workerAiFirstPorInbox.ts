import type { BancoDoWorkerAiFirst, CanalDeProjecaoAiFirst, OpcoesDoWorkerAiFirst } from './workerAiFirst';

/** Shares the existing AI engine while each inbox proves its own readiness. */
export function criarWorkerAiFirstPorInbox(config: {
  escopo: OpcoesDoWorkerAiFirst['escopo'];
  banco: BancoDoWorkerAiFirst;
  canais: ReadonlyMap<number, CanalDeProjecaoAiFirst>;
}) {
  if (!config.canais.size) throw new Error('Configure ao menos uma inbox.');
  const prontos = new Map<number, boolean>();
  const mesmoEscopo = (args: Record<string, unknown>) => args.p_org === config.escopo.p_org
    && args.p_conexao === config.escopo.p_conexao && args.p_executor === config.escopo.p_executor;
  const obter = (escopo: OpcoesDoWorkerAiFirst['escopo'], inbox: number) => {
    if (!mesmoEscopo(escopo) || !prontos.get(inbox)) throw new Error('Inbox indisponível no escopo do worker.');
    const canal = config.canais.get(inbox);
    if (!canal) throw new Error('Inbox não configurada.');
    return canal;
  };
  const canal: CanalDeProjecaoAiFirst = {
    async pronto(escopo) {
      prontos.clear();
      if (!mesmoEscopo(escopo)) return false;
      await Promise.all([...config.canais].map(async ([inbox, item]) => {
        let pronto = false;
        try { pronto = await item.pronto(escopo); } catch { /* Leave only this inbox unavailable. */ }
        prontos.set(inbox, pronto);
      }));
      return [...prontos.values()].some(Boolean);
    },
    ler(escopo, item) { return obter(escopo, item.inbox_id).ler(escopo, item); },
    alterarSemAtribuir(escopo, item, status) {
      return obter(escopo, item.inbox_id).alterarSemAtribuir(escopo, item, status);
    },
  };
  const banco: BancoDoWorkerAiFirst = {
    async rpc(nome, args) {
      if (!mesmoEscopo(args)) return { data: null, error: 'Escopo do worker inválido.' };
      if (nome !== 'renovar_worker_ai_first') return config.banco.rpc(nome, args);
      const resultados = await Promise.all([...config.canais.keys()].map(p_inbox => config.banco.rpc(
        'renovar_worker_ai_first_inbox', {
          ...config.escopo, p_inbox, p_pronto: args.p_pronto === true && prontos.get(p_inbox) === true,
        },
      )));
      if (resultados.some(r => r.error)) return { data: null, error: 'Renovação de inbox não confirmada.' };
      return { data: resultados.some(r => r.data === true), error: null };
    },
  };
  return { canal, banco };
}
