# Edição de produtos pelo Assistente ORBITA

Status: implementação local concluída e validada em 24/11/2026, na branch `codex/assistente-editar-produtos`, baseada em `0c00027`. Critério de aceite confirmado pelo usuário nesta conversa. Sem migration remota, commit ou deploy.

## Escopo

Usuários autenticados do painel com `organization:manage` podem pedir a definição do saldo físico, a troca do nome ou da descrição curta de produtos da organização ativa. O atendimento ao cliente não recebe essas ferramentas.

O fluxo é pergunta → seleção explícita → prévia sem escrita no ERP → confirmação → resultado por produto. Uma confirmação repetida nunca envia novamente a operação ao Bling. Sem confirmação, nenhuma alteração de catálogo ocorre.

Limites da primeira versão: até 20 produtos por proposta; busca por nome/categoria exige catálogo com menos de 1000 produtos ativos (SKU exato continua disponível). Estoque exige exatamente um depósito cadastrado, ativo e considerado no saldo. Lotes maiores ou vários depósitos são recusados inteiros, com orientação para restringir ou usar a gestão de estoque.

“Deixe com 5” define o saldo em 5. Somar/remover quantidades não faz parte desta versão. Descrição significa `descricaoCurta`, descrição principal do produto na loja, e não descrição complementar. Os textos de substituição são copiados do pedido; a IA não inventa conteúdo.

## Ticket ADM-PROD-01

