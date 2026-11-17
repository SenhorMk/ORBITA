# MVP de atendimento com resposta assistida

## Prova local descartável

Pré-requisitos: Node 22, Docker Desktop e dependências do lock instaladas com `npm ci`. Antes de rodar, confira que o laboratório padrão não está em uso por outra sessão. O teste usa três portas locais (54322, 54398 e 54399) e encerra a própria instância ao concluir.

```sh
npm test -- src/services/sac/gerarResposta.test.ts src/components/mensageria/PainelDaResposta.test.tsx
npm run test:mvp:chat
```

A prova integrada usa webhook assinado sintético, PostgREST e PostgreSQL descartáveis, workers reais da aplicação e recibo simulado do Chatwoot. A autenticação do operador é um contexto sintético do teste. A prova de interface é separada e usa o componente real do cockpit.

1. Duas mensagens com o mesmo segundo entram pelo webhook. A inbox aplica ambas, preserva dois registros e abre um único caso. Só a triagem vigente alimenta o rascunho.
2. A organização B consulta a conversa da A e não recebe contexto nem envios. Falha do modelo e resposta fora do schema não geram rascunho.
3. Durante uma geração, chega uma terceira mensagem com timestamp anterior. O worker substituto recupera a lease expirada. A resposta antiga é descartada. Após concluir a nova triagem, a geração volta a funcionar.
4. No cockpit, **Gerar rascunho de resposta** mostra texto revisável. **Usar no compositor** preenche um compositor vazio. O envio exige a ação **Enviar**.
5. O envio humano assume o atendimento. A repetição do mesmo comando retorna a intenção existente. O consumidor grava o recibo e mostra **enviado**. Uma segunda passada, com outra identidade de worker, faz zero envios.
6. A mesma suíte também encerra um processo de inbox no meio da transação e verifica retomada com um caso e uma auditoria.

O rascunho não é persistido. O texto enviado passa a compor o histórico pelo recibo da outbox. O número de consultas ao modelo é limitado por organização. O fluxo assistido está desligado quando `SAC_RESPOSTA_PROVEDOR` está vazio e não ativa a política MSG-022.

## Caminho para a demonstração publicada

1. Confirmar a migration 94 congelada pelo Claude e o mesmo contrato de leitura. Montar o release sobre a cadeia aprovada 93→94→95→96, nas ordens 96→99. Migrations e deploy exigem aprovação específica.
2. Disponibilizar Chatwoot CE em host supervisionado, com URL HTTPS acessível à Vercel e saída HTTPS do Chatwoot para o ORBITA. A instância documentada do notebook está em loopback e o perfil local dos workers usa rede desabilitada. Para staging, usar o host Linux com Caddy do MSG-020B ou o equivalente aprovado. Conferir DNS, TLS, rota e assinatura antes de abrir o canal.
3. Configurar uma caixa exclusiva de testes. No ORBITA, registrar URL, conta, token de API e segredo do webhook no cofre da organização. Os nomes de referência são `CHATWOOT_API_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN` e `CHATWOOT_WEBHOOK_SECRET`. Usar `ENCRYPTION_KEY` no app e no worker de envio. Configurar o webhook de mensagem para `https://<orbita-staging>/api/chatwoot/webhook/<conexaoId>` e provar uma entrega assinada e um recibo de saída. O último snapshot registrava zero linhas Chatwoot com status conectado. O endpoint de conexão grava pendente e o indicador do Chatwoot usa last_health_check_at e health_status. A ausência do rótulo conectado não identifica por si só falta de configuração ou falha de rede.
4. No host aprovado, usar `npm run worker:inbox`, `npm run worker:triagem` e `npm run worker:envio` com reinício supervisionado e logs. O compose padrão supervisiona inbox e envio. Provisionar a supervisão da triagem separadamente. Validar `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, os switches `CHATWOOT_INBOX_WORKER_ENABLED`, `SAC_TRIAGEM_WORKER_ENABLED`, `CHATWOOT_SEND_WORKER_ENABLED` e o corte sintético em `CHATWOOT_INBOX_WORKER_BACKLOG_DESDE` e `CHATWOOT_SEND_WORKER_BACKLOG_DESDE`. Conferir protocolo 2 no envio. Iniciar somente após aprovação do responsável pelo ambiente.
5. Começar com `SAC_TRIAGEM_PROVEDOR=fake`, orçamento de triagem positivo para a janela (`SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO`) e `SAC_RESPOSTA_PROVEDOR=fake`. Manter a política global e por organização do MSG-022 desligada. Enviar uma mensagem sintética, observar o caso, gerar e revisar o rascunho, enviar e verificar o recibo. Se o estado ficar desconhecido, conciliar sem repetir o POST.
6. Para testar Gemini, aprovar o uso do provedor e o envio de dados exclusivamente sintéticos. Configurar `GOOGLE_GENERATIVE_AI_API_KEY`, `SAC_RESPOSTA_PROVEDOR=google`, `SAC_RESPOSTA_MODELO` e `SAC_RESPOSTA_GEMINI_AUTORIZADO=true`. Se a triagem também for real, configurar `SAC_TRIAGEM_PROVEDOR=google` e `SAC_TRIAGEM_MODELO`. Confirmar modelo de texto Flash aceito, disponibilidade e orçamento. Uma falha do modelo deixa o operador no atendimento manual.

## Alternativa sem o Chatwoot de staging

Use o canal do Chatwoot CE local com uma caixa sintética e o ORBITA local na mesma rede, com o webhook apontado para um endereço do app alcançável pelo container. Use banco descartável, credenciais locais, trabalhadores locais e fake declarado. No Docker Desktop, resolva o IPv4 do host a partir do Sidekiq conforme o runbook MSG-001. Rede privada requer SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true, somente no compose de desenvolvimento. Confirme a alcançabilidade dos dois sentidos antes da sessão. Essa topologia mantém um chat de verdade entre cliente e atendente, com modelo de demonstração. A prova automatizada acima usa o ingress e o banco reais com recibo simulado e já pode ser usada se a interface do Chatwoot local não estiver disponível.

A fila automática do MSG-014 ainda exige um produtor separado, integração com a versão congelada e verificação pelo contrato de autorização e despacho do MSG-022. O caminho validado aqui é o envio humano assistido.

## Demo interativa D03/D04/D06

Este ensaio usa o checkout de laboratório derivado de `8e0e960`. A migration 94 é a da composição de laboratório. A única revalidação com a 94 congelada depende da coordenação.

### Subir e operar

Requer Node 22, Docker Desktop e Edge ou Chrome. Use um checkout sem `.env.local` de staging. As portas de loopback 55820, 55821, 55822, 55830 e 55831 precisam estar livres. O processo cria autenticação local, uma organização **ORBITA Demo**, um atendente e uma conexão sintética. O PostgreSQL e o GoTrue são descartáveis.

```sh
npm ci
node scripts/demo-mvp-chat.mjs iniciar
```

- Atendente em `http://127.0.0.1:55830`. Login sintético `atendente@orbita.test`, senha `Orbita-Demo-2026!`. A organização única é ativada pela sessão. Se a inicialização oferecer modo offline, escolha **Ignorar (Modo Offline)**.
- Cliente em `http://127.0.0.1:55831`. Digite “Preciso acompanhar meu pedido sintético” e clique em **Enviar mensagem**. O canal gera uma entrega assinada e mostra o aceite HTTP.
- No ORBITA, espere a inbox processar a entrega e abra **SAC / Atendimento → Cliente Sintético**. Se abriu o SAC antes do processamento e a conversa não apareceu, volte à **Visão Geral** e reabra o SAC. Confira o histórico e o painel de triagem. Depois da triagem, use **Gerar rascunho de resposta → Usar no compositor**, edite e clique em **Enviar**. O atendimento passa a **Com você**. O recibo é simulado no adaptador HTTP; a confirmação e a mensagem de saída são gravadas pelo worker real.
- Envie outra mensagem pelo cliente. Confira a ordem no histórico e gere outro rascunho. Para testar erro, use **Simular falha no próximo recibo** no cliente e envie uma resposta revisada. A outbox registra **desconhecido**. Não repita o envio.
- O launcher inicia os workers reais da inbox, triagem e envio com corte no início da execução. O modelo determinístico é fixado e identificado. A página de cliente não armazena conversas nem mantém outra fila.

