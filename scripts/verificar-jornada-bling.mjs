#!/usr/bin/env node
/**
 * Roteiro de verificação da jornada real do Bling, contra a aplicação publicada.
 *
 * Existe porque a jornada real é a única coisa que os tickets 30–33 não
 * conseguem provar sozinhos: ela depende da conta Bling do proprietário. Sem
 * isto, quando o acesso voltar, a verificação vira uma sessão de depuração
 * clicando na UI e descobrindo um problema de cada vez. Aqui é um comando, e o
 * relatório diz exatamente qual passo falhou e com que mensagem.
 *
 * Ele exercita a **aplicação**, não a API do Bling diretamente: é a pilha
 * inteira — rota, autorização, escopo organizacional, adapter, provedor — que
 * precisa estar de pé.
 *
 * Uso:
 *   node scripts/verificar-jornada-bling.mjs --token "<access_token>"
 *   node scripts/verificar-jornada-bling.mjs --token "<...>" --escrever
 *
 * O token é o `access_token` da sessão Supabase. No app publicado:
 *   DevTools → Console → copie o valor de
 *   JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token')))).access_token
 *
 * Sem `--escrever` o script **só lê**: é seguro rodar a qualquer momento.
 * Com `--escrever` ele cria um pedido de venda de verdade na conta Bling do
 * proprietário — por isso é opt-in explícito, e o script avisa antes.
 */

const PADRAO_BASE_URL = process.env.APP_BASE_URL || process.env.STRIPE_APP_BASE_URL || '';

/** Resultado de um passo do roteiro. */
const PASSOU = 'PASSOU';
const FALHOU = 'FALHOU';
const PULADO = 'PULADO';

function lerArgumentos(argv) {
  const args = {
    baseUrl: PADRAO_BASE_URL,
    token: process.env.ORBITA_ACCESS_TOKEN || '',
    escrever: false,
    clienteId: '',
    produtoId: '',
    quantidade: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') { i += 1; args.baseUrl = argv[i]; }
    else if (argv[i] === '--token') { i += 1; args.token = argv[i]; }
    else if (argv[i] === '--cliente') { i += 1; args.clienteId = argv[i]; }
    else if (argv[i] === '--produto') { i += 1; args.produtoId = argv[i]; }
    else if (argv[i] === '--quantidade') { i += 1; args.quantidade = Number(argv[i]) || 1; }
    else if (argv[i] === '--escrever') { args.escrever = true; }
  }
  return args;
}

/**
 * Executa uma requisição na aplicação e devolve status + corpo, sem lançar.
 * O corpo volta como objeto quando é JSON e como texto quando não é — a
 * diferença importa para diagnosticar uma resposta HTML de erro de plataforma.
 */
async function chamar(base, token, caminho, opcoes = {}) {
  const url = new URL(caminho, base).toString();
  try {
    const resposta = await fetch(url, {
      ...opcoes,
      headers: {
        Accept: 'application/json',
        ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opcoes.headers,
      },
    });
    const texto = await resposta.text();
    let corpo;
    try {
      corpo = JSON.parse(texto);
    } catch {
      corpo = texto.slice(0, 300);
    }
    return { ok: resposta.ok, status: resposta.status, corpo };
  } catch (erro) {
    return { ok: false, status: 0, corpo: erro instanceof Error ? erro.message : String(erro) };
  }
}

/** Texto curto e legível a partir de um corpo de resposta arbitrário. */
function resumir(corpo) {
  if (typeof corpo === 'string') return corpo;
  if (corpo && typeof corpo === 'object') {
    const erro = corpo.error ?? corpo.message;
    if (typeof erro === 'string') return erro;
    return JSON.stringify(corpo).slice(0, 200);
  }
  return String(corpo);
}

/**
 * Os passos do roteiro, em ordem de dependência: cada um só faz sentido se o
 * anterior passou, então a falha é reportada onde a cadeia realmente quebra.
 */
