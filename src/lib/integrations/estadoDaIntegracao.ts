/**
 * O estado de uma integração, **derivado só do que há evidência**.
 *
 * `health_status` sozinho não é prova: a coluna nasce `'healthy'` por default
 * (`31_outbox_retries_saude_integracoes.sql`), então uma conexão nunca checada
 * pareceria saudável só por existir a linha. `status = 'conectado'` também não
 * prova saúde — diz que credenciais foram salvas ou autorizadas.
 *
 * A prova é uma só: `last_health_check_at`. Sem ela, nada foi verificado, e o
 * estado honesto é dizer exatamente isso — e não pintar de verde.
 *
 * ## Evidência antiga não é estado atual
 *
 * Um `last_health_check_at` não nulo diz que houve uma verificação, não que a
 * integração está saudável agora: tratá-lo como "Conectado" apresentaria dado
 * velho como fato presente.
 *
 * O caminho óbvio seria um TTL — "verificação vale por N minutos". **Não
 * existe cadência de health neste projeto**: `last_health_check_at` só é
 * escrito pelas funções de entrega do outbox
 * (`48_outbox_lease_correlacao.sql`), que rodam quando há tráfego real, e não
 * de tempos em tempos. Não há job, cron ou intervalo configurado. Inventar um
 * número aqui seria escolher, por conta própria, quando o produto passa a
 * mentir mais devagar.
 *
 * Então a evidência é apresentada como o que ela é: **histórico, com data**.
 * "Última verificação OK em 10/09/2026 12:00 UTC" é verdade para sempre;
 * "Conectado" é uma afirmação sobre agora que nada aqui sustenta. Quando o
 * produto ganhar uma cadência real de verificação, este módulo é o único lugar
 * que precisa saber disso.
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
  | 'verificado'
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

/**
 * O Bling depois do OAuth, antes de qualquer verificação.
 *
 * A autorização é um fato: os tokens foram gravados. Saúde é outro, e não
 * existe ainda — por isso a pílula continua dizendo "Não verificado", e quem
 * conta a metade boa é o detalhe.
 */
const AUTORIZADO_NAO_VERIFICADO: EstadoDaIntegracao = {
  ...NAO_VERIFICADO,
  detalhe: 'Autorização concluída e tokens gravados. Nenhuma verificação de saúde foi feita até agora.',
};

/**
 * O instante de uma verificação, em texto que não depende do fuso de quem lê.
 *
 * `toLocaleString` mudaria de resultado entre o navegador do lojista, o do
 * suporte e o do teste. A data é evidência: ela precisa ser a mesma para todo
 * mundo que a citar.
 */
export function instanteDaVerificacao(iso: string): string | null {
  const quando = new Date(iso);
  if (Number.isNaN(quando.getTime())) return null;
  const dois = (valor: number) => String(valor).padStart(2, '0');
  return `${dois(quando.getUTCDate())}/${dois(quando.getUTCMonth() + 1)}/${quando.getUTCFullYear()}`
    + ` ${dois(quando.getUTCHours())}:${dois(quando.getUTCMinutes())} UTC`;
}

/** "Verificado": houve uma checagem real e ela passou. Não diz nada sobre agora. */
function verificadoEm(iso: string): EstadoDaIntegracao {
  const quando = instanteDaVerificacao(iso);
  return {
    nome: 'verificado',
    // Deliberadamente **não** "Conectado": esta é a última notícia, não o
    // estado atual. Nada aqui prova que a integração responde neste instante.
    rotulo: 'Verificado',
    cor: 'var(--info)',
    detalhe: quando
      ? `Última verificação OK em ${quando}. Não há verificação contínua: isto é a última notícia, não o estado de agora.`
      : 'Última verificação OK, em data não legível.',
  };
}

function comErro(conexao: ConexaoObservada, iso: string): EstadoDaIntegracao {
  const quando = instanteDaVerificacao(iso);
  const motivo = conexao.last_health_error ? `: ${conexao.last_health_error}` : '.';
  return {
    nome: 'erro',
    rotulo: 'Erro',
    cor: 'var(--danger)',
    detalhe: quando ? `Última verificação falhou em ${quando}${motivo}` : `Última verificação falhou${motivo}`,
  };
}

/**
 * O que a última verificação real disse, ou `null` se nunca houve uma.
 *
 * `last_health_check_at` é o portão: `health_status` só tem significado depois
 * que alguém de fato checou. Antes disso ele é apenas o default da coluna.
 */
function resultadoDaUltimaVerificacao(conexao: ConexaoObservada): EstadoDaIntegracao | null {
  const quando = conexao.last_health_check_at;
  if (quando === null) return null;
  return conexao.health_status === 'healthy' ? verificadoEm(quando) : comErro(conexao, quando);
}

/**
 * Estado do Bling: duas etapas, e nenhuma delas vale pela outra.
 *
 * Salvar Client ID/Secret **não** é estar autorizado. Quem declara `conectado`
 * é o callback OAuth, depois de gravar os tokens — e mesmo aí a tela não diz
 * "Conectado": autorização não é saúde, e a última verificação não é agora.
 */
export function estadoDoBling(conexao: ConexaoObservada | undefined): EstadoDaIntegracao {
  if (!conexao || !conexao.credenciais_configuradas) return NAO_CONFIGURADO;
  if (conexao.status !== 'conectado') return CONFIGURADO;
  return resultadoDaUltimaVerificacao(conexao) ?? AUTORIZADO_NAO_VERIFICADO;
}

/**
 * Estado do Chatwoot: uma etapa só — a linha existe porque alguém salvou as
 * credenciais, e nada além disso é afirmado sem verificação.
 */
export function estadoDoChatwoot(conexao: ConexaoObservada | undefined): EstadoDaIntegracao {
  if (!conexao) return NAO_CONFIGURADO;
  return resultadoDaUltimaVerificacao(conexao) ?? NAO_VERIFICADO;
}
