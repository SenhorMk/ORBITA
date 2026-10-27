'use client';

import { useState, type ReactNode } from 'react';
import { Building2, MessageCircle, RefreshCw, ShoppingBag } from 'lucide-react';

import { Pilula } from '@/components/ui/StatusPill';
import { EstadoCarregando, EstadoVazio } from '@/components/ui/estados';
import { buildBlingCredentialsPayload } from '@/lib/config/blingCredentialsContract';
import { estadoDoBling, estadoDoChatwoot, type EstadoDaIntegracao } from '@/lib/integrations/estadoDaIntegracao';
import { chaveDaSelecao } from '@/components/organizacao/useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import { CampoParaCopiar } from './CampoParaCopiar';
import { EnviosComAtencao } from './EnviosComAtencao';
import { comPrazo } from './comPrazo';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { useIntegracoes, type LeituraDeIntegracoes } from './useIntegracoes';

/**
 * Falha de uma acao do painel, com o status HTTP junto da mensagem.
 *
 * Sem o status, `401`, `403` e `500` chegam indistinguiveis a quem esta
 * configurando — foi exatamente o que impediu diagnosticar por que as
 * credenciais do Bling nao salvavam. `0` marca "a requisicao nem chegou".
 */
interface Falha {
  readonly status: number;
  readonly mensagem: string;
}

/** Extrai a falha da resposta sem depender de o corpo ser JSON. */
async function lerFalha(resposta: Response): Promise<Falha> {
  try {
    const corpo = await resposta.json();
    return { status: resposta.status, mensagem: typeof corpo?.error === 'string' ? corpo.error : 'A requisição falhou.' };
  } catch {
    return { status: resposta.status, mensagem: 'O servidor respondeu em um formato inesperado.' };
  }
}

/** A falha de rede ou de timeout, que nao tem status HTTP nenhum. */
function falhaDeRede(causa: unknown, quando: string): Falha {
  return { status: 0, mensagem: causa instanceof Error && causa.message ? causa.message : quando };
}

function Erro({ falha }: { readonly falha: Falha | null }) {
  if (!falha) return null;
  return (
    <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
      <strong>{falha.status === 0 ? 'Sem resposta' : `HTTP ${falha.status}`}</strong> — {falha.mensagem}
    </p>
  );
}

/** O estado da integracao, com a evidencia que o sustenta logo abaixo. */
function EstadoDoProvedor({ estado }: { readonly estado: EstadoDaIntegracao }) {
  return (
    <div className="flex flex-col items-end flex-none" style={{ gap: 4 }}>
      <Pilula rotulo={estado.rotulo} cor={estado.cor} />
      {estado.detalhe && (
        <span className="text-[11px] text-right" style={{ color: 'var(--txt3)', maxWidth: 280 }}>
          {estado.detalhe}
        </span>
      )}
    </div>
  );
}

/** Um cartao de provedor: cabecalho com o estado real, e a configuracao abaixo. */
function Cartao({
  icone,
  titulo,
  estado,
  children,
}: {
  readonly icone: ReactNode;
  readonly titulo: string;
  readonly estado: EstadoDaIntegracao;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col min-w-0"
      style={{ gap: 14, padding: 16, borderRadius: 20, background: 'var(--glass2)', border: '1px solid var(--line)' }}
    >
      <header className="flex items-start justify-between" style={{ gap: 12 }}>
        <h2
          className="flex items-center m-0"
          style={{ gap: 7, font: '600 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
        >
          {icone}
          {titulo}
        </h2>
        <EstadoDoProvedor estado={estado} />
      </header>
      {children}
    </section>
  );
}

/** Um passo numerado dentro de um cartao. */
function Passo({
  numero,
  titulo,
  children,
}: {
  readonly numero: number;
  readonly titulo: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: 8,
        paddingTop: numero > 1 ? 14 : 0,
        borderTop: numero > 1 ? '1px solid var(--line)' : undefined,
      }}
    >
      <span className="orbita-eyebrow">Passo {numero} — {titulo}</span>
      {children}
    </div>
  );
}