Execute o roteiro automatizado no navegador em outro terminal enquanto a demo estiver aberta. Comece com a sessão recém-criada para usar a conversa vazia.

```sh
node scripts/ensaiar-mvp-chat.mjs
```

O ensaio tira capturas em `test-results/mvp-chat-local` depois da autenticação. Para Chrome, configure `ORBITA_DEMO_BROWSER=chrome`. Se a conversa ou o rascunho não aparecer, confira no terminal se aplicação e três workers estão ativos. Para repetir do zero, interrompa com Ctrl+C e execute o comando de limpeza se o terminal tiver sido encerrado abruptamente.

```sh
node scripts/demo-mvp-chat.mjs parar
```

Isso remove exclusivamente o projeto Docker `orbita-demo-d0306`, incluindo o banco sintético; arquivos de configuração local ignorados pelo Git podem permanecer. O launcher habilita `NEXT_PUBLIC_ORBITA_DEMO_LOCAL` só nos processos de desenvolvimento. Essa opção permite o Supabase HTTP exato em `127.0.0.1:55821`. Para revalidar por código sem o navegador, use `npm run test:mvp:chat`.

### Gemini real

A demo interativa acima fixa o fake. Uma instância autorizada pode usar `SAC_RESPOSTA_PROVEDOR=google`, `SAC_RESPOSTA_MODELO=gemini-2.5-flash`, `SAC_RESPOSTA_GEMINI_AUTORIZADO=true` e `GOOGLE_GENERATIVE_AI_API_KEY`. `gemini-2.5-flash` é a seleção ensaiada no contrato local, sem requisição ao provedor. Não existe modelo real implícito e o alias não fixa revisão de backend. Para retornar ao modo determinístico, use `SAC_RESPOSTA_PROVEDOR=fake`. Vazio desliga.

O adaptador está em `src/services/sac/modeloDaResposta.ts` e usa AI SDK com saída estruturada. O domínio em `gerarResposta.ts` valida texto de 1–1.200 caracteres, impõe 15 s e relê a marca do contexto antes de entregar o rascunho. A marca inclui caso, versão, execução e revisões das mensagens. O SDK recebe teto de 640 tokens de saída e zero retries. A rota limita a 10 tentativas por minuto por organização; a cobrança e o orçamento total continuam dependentes da conta Gemini. Resposta inválida ou provedor indisponível mantém o envio manual disponível. A triagem e seu orçamento usam `SAC_TRIAGEM_PROVEDOR`, `SAC_TRIAGEM_MODELO` e `SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO`, independentes do rascunho.

O Chatwoot CE local tem compose próprio, mas acoplá-lo a esta sessão exige provisionar outra instância, um inbox de teste e o caminho Sidekiq → app no Docker Desktop. O simulador mantém essas duas fronteiras HTTP e usa o cockpit publicado neste checkout. A experiência não certifica entrega pelo Chatwoot CE.
