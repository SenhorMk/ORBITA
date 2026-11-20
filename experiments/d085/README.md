# D08.5 — gates de integração e ensaio

## Matriz consolidada

| Entrega | Evidência preservada | Limite e estado |
|---|---|---|
| D08.1, jornada e takeover | 11 testes, SQLite, duas threads, conversa única | Simulação de modelo e canal |
| D08.2, bootstrap e política | 90 Vitest e prova real PostgreSQL 16, duas esperas de lock | Banco nativo e dados sintéticos |
| D08.3, produtor e outbox | 85 Vitest, integração PostgreSQL 16 e seis passos no Edge | Transporte e geração simulados, navegador do ensaio separado do cockpit D05 |
| D08.4, adapter Administrator | 5 testes de contrato, 32 Vitest, worker real contra PostgreSQL 16 e HTTP injetado, seis corridas de regressão MSG-022 | Poder Administrator no CE real ainda não ensaiado |
| D08.5, aplicação 97/98 | Executor real, ledger 100/101, bytes 93–96, falha no registro de cada migration após DDL, rollback e reaplicação controlada | PostgreSQL 16 nativo, evidência complementar. Ao falhar a 98, a 97 permaneceu aplicada. Repetir 98 após sucesso foi recusado sem mudar catálogo. Não existe down migration. |
| D08.5, grants e isolamento | Nomes e grants SQL de PostgREST, chamada com os papéis reais do banco, tentativas B→A e leitura direta negadas | Gateway HTTP e pgTAP ainda pendentes |
| D08.5, sonda CE | Transições e recusas em quatro testes do script com HTTP simulado | Nova sonda real bloqueada até autorização. Sem credencial operacional. |

O índice de evidências do pacote lista SHA e artefatos de cada rodada anterior. D05 segue como candidata assistida. D06 e D07 permanecem em seus pacotes.

## Banco e catálogo

As ordens são 96–99 para 93–96, 100 para 97 e 101 para 98. O laboratório usado nesta rodada tem PostgreSQL nativo **16.15**, sem extensão pgTAP. No host há PostgreSQL 16 e 18 e nenhuma distribuição WSL instalada. O gateway PostgREST e um laboratório independente Supabase PostgreSQL 17 não estavam disponíveis. A referência oficial foi preservada.

No PostgreSQL 16, a divergência já aparece **antes de 97/98**, com as mesmas contagens por categoria do D05. O hash nativo da base é `ae33622a9b60344e9c915ad56386412018caca04ffb86404b4f1a8991666c6ac`; o oficial é `4e588cdc5ae46a01bbae919bb4935b0a25652c387bc7844a3a42a4ef3136c5d3`. O diagnóstico repete as consultas oficiais no mesmo banco com dois search paths e compara os grupos que mudaram. Hash agregado e contagens não identificam a diferença exata entre a referência D05 e a reconstrução nativa. O candidato nativo reproduz `4997c7f9f386268c9b82553c73fbd31350ef526b7cd16c1c6651bade4757a352`. Nenhum hash nativo substitui a referência oficial.

O rollback foi induzido por uma restrição **na tabela de registro da fixture**, com os SQL 97/98 intactos. Na 97, o executor recuperou o fingerprint exato do catálogo-base. Na 98, recuperou a função anterior e seus grants, preservando a 97 já comprometida. Depois de retirar a restrição, aplicou só a 98. O segundo pedido encontrou o registro e saiu sem reaplicar. Em uma janela publicada, conter tráfego e workers e planejar correção forward-only. Rollback do aplicativo exige compatibilidade comprovada. A prova local cobre a fronteira de transação.

Quando houver laboratório Supabase PostgreSQL 17 independente e autorizado:

1. Reconstruir a cadeia D05 em cópia descartável e capturar o catálogo pelas consultas oficiais de `scripts/database-catalog.mjs`. Exigir referência igual. Se divergir, exportar as sete categorias, registrar versão/roles/ACLs/search_path e comparar linha a linha com uma captura oficial D05. Não atualizar a referência para absorver diferenças da base.
2. No mesmo ambiente, reconstruir a candidata com o manifesto, `npm run db:catalog:rebuild` e `npm run db:drift:check`. A referência nova deve conter apenas o delta da candidata. Guardar ambas as capturas.
3. Em banco reconstruído para a prova, executar os dois arquivos pgTAP de `supabase/tests/final`, `controle_atendimento_chatwoot.test.sql` e `autorresposta_sac.test.sql`, com o runner `runMigrationPgTapTests` e filtro desses arquivos, preservando o parser que acusa falhas de TAP. Rodar `postgrest-contract.sql` e `tenant-grants.sql`. Correlacionar os resultados com a prova do worker.
4. Executar `node experiments/d084/postgrest-http.mjs` no gateway local com chaves locais e schema cache atualizado. Confirmar RPC nomeada acessível a service_role e negada a anon. Validar também a prova vertical por PostgREST com o worker e os mesmos dados sintéticos. Não transportar credenciais entre ambientes.