/** Um campo de formulario do Design System, com o rotulo acima. */
function Campo({
  id,
  rotulo,
  valor,
  aoMudar,
  secreto = false,
  obrigatorio = true,
  desabilitado = false,
  ajuda,
}: {
  readonly id: string;
  readonly rotulo: string;
  readonly valor: string;
  readonly aoMudar: (valor: string) => void;
  readonly secreto?: boolean;
  readonly obrigatorio?: boolean;
  readonly desabilitado?: boolean;
  readonly ajuda?: string;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 5 }}>
      <label htmlFor={id} className="orbita-eyebrow">{rotulo}</label>
      <input
        id={id}
        // Segredos sao sempre `password`: eles nao podem ser lidos por cima do
        // ombro nem capturados por uma captura de tela de suporte.
        type={secreto ? 'password' : 'text'}
        value={valor}
        onChange={(evento) => aoMudar(evento.target.value)}
        autoComplete="off"
        required={obrigatorio}
        disabled={desabilitado}
        className="orbita-campo"
      />
      {ajuda && <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>{ajuda}</span>}
    </div>
  );
}

interface CartaoProps {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly leitura: LeituraDeIntegracoes;
  /** A organizacao ativa desta tela. Acompanha toda escrita, para o servidor recusar se ela mudar. */
  readonly organizacaoId: string;
  readonly podeGerir: boolean;
  readonly recarregar: () => Promise<void>;
}

/**
 * Bling: duas etapas, e nenhuma delas vale pela outra.
 *
 * O Passo 1 grava o Client ID e o Client Secret do aplicativo da organizacao;
 * o Passo 2 faz o OAuth de verdade. Salvar as chaves **nao** e estar
 * autorizado — quem declara `conectado` e o callback, ao gravar tokens reais,
 * e mesmo ai so uma verificacao real produz "Conectado" na tela.
 */