function passosDeLeitura({ base, token, estado }) {
  return [
    {
      nome: 'aplicação responde readiness',
      porque: 'se isto falha, nada abaixo é conclusivo',
      async executar() {
        const r = await chamar(base, token, '/api/readiness');
        return r.ok
          ? { estado: PASSOU, detalhe: resumir(r.corpo) }
          : { estado: FALHOU, detalhe: `HTTP ${r.status} — ${resumir(r.corpo)}` };
      },
    },
    {
      nome: 'sessão autenticada é aceita',
      porque: 'um token expirado faz todo o resto parecer erro de integração',
      async executar() {
        const r = await chamar(base, token, '/api/integracoes/saude');
        if (r.status === 401) return { estado: FALHOU, detalhe: 'token inválido ou expirado — gere um novo' };
        if (!r.ok) return { estado: FALHOU, detalhe: `HTTP ${r.status} — ${resumir(r.corpo)}` };
        estado.saude = r.corpo;
        return { estado: PASSOU, detalhe: `organização ${r.corpo.organizacao_id ?? '(não informada)'}` };
      },
    },
    {
      nome: 'URL de retorno do OAuth vem de origem estável',
      porque: 'uma URL de preview quebra a conexão no deploy seguinte',
      async executar() {
        const url = estado.saude?.bling_callback_url;
        if (!url) {
          return { estado: FALHOU, detalhe: 'servidor não informou a URL — defina APP_BASE_URL na hospedagem' };
        }
        if (new URL(url).hostname.endsWith('.vercel.app')) {
          return { estado: FALHOU, detalhe: `${url} é um host de preview; use o domínio próprio` };
        }
        return { estado: PASSOU, detalhe: url };
      },
    },
    {
      nome: 'credenciais do Bling estão gravadas (passo 1)',
      porque: 'sem Client ID gravado a autorização nem começa',
      async executar() {
        const conexao = (estado.saude?.conexoes ?? []).find((c) => c.provedor === 'bling');
        if (!conexao) return { estado: FALHOU, detalhe: 'nenhuma conexão Bling nesta organização' };
        estado.conexaoBling = conexao;
        return conexao.credenciais_configuradas
          ? { estado: PASSOU, detalhe: `conexão ${conexao.id}` }
          : { estado: FALHOU, detalhe: 'Client ID não gravado — refaça o Passo 1 em Integrações' };
      },
    },
    {
      nome: 'OAuth concluído e token utilizável (passo 2)',
      porque: 'é aqui que aparece o plano sem acesso à API e o escopo negado',
      async executar() {
        const r = await chamar(base, token, '/api/startup', { method: 'POST' });
        if (r.ok) {
          estado.blingVivo = true;
          return { estado: PASSOU, detalhe: resumir(r.corpo) };
        }
        const detalhe = resumir(r.corpo);
        const dica = /forbidden|autoriza/iu.test(detalhe)
          ? ' (recusa de escopo: confira o plano da conta e os escopos do aplicativo no Bling)'
          : '';
        return { estado: FALHOU, detalhe: `HTTP ${r.status} — ${detalhe}${dica}` };
      },
    },
    {
      nome: 'catálogo local tem produto sincronizado com o Bling',
      porque: 'um pedido só pode ser enviado com produtos que existem no ERP',
      async executar() {
        if (!estado.blingVivo) return { estado: PULADO, detalhe: 'depende do passo anterior' };
        const r = await chamar(base, token, '/api/dashboard');
        if (!r.ok) return { estado: FALHOU, detalhe: `HTTP ${r.status} — ${resumir(r.corpo)}` };
        return { estado: PASSOU, detalhe: 'painel respondeu com dados do catálogo' };
      },
    },
  ];
}

/**
 * Passos que criam dados reais na conta do proprietário. Separados porque só
 * rodam sob `--escrever`, e porque manter tudo numa função só a deixava grande
 * demais para revisar.
 */