Dependências: copiloto administrativo de leitura (#171), catálogo Bling e autorização organizacional existentes. Uma única fatia vertical, sem publicação de ticket nem commit nesta execução.

Aceite:

- Alterar um produto por SKU/nome e um conjunto por categoria/nome, com seleção completa e limitada; ambiguidade individual pede esclarecimento. Uma seleção acima do limite é recusada inteira.
- Mostrar nome/SKU, campo, valor atual e novo, validade e depósito quando aplicável. “Todos” precisa estar explícito no pedido.
- Escopo e ator vêm da sessão; dados do modelo e do navegador não concedem autoridade. Revalidar a permissão na confirmação.
- Propostas persistidas vinculadas ao ator e organização, expiração e reivindicação atômica impedem execução duplicada, inclusive concorrente.
- Se o dado remoto mudar após a prévia, não aplicar aquele item. Timeout/falha de rede é resultado indeterminado, sem repetição automática.
- Escrever apenas o campo pedido via PATCH; saldo físico por balanço no depósito explicitamente registrado. Não escolher silenciosamente entre vários depósitos.
- Espelhar apenas alterações aceitas no Bling e registrar resultados duráveis. Falha após envio exige conferência; nunca declarar sucesso sem prova.
- Cancelar descarta a proposta na interface; proposta não confirmada expira sem efeito no ERP.

Segurança: acesso exclusivo ao painel, capacidade de gestão, isolamento por organização/ator, parsers estritos, respostas sem cache, rate limit e flags. Propostas/resultados são trilha interna; nenhum texto bruto de pedido vai aos logs.

Banco: migration ordenada para propostas/resultados e espelho opcional da descrição curta; RLS habilitada, acesso direto do navegador revogado e RPCs somente para service role com membership reconferida. Não aplicar em ambiente remoto nesta tarefa.

Testes acordados: fluxo público de proposta/confirmação/resultado; sem permissão; outra organização/ator; expiração; confirmação repetida/concorrente; alteração remota após prévia; falha parcial e resultado desconhecido. Contrato HTTP do Bling comprova campos enviados e preservação dos demais. Testes SQL num banco descartável.

Rollout: aplicar e validar migration antes de habilitar a flag de escrita; smoke manual autenticado com produto de teste autorizado. Rollback operacional: desligar a flag; manter propostas/recibos para auditoria. Não reverter estoque automaticamente: movimentos comerciais podem ter ocorrido depois.

## Referências verificadas

- https://developer.bling.com.br/boas-praticas — PATCH altera apenas os campos enviados.
- https://developer.bling.com.br/referencia — OpenAPI público consultado em 24/11/2026 UTC: `GET /produtos/{idProduto}` fornece nome/descrição, `GET /estoques/saldos?idsProdutos[]=...` fornece saldo físico, `POST /estoques` com operação `B` faz o balanço. O saldo físico não é inferido do detalhe do produto.
- https://ajuda.bling.com.br/hc/pt-br/articles/360036756914-Como-cadastrar-produtos — significado da descrição curta.
- https://supabase.com/docs/guides/database/postgres/row-level-security

Limite conhecido: a API do Bling não fornece uma transação conjunta com o ORBITA. A conferência imediatamente anterior à escrita reduz divergência, mas não elimina uma alteração externa entre a leitura e a escrita.

## Recuperação de uma execução interrompida

A proposta em execução não expira para reenvio. Isso evita que um crash após o Bling aplicar a mudança provoque um segundo comando. Os produtos envolvidos ficam bloqueados para outra proposta enquanto a execução não for encerrada.

1. Identificar a organização e a chave exibida no painel. Conferir os recibos em `assistente_edicoes_produtos`, o valor atual no Bling e no espelho ORBITA. Confirmar que a requisição original terminou; aguardar pelo menos 15 minutos de `iniciado_em`.
2. Identificar um gestor atual da mesma organização. A reconciliação revalida a membership dele, mesmo que o autor original tenha perdido acesso.
3. Apresentar ao operador o alvo exato, os produtos e valores conferidos, o comando abaixo com UUIDs reais, e obter autorização para a escrita remota. Não há ferramenta de reconciliação acessível ao modelo nem ao corpo da confirmação do navegador.

```sql
-- Somente via conexão privilegiada/servidor e após autorização específica.
-- Os três UUIDs precisam ser preenchidos a partir da inspeção verificada.
select public.assistente_edicao_produtos(
  '<organizacao-verificada>'::uuid,
  '<gestor-atual-verificado>'::uuid,
  'reconciliar',
  '<chave-da-proposta>'::uuid,
  '{"confirmacao":"conferido_no_bling_sem_reenvio"}'::jsonb
);
```

Essa transação bloqueia apenas a proposta e a autorização por instantes, mantém recibos anteriores e registra os faltantes como `indeterminado`. Não envia requisições ao Bling nem muda o catálogo. Registra o gestor responsável na auditoria e permite nova prévia baseada em leitura atual. A sincronização/conferência do espelho, quando necessária, usa o fluxo existente autorizado; a reconciliação nunca inventa que uma escrita foi aplicada.

## Verificações locais reproduzíveis

Gates gerais: `npm test`, `npm run typecheck`, `npm run secrets:check`, `npm run lint:ratchet`, `npm run aislop`, `npm run build` e `npm run db:drift:check`.

O teste de integração `edicaoDeProdutos.database.test.ts` só executa com `ORBITA_TEST_EDICAO_LOCAL=true` e conecta exclusivamente em `127.0.0.1:55404`. O runner `node scripts/test-assistente-edicao-local.mjs` aplica a cadeia canônica e executa 26 testes pgTAP nessa mesma porta. O container descartável usa a imagem Supabase PostgreSQL 17; preparar a senha local `postgres` do papel `supabase_auth_admin` antes do runner. `--somente-testes` evita reaplicar migrations no container já reconstruído. Nunca fornecer conexão remota a esse runner.

Evidência final:

- Suíte completa: 343 arquivos aprovados, 4096 testes aprovados; 2 testes de banco não executam por padrão e passaram separadamente com a configuração local explícita.
- PostgreSQL descartável: cadeia canônica completa aplicada e 26 verificações pgTAP aprovadas, incluindo revogação, expiração, escopo e reconciliação. Duas conexões concorrentes receberam exatamente uma autorização de execução.
- Interface renderizada: prévia sem comando de escrita, cancelamento sem envio, confirmação explícita e recuperação após resposta perdida aprovados.
- Bling por HTTP fake: PATCH de campo único, saldo absoluto zero, endpoint próprio de saldos, resposta de outro produto, múltiplos depósitos, falha de servidor e corpo interminável cobertos.
- `typecheck`, `lint:ratchet`, `secrets:check`, `aislop`, `db:drift:check`, `build`, `build:artifact:check` e `git diff --check` aprovados. Build com valores fictícios equivalentes aos usados pelo CI, sem credenciais reais.
- Revisão independente de standards/segurança e escopo concluída; achados corrigidos e reinspecionados. Mapa estrutural do módulo regenerado localmente, sem chamadas a modelos.

Não foi executado smoke com modelo ou Bling credenciado nem teste no ambiente compartilhado. A ativação requer revisão/publicação do código, autorização específica para a migration 104 no alvo correto e habilitação de `ORBITA_ASSISTENTE_EDICAO_PRODUTOS_ENABLED=true` junto da flag administrativa existente. A flag de escrita permanece desligada no exemplo de configuração.

## Correções complementares solicitadas em 24/11/2026

- Financeiro: botão de confirmação renomeado para “Registrar saída”; durante o envio, “Registrando...”.
- Mensageria: `ai_first_disponivel` pode retornar falso enquanto a projeção no Chatwoot ainda não confirmou a nova versão após a devolução. A interface deixa de interpretar esse estado como prova de que o bot não atende. Exibe “Aguardando automação” e informação neutra até a atualização automática confirmar a atividade; o estado confirmado continua “Automação responde”. A recusa por disponibilidade não confirmada também usa texto que não afirma que o bot está desligado.
- Regressão reproduzida antes da correção: devolução aceita com modo AI e disponibilidade ainda não confirmada mostrava o aviso falso. Agora o teste comprova a mensagem neutra e apenas um comando de devolução.
- Validação das correções: 98 testes focados aprovados, `typecheck`, ESLint dos arquivos alterados e `git diff --check` aprovados. A implementação administrativa anterior permanece no mesmo worktree.