function CartaoBling({
  fetchWithAuth,
  leitura,
  organizacaoId,
  podeGerir,
  recarregar,
  irPara,
}: CartaoProps & { readonly irPara: (url: string) => void }) {
  const conexao = leitura.conexoes.find((c) => c.provedor === 'bling');
  const estado = estadoDoBling(conexao);
  const credenciaisGravadas = conexao?.credenciais_configuradas ?? false;

  const [clientId, setClientId] = useState('');
  // O Client Secret existe aqui **so enquanto esta sendo digitado**. Nunca vai
  // para storage, nunca entra em URL, e sai do estado assim que o servidor
  // confirma que o guardou cifrado. A troca de organizacao e o logout destroem
  // este componente inteiro (ver a `key` em `IntegrationsPanel`), entao nao
  // existe caminho em que ele sobreviva a uma delas.
  const [clientSecret, setClientSecret] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [autorizando, setAutorizando] = useState(false);
  // Uma falha por passo: quando os dois compartilhavam o mesmo estado, clicar
  // no Passo 2 apagava a mensagem do Passo 1 — a causa real sumia da tela
  // antes de alguem conseguir le-la.
  const [falhaAoSalvar, setFalhaAoSalvar] = useState<Falha | null>(null);
  const [falhaAoAutorizar, setFalhaAoAutorizar] = useState<Falha | null>(null);

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    setSalvando(true);
    setFalhaAoSalvar(null);
    setFalhaAoAutorizar(null);
    try {
      const resposta = await comPrazo(fetchWithAuth, '/api/bling/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A organizacao vai junto para o servidor **recusar** a escrita se ela
        // ja tiver mudado. Ela nunca concede nada: a autoridade continua sendo
        // a sessao verificada.
        body: JSON.stringify(buildBlingCredentialsPayload(clientId, clientSecret, organizacaoId)),
      });
      if (!resposta.ok) {
        setFalhaAoSalvar(await lerFalha(resposta));
        return;
      }
      const corpo = await resposta.json();
      if (!corpo.success) {
        setFalhaAoSalvar({ status: resposta.status, mensagem: corpo.error ?? 'Falha ao salvar as credenciais do Bling.' });
        return;
      }
      // O segredo sai do formulario assim que o servidor confirma que o
      // guardou cifrado, e nao antes: limpar na hora do envio perderia o que o
      // usuario digitou se a requisicao falhasse.
      setClientSecret('');
      await recarregar();
    } catch (causa) {
      setFalhaAoSalvar(falhaDeRede(causa, 'Falha de rede ao salvar as credenciais.'));
    } finally {
      setSalvando(false);
    }
  }

  async function autorizar() {
    setAutorizando(true);
    setFalhaAoAutorizar(null);
    try {
      const resposta = await comPrazo(
        fetchWithAuth,
        `/api/bling/authorize?organizacao_esperada=${encodeURIComponent(organizacaoId)}`,
      );
      if (!resposta.ok) {
        setFalhaAoAutorizar(await lerFalha(resposta));
        return;
      }
      const corpo = await resposta.json();
      if (!corpo.success || typeof corpo.authorizeUrl !== 'string') {
        setFalhaAoAutorizar({ status: resposta.status, mensagem: corpo.error ?? 'Falha ao iniciar a autorização no Bling.' });
        return;
      }
      irPara(corpo.authorizeUrl);
    } catch (causa) {
      setFalhaAoAutorizar(falhaDeRede(causa, 'Falha de rede ao iniciar a autorização.'));
    } finally {
      setAutorizando(false);
    }
  }

  return (
    <Cartao
      icone={<ShoppingBag className="w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />}
      titulo="Bling ERP"
      estado={estado}
    >
      <form onSubmit={salvar} className="flex flex-col" style={{ gap: 10 }}>
        <Passo numero={1} titulo="credenciais do seu aplicativo no Bling">
          {credenciaisGravadas && (
            <p className="text-[11px]" style={{ color: 'var(--txt3)' }}>
              Já existem credenciais gravadas para esta organização. Preencher de novo substitui as
              anteriores — e derruba a autorização atual, porque os tokens guardados pertencem ao Client ID
              antigo.
            </p>
          )}
          <Campo id="bling-client-id" rotulo="Client ID do Bling" valor={clientId} aoMudar={setClientId} desabilitado={!podeGerir} />
          <Campo
            id="bling-client-secret"
            rotulo="Client Secret do Bling"
            valor={clientSecret}
            aoMudar={setClientSecret}
            secreto
            desabilitado={!podeGerir}
            ajuda="Guardado cifrado no servidor. Depois de salvo ele não volta a ser exibido."
          />
          {leitura.blingCallbackUrl ? (
            <CampoParaCopiar
              rotulo="URL de retorno, para colar no cadastro do aplicativo no Bling"
              valor={leitura.blingCallbackUrl}
              rotuloDoBotao="Copiar URL de callback"
            />
          ) : (
            <p role="alert" className="text-xs" style={{ color: 'var(--warning)' }}>
              A origem pública do ORBITA ainda não está configurada no servidor, então a URL de retorno não
              pode ser informada com segurança. Defina <code>APP_BASE_URL</code> com o domínio estável e
              recarregue. Cadastrar uma URL de preview no Bling faz a conexão quebrar no próximo deploy.
            </p>
          )}
          <button type="submit" className="orbita-acao w-fit" disabled={salvando || !podeGerir}>
            {salvando ? 'Salvando…' : 'Salvar credenciais do Bling'}
          </button>
          <Erro falha={falhaAoSalvar} />
        </Passo>

        <Passo numero={2} titulo="autorizar o acesso (OAuth)">
          {!credenciaisGravadas && (
            <p className="text-[11px]" style={{ color: 'var(--txt3)' }}>
              Disponível depois que o Passo 1 for salvo — a autorização precisa do Client ID gravado no servidor.
            </p>
          )}
          <button
            type="button"
            onClick={() => { void autorizar(); }}
            className="orbita-acao w-fit"
            style={credenciaisGravadas && podeGerir
              ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }
              : undefined}
            disabled={autorizando || !credenciaisGravadas || !podeGerir}
          >
            {autorizando ? 'Conectando…' : 'Conectar Bling'}
          </button>
          <p className="text-[11px]" style={{ color: 'var(--txt3)' }}>
            Conclua a autorização nesta mesma aba e neste mesmo endereço: o retorno precisa chegar com o
            cookie da transação, que é gravado onde o fluxo começa. Você tem 30 minutos para concluir.
          </p>
          <Erro falha={falhaAoAutorizar} />
        </Passo>
      </form>
    </Cartao>
  );
}

