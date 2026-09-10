/**
 * O estado de uma integração, **derivado só do que há evidência**.
 *
 * A tela mostrava `health_status` cru. Essa coluna nasce `'healthy'` por
 * default (`31_outbox_retries_saude_integracoes.sql`), então uma conexão que
 * nunca foi checada aparecia verde, com a palavra "healthy", só por existir a
 * linha. Salvar credenciais também marcava `status = 'conectado'` no Chatwoot,
 * e trocar as chaves do Bling deixava o `conectado` anterior de pé. Nos três
 * casos a tela afirmava saúde a partir de algo que não é prova de saúde.
 *
 * A prova é uma só: `last_health_check_at`. Sem ela, nada foi verificado, e o
 * estado honesto é dizer exatamente isso — e não pintar de verde.
 */

/** O que o servidor sabe sobre uma conexão, como `/api/integracoes/saude` a devolve. */
export interface ConexaoObservada {
  readonly status: string;
  readonly health_status: string;
  readonly last_health_check_at: string | null;
  readonly last_health_error: string | null;
  /** Se o passo 1 do Bling (client_id do aplicativo) está gravado no servidor. */
  readonly credenciais_configuradas: boolean;
}

export type NomeDoEstado =
  | 'nao-configurado'
  | 'configurado'
  | 'conectado'
  | 'nao-verificado'
  | 'erro';

export interface EstadoDaIntegracao {
  readonly nome: NomeDoEstado;
  readonly rotulo: string;
  readonly cor: string;
  /** O detalhe que sustenta o estado, quando existe. Nunca inventado. */
  readonly detalhe: string | null;
}

const NAO_CONFIGURADO: EstadoDaIntegracao = {
  nome: 'nao-configurado',
  rotulo: 'Não configurado',
  cor: 'var(--txt3)',
  detalhe: null,
};

const CONFIGURADO: EstadoDaIntegracao = {
  nome: 'configurado',
  rotulo: 'Configurado',
  cor: 'var(--info)',
  detalhe: 'Credenciais gravadas. Falta autorizar o acesso (Passo 2).',
};

const NAO_VERIFICADO: EstadoDaIntegracao = {
  nome: 'nao-verificado',
  rotulo: 'Não verificado',
  cor: 'var(--warning)',
  detalhe: 'Nenhuma verificação de saúde foi feita nesta conexão até agora.',
};

const CONECTADO: EstadoDaIntegracao = {
  nome: 'conectado',
  rotulo: 'Conectado',
  cor: 'var(--accent)',
  detalhe: null,
};

function comErro(conexao: ConexaoObservada): EstadoDaIntegracao {
  return {
    nome: 'erro',
    rotulo: 'Erro',
    cor: 'var(--danger)',
    detalhe: conexao.last_health_error,
  };
}

/**
 * O que a última verificação real disse, ou `null` se nunca houve uma.
 *
 * `last_health_check_at` é o portão: `health_status` só tem significado depois
 * que alguém de fato checou. Antes disso ele é apenas o default da coluna.
 */
function resultadoDaUltimaVerificacao(conexao: ConexaoObservada): EstadoDaIntegracao | null {
  if (conexao.last_health_check_at === null) return null;
  return conexao.health_status === 'healthy' ? CONECTADO : comErro(conexao);
}

/**
 * Estado do Bling: duas etapas, e nenhuma delas vale pela outra.
 *
 * Salvar Client ID/Secret **não** é estar autorizado. Quem declara `conectado`
 * é o callback OAuth, depois de gravar os tokens — e mesmo aí, saúde só existe
 * se alguém tiver verificado.
 */
export function estadoDoBling(conexao: ConexaoObservada | undefined): EstadoDaIntegracao {
  if (!conexao || !conexao.credenciais_configuradas) return NAO_CONFIGURADO;
  if (conexao.status !== 'conectado') return CONFIGURADO;
  return resultadoDaUltimaVerificacao(conexao) ?? NAO_VERIFICADO;
}

/**
 * Estado do Chatwoot: uma etapa só — a linha existe porque alguém salvou as
 * credenciais, e nada além disso é afirmado sem verificação.
 */
export function estadoDoChatwoot(conexao: ConexaoObservada | undefined): EstadoDaIntegracao {
  if (!conexao) return NAO_CONFIGURADO;
  return resultadoDaUltimaVerificacao(conexao) ?? NAO_VERIFICADO;
}
