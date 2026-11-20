import type { ChatwootAdapter } from './chatwootAdapter';
import type { CanalDeProjecaoAiFirst, OpcoesDoWorkerAiFirst } from './workerAiFirst';

/** One channel for one verified ORBITA scope and one configured inbox. */
export function criarCanalAiFirst(config: {
  escopo: OpcoesDoWorkerAiFirst['escopo'];
  inbox: number;
  tecnico: number;
  resolver: () => Promise<ChatwootAdapter | null>;
  fetchImpl?: typeof fetch;
}): CanalDeProjecaoAiFirst {
  let atual: ChatwootAdapter | null = null;
  const mesmoEscopo = (e: OpcoesDoWorkerAiFirst['escopo']) => e.p_org === config.escopo.p_org
    && e.p_conexao === config.escopo.p_conexao && e.p_executor === config.escopo.p_executor;
  function obter(e: OpcoesDoWorkerAiFirst['escopo'], inbox: number) {
    if (!mesmoEscopo(e) || !atual || inbox !== config.inbox) throw new Error('Canal AI-first fora do escopo verificado.');
    return atual;
  }
  return {
    async pronto(escopo) {
      atual = null;
      if (!mesmoEscopo(escopo)) return false;
      const candidato = await config.resolver();
      if (!candidato || candidato.conexaoId !== escopo.p_conexao) return false;
      if (!await candidato.validarAdministradorDaProjecao(config.inbox, config.tecnico, config.fetchImpl)) return false;
      atual = candidato;
      return true;
    },
    ler(escopo, item) {
      return obter(escopo, item.inbox_id).lerEstadoDaProjecao(item.id_externo,
        config.inbox, item.account_id, config.tecnico, config.fetchImpl);
    },
    alterarSemAtribuir(escopo, item, status) {
      return obter(escopo, item.inbox_id).projetarStatusComoAdministrador(item.id_externo,
        config.inbox, item.account_id, config.tecnico, status, config.fetchImpl);
    },
  };
}