/**
 * Chatwoot: uma etapa so — as credenciais da instancia, e o endereco do
 * webhook que o Chatwoot deve chamar de volta.
 *
 * Salvar aqui nao prova que a instancia responde, que o token vale ou que a
 * conta existe. Enquanto ninguem tiver verificado, o estado e "Nao verificado"
 * — e nao um verde decorativo.
 */
function CartaoChatwoot({ fetchWithAuth, leitura, organizacaoId, podeGerir, recarregar }: CartaoProps) {
  const conexao = leitura.conexoes.find((c) => c.provedor === 'chatwoot');
  const estado = estadoDoChatwoot(conexao);

  const [apiUrl, setApiUrl] = useState('');
  // Token e segredo do webhook seguem a mesma regra do Client Secret do Bling.
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [falha, setFalha] = useState<Falha | null>(null);
  /** A URL devolvida pelo salvamento, enquanto a releitura nao chega. */
  const [webhookUrlSalva, setWebhookUrlSalva] = useState<string | null>(null);

  const webhookUrl = leitura.chatwootWebhookUrl ?? webhookUrlSalva;

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    setSalvando(true);
    setFalha(null);
    try {
      const resposta = await comPrazo(fetchWithAuth, '/api/chatwoot/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_url: apiUrl.trim() || undefined,
          api_token: apiToken,
          account_id: accountId.trim(),
          webhook_secret: webhookSecret,
          organizacao_esperada: organizacaoId,
        }),
      });
      if (!resposta.ok) {
        // Timeout, 502 do proxy, HTML de erro: tudo cai aqui como falha
        // recuperavel, com o status na tela. Antes, `response.json()` num corpo
        // que nao era JSON lancava e o clique morria em silencio.
        setFalha(await lerFalha(resposta));
        return;
      }
      const corpo = await resposta.json();
      if (!corpo.success) {
        setFalha({ status: resposta.status, mensagem: corpo.error ?? 'Falha ao salvar as credenciais do Chatwoot.' });
        return;
      }
      setApiToken('');
      setWebhookSecret('');
      if (typeof corpo.webhookUrl === 'string') setWebhookUrlSalva(corpo.webhookUrl);
      await recarregar();
    } catch (causa) {
      setFalha(falhaDeRede(causa, 'Falha de rede ao salvar as credenciais do Chatwoot.'));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Cartao
      icone={<MessageCircle className="w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />}
      titulo="Chatwoot"
      estado={estado}
    >
      <form onSubmit={salvar} className="flex flex-col" style={{ gap: 10 }}>
        <Campo
          id="chatwoot-url"
          rotulo="URL da instância Chatwoot"
          valor={apiUrl}
          aoMudar={setApiUrl}
          obrigatorio={false}
          desabilitado={!podeGerir}
        />
        <Campo
          id="chatwoot-token"
          rotulo="Token da API"
          valor={apiToken}
          aoMudar={setApiToken}
          secreto
          desabilitado={!podeGerir}
          ajuda="Guardado cifrado no servidor. Depois de salvo ele não volta a ser exibido."
        />
        <Campo id="chatwoot-account" rotulo="ID da conta" valor={accountId} aoMudar={setAccountId} desabilitado={!podeGerir} />
        <Campo
          id="chatwoot-webhook-secret"
          rotulo="Segredo do webhook"
          valor={webhookSecret}
          aoMudar={setWebhookSecret}
          secreto
          desabilitado={!podeGerir}
        />
        <button type="submit" className="orbita-acao w-fit" disabled={salvando || !podeGerir}>
          {salvando ? 'Salvando…' : 'Salvar credenciais do Chatwoot'}
        </button>
        <Erro falha={falha} />
      </form>

      {webhookUrl && (
        <CampoParaCopiar
          rotulo="URL do webhook, para colar na configuração do Chatwoot"
          valor={webhookUrl}
          rotuloDoBotao="Copiar URL do webhook"
        />
      )}
    </Cartao>
  );
}