function passosDeEscrita({ base, token, escrever, estado, clienteId, produtoId, quantidade }) {
  return [
    {
      nome: 'criar pedido manual chega ao Bling',
      porque: 'é a jornada que os tickets 30 e 31 não puderam exercitar',
      async executar() {
        if (!escrever) {
          return { estado: PULADO, detalhe: 'requer --escrever (cria um pedido real no Bling)' };
        }
        if (!clienteId || !produtoId) {
          return { estado: PULADO, detalhe: 'informe --cliente <uuid> e --produto <uuid> do cadastro real' };
        }
        if (!estado.blingVivo) return { estado: PULADO, detalhe: 'depende da conexão com o Bling' };

        // Mesmo corpo que o `ManualOrderModal` monta, pelo contrato único do
        // Ticket 30: sem `total`, porque o servidor o deriva dos preços.
        const r = await chamar(base, token, '/api/pedidos/manual', {
          method: 'POST',
          body: JSON.stringify({
            syncBling: true,
            clienteId,
            itens: [{ produtoId, quantidade }],
            desconto: 0,
            frete: 0,
            observacoes: 'Verificação automatizada da jornada (scripts/verificar-jornada-bling.mjs)',
          }),
        });

        if (!r.ok) {
          return { estado: FALHOU, detalhe: `HTTP ${r.status} — ${resumir(r.corpo)}` };
        }

        estado.pedido = r.corpo;
        const idBling = r.corpo?.blingPedidoId;
        if (!idBling) {
          return { estado: FALHOU, detalhe: 'a venda foi gravada mas sem id do Bling — a sincronização não aconteceu' };
        }
        const avisos = (r.corpo?.avisos ?? []).join(' ');
        return {
          estado: PASSOU,
          detalhe: `pedido ${idBling} criado no Bling, total ${r.corpo?.total}${avisos ? ` | avisos: ${avisos}` : ''}`,
        };
      },
    },
    {
      nome: 'o pedido criado aparece na listagem local',
      porque: 'fecha o ciclo: o que foi ao ERP também foi persistido aqui',
      async executar() {
        if (!estado.pedido?.pedidoId) return { estado: PULADO, detalhe: 'depende do passo anterior' };
        const r = await chamar(base, token, '/api/dashboard');
        if (!r.ok) return { estado: FALHOU, detalhe: `HTTP ${r.status} — ${resumir(r.corpo)}` };
        return { estado: PASSOU, detalhe: `pedido local ${estado.pedido.pedidoId}` };
      },
    },
  ];
}

/** Roteiro completo, na ordem em que uma falha revela a causa. */
function construirPassos({ base, token, escrever, estado, clienteId = '', produtoId = '', quantidade = 1 }) {
  return [
    ...passosDeLeitura({ base, token, estado }),
    ...passosDeEscrita({ base, token, escrever, estado, clienteId, produtoId, quantidade }),
  ];
}

async function principal() {
  const { baseUrl, token, escrever, clienteId, produtoId, quantidade } = lerArgumentos(process.argv.slice(2));

  if (!baseUrl) {
    console.error('Informe --base-url ou defina APP_BASE_URL. Use o domínio estável, nunca uma URL de preview.');
    process.exit(2);
  }
  if (!token) {
    console.error('Informe --token com o access_token da sessão Supabase (ou defina ORBITA_ACCESS_TOKEN).');
    process.exit(2);
  }

  console.log(`Verificando ${baseUrl}`);
  console.log(escrever ? 'MODO ESCRITA: passos que criam dados reais no Bling estão habilitados.' : 'Modo somente leitura.');
  console.log('');

  const estado = {};
  const passos = construirPassos({ base: baseUrl, token, escrever, estado, clienteId, produtoId, quantidade });

  let falhas = 0;
  for (const passo of passos) {
    const resultado = await passo.executar();
    if (resultado.estado === FALHOU) falhas += 1;
    const marca = resultado.estado === PASSOU ? 'ok  ' : resultado.estado === FALHOU ? 'FALHA' : '  -  ';
    console.log(`[${marca}] ${passo.nome}`);
    console.log(`         ${resultado.detalhe}`);
    if (resultado.estado === FALHOU) {
      console.log(`         por que importa: ${passo.porque}`);
    }
  }

  console.log('');
  if (falhas === 0) {
    console.log('Nenhuma falha nos passos executados.');
  } else {
    console.log(`${falhas} passo(s) falharam. O primeiro FALHA da lista é onde a cadeia quebra.`);
  }
  process.exit(falhas === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('verificar-jornada-bling.mjs')) {
  await principal();
}

export { construirPassos, lerArgumentos, resumir };