Para reproduzir a evidência nativa, usar os parâmetros do laboratório D08.2, porta 55482. Criar `orbita_d085` de cópia vazia de fixtures do banco D05 com 93–96, sem 97/98. Definir `ORBITA_D085_DISPOSABLE=yes` e rodar `node --test experiments/d085/migrations.test.mjs` uma vez por cópia nova. Depois executar as SQL de contratos e tenancy no mesmo banco e encerrar somente o cluster descartável. `catalog-diagnose.mjs` usa a cópia D05 `orbita_d084_catalog_base`.

## Roteiro CE 4.19.1 para Claude

Autorizar e combinar horário fora da janela do Tunnel. Nenhum comando inicia ou altera o Tunnel. Usar **somente** a porta direta aprovada de loopback, conta/inbox/conversa sintéticas A e uma conversa sentinela B em outra conta. Usar duas credenciais descartáveis distintas, com Administrator técnico da conta A, e duas etiquetas únicas `orbita-d085-...`. Deixar atribuição automática desligada, sem Agent Bot, sem regras de atribuição e sem cliente real. Manter Gemini e a autorresposta real desligados.

Configuração da sonda por ambiente, sem imprimir valores:

- `ORBITA_D085_AUTORIZADO_LEITURA=sim`, `ORBITA_D085_ORIGEM` e `ORBITA_D085_TECNICO`.
- Para A e B, `ORBITA_D085_{A,B}_{CONTA,INBOX,CONVERSA,ETIQUETA,TOKEN_DESCARTAVEL}`.
- `ORBITA_D085_STATUS=open|pending`, `ORBITA_D085_ASSIGNEE=nenhum|<id>`, de acordo com o estado esperado de A.
- `node experiments/d085/chatwoot-probe.mjs` faz só GET. Para os casos 2/3, com autorização específica de escrita, definir `ORBITA_D085_AUTORIZADO_ESCRITA` como a etiqueta exata da fixture A e executar `node experiments/d085/chatwoot-probe.mjs abrir-fixture`. Isso admite **um** POST de status `open` no único ID aprovado, após estado inicial `pending`. Sem exclusão, mensagens, reassignment, mudança de papel, retry de POST ou restauração automática.

| Caso | Preparação e passo | Aceite |
|---|---|---|
| 1. Pending vazio | Usar bootstrap sintético aprovado no ORBITA. Rodar sonda somente leitura com `pending/nenhum` | Conta, inbox, status e responsável esperados |
| 2. Open sem técnico | Usar A em pending vazio. Rodar `abrir-fixture` após aprovação | Open, responsável vazio e um POST. Técnico ausente |
| 3. Preservar humano | Usar outra fixture A pendente com atendente de teste já atribuído. Rodar `abrir-fixture` | Mesmo ID humano em open |
| 4. Handback autorizado | Operador assume no ORBITA, confirma envio humano, devolve com resumo e espera confirmação. Usar fixture sem assignee remoto. Sonda read-only com `pending/nenhum` | Controle autorizado e pending. Sem novo envio IA até mensagem nova e autorização |
| 5. Handback com humano remoto | Em fixture distinta, deixar assignee remoto e pedir handback pelo ORBITA | Nenhum POST pending. Controle deve conter a IA. Sonda lê status e responsável anteriores |
| 6. Mudança de papel | Usar a contraprova simulada D08.4/D08.5. Na conexão CE real, confirmar papel antes e depois e parar em caso de divergência | O CE não oferece CAS de papel na mudança de status. Não provocar demissão/atribuição na instância operacional. Corrida forçada real exigiria clone CE descartável separado. |
| 7. Contenção | Em laboratório, provocar divergência só na fixture autorizada e conferir observação durável e recusa do despacho. Se houver efeito incerto, bloquear nova tentativa e conciliar readback | Sem novo POST repetido, sem resposta IA, registro disponível. Erro da sonda é parada do ensaio, não comando ao worker |
| 8. Outra organização | B é apenas lida antes/depois, incluindo status, assignee e revisão. Usar IDs de conversa iguais entre contas se possível | B intacta e nenhuma rota de escrita para B. Grants/cercas também demonstrados no PostgreSQL |

A prova CE precisa dos IDs e logs sanitizados da fixture, além da evidência de autoria local do comando no ORBITA. Status externo sozinho não prova handback. Nenhum ensaio real foi iniciado nesta rodada.

## Banca e aprovação restante

No congelamento de 23/11 à noite, usar D05 assistido como roteiro de cockpit. Para ilustrar a jornada AI-first, rodar `node experiments/d083/demo-browser.mjs` e abrir `http://127.0.0.1:55836` no Edge, declarando que o canal e o modelo são simulados. Na banca de 24/11 às 08h, apresentar como evidência separada os logs de PostgreSQL e o limite de `in_flight/unknown`.

**GO** para revisão do patch e ensaio sintético. **NO-GO** para integração operacional até o laboratório PostgreSQL 17/PostgREST e a janela CE isolada autorizada. **NO-GO** para IA real, que tem gate de privacidade, modelo e autorização própria. **NO-GO** para publicação, que ainda depende do D06 e das autorizações de release. A próxima aprovação é a janela do ensaio sintético controlado com Claude, fora do Tunnel, usando a credencial descartável e as duas fixtures.