/** A faixa que diz de quem e tudo o que vem abaixo. */
function FaixaDeContexto({ nome }: { readonly nome: string | null }) {
  return (
    <div
      className="flex items-center flex-none"
      style={{
        gap: 10,
        padding: '12px 16px',
        borderRadius: 16,
        background: 'var(--chip)',
        border: `1px solid ${nome ? 'var(--accent)' : 'var(--line)'}`,
      }}
    >
      <Building2 className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
      <span className="flex flex-col min-w-0" style={{ gap: 2 }}>
        <span className="orbita-eyebrow">Organização ativa</span>
        <span
          className="truncate"
          style={{ font: '600 14px/1.2 var(--font-archivo), sans-serif', color: nome ? 'var(--txt)' : 'var(--txt3)' }}
        >
          {nome ?? 'Nenhuma organização ativa'}
        </span>
      </span>
    </div>
  );
}

export interface IntegrationsPanelProps {
  /** Busca autenticada, com o bearer da sessao anexado por quem chama. */
  readonly fetchWithAuth: AuthenticatedFetch;
  /**
   * A organizacao ativa e a versao que a selecionou, ou `null` sem selecao
   * (inclusive sem sessao). E a mesma fonte unica usada pelo shell — esta tela
   * nao cria uma segunda.
   */
  readonly selecao: SelecaoDeOrganizacao | null;
  /** O nome da organizacao ativa, so para a faixa de contexto. */
  readonly nomeDaOrganizacao?: string | null;
  /** Se quem olha administra a organizacao. Aparencia: o servidor recusa de novo. */
  readonly podeGerir?: boolean;
  /** Seam de navegacao, para os testes nunca dispararem um redirect real. */
  readonly onRedirect?: (url: string) => void;
}

/**
 * Aba Integracoes.
 *
 * ## As tres regras que desenham esta tela
 *
 * **Nada de verde sem prova.** `health_status` nasce `'healthy'` por default da
 * coluna, e a tela mostrava exatamente esse default: uma conexao nunca checada
 * aparecia saudavel. O estado agora e derivado por
 * `estadoDaIntegracao.ts`, que so aceita `last_health_check_at` como
 * evidencia. Sem verificacao, o estado e "Nao verificado" — dito com todas as
 * letras, e nao escondido atras de uma cor.
 *
 * **Segredo nao mora aqui.** Client Secret, token da API e segredo do webhook
 * existem no estado do React enquanto estao sendo digitados, em campos
 * `password`, e saem assim que o servidor confirma que os guardou cifrados.
 * Nenhum deles vai para storage, para URL, para log, nem volta em resposta.
 * A `key` da secao carrega a selecao de organizacao: trocar de organizacao ou
 * sair da sessao destroi os cartoes, e com eles todo segredo em digitacao —
 * nao ha uma limpeza a ser lembrada, porque nao ha o que limpar.
 *
 * **Nenhuma espera e infinita.** `fetchWithAuth` nao tem timeout, e `fetch`
 * tambem nao: uma requisicao travada deixaria "Salvando..." na tela para
 * sempre. Toda operacao desta tela passa por `comPrazo`, que e local a
 * Integracoes — o seam global continua sem prazo, porque ele tambem carrega as
 * sincronizacoes longas do Bling.
 *
 * **Uma operacao pertence a organizacao que a comecou.** A leitura e carimbada
 * pelo par (organizacao, versao) da selecao ativa, entao a resposta atrasada de A
 * nunca aparece em B. As escritas levam a organizacao esperada junto, e o
 * servidor as recusa se ela ja tiver mudado — a resposta atrasada tambem nao
 * *grava* em B.
 */
export function IntegrationsPanel({
  fetchWithAuth,
  selecao,
  nomeDaOrganizacao = null,
  podeGerir = true,
  onRedirect,
}: IntegrationsPanelProps) {
  const irPara = onRedirect ?? ((url: string) => { window.location.href = url; });
  const integracoes = useIntegracoes(fetchWithAuth, selecao);
  const chave = chaveDaSelecao(selecao);

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ gap: 'var(--conteudo-gap)' }}>
      <div className="flex items-start gap-8 flex-none">
        <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
          <h1
            className="m-0"
            style={{
              fontFamily: 'var(--font-space-grotesk), sans-serif',
              fontWeight: 500,
              fontSize: 'var(--titulo-fs)',
              lineHeight: 1.04,
              letterSpacing: '-0.03em',
              color: 'var(--txt)',
            }}
          >
            Integrações
          </h1>
          <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
            o que o ORBITA conversa por fora, e o que já foi provado
          </span>
        </div>
        <div className="flex-1 min-w-0 flex items-start justify-end">
          <div className="orbita-acoes flex-wrap">
            <button
              type="button"
              onClick={() => { void integracoes.recarregar(); }}
              className="orbita-chip cursor-pointer"
              disabled={selecao === null}
            >
              <RefreshCw className="w-4 h-4" />
              Atualizar
            </button>
          </div>
        </div>
      </div>

      <FaixaDeContexto nome={nomeDaOrganizacao} />

      {selecao === null ? (
        <EstadoVazio
          titulo="Nenhuma organização ativa"
          descricao="Integrações são configuradas por organização. Escolha uma organização ativa para ver e configurar as desta empresa."
        />
      ) : integracoes.erro !== null ? (
        <div
          role="alert"
          className="flex flex-col items-start"
          style={{ gap: 10, padding: 16, borderRadius: 20, background: 'var(--glass2)', border: '1px solid var(--danger)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--txt)' }}>
            Não foi possível ler o estado das integrações
          </span>
          <span className="text-xs" style={{ color: 'var(--txt2)' }}>{integracoes.erro}</span>
          <button type="button" onClick={() => { void integracoes.recarregar(); }} className="orbita-acao">
            <RefreshCw className="w-4 h-4" />
            Tentar de novo
          </button>
        </div>
      ) : integracoes.dados === null ? (
        <EstadoCarregando mensagem="Lendo o estado das integrações desta organização…" />
      ) : (
        // A `key` e a selecao: trocar de organizacao (ou voltar para a mesma,
        // que e outra selecao) destroi os cartoes e todo segredo em digitacao.
        <div key={chave ?? 'sem-organizacao'} className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <CartaoBling
            fetchWithAuth={fetchWithAuth}
            leitura={integracoes.dados}
            organizacaoId={selecao.id}
            podeGerir={podeGerir}
            recarregar={integracoes.recarregar}
            irPara={irPara}
          />
          <CartaoChatwoot
            fetchWithAuth={fetchWithAuth}
            leitura={integracoes.dados}
            organizacaoId={selecao.id}
            podeGerir={podeGerir}
            recarregar={integracoes.recarregar}
          />
        </div>
      )}

      {selecao !== null && (
        <EnviosComAtencao key={`envios-${chave ?? 'sem-organizacao'}`} fetchWithAuth={fetchWithAuth} selecao={selecao} podeGerir={podeGerir} />
      )}
    </div>
  );
}
