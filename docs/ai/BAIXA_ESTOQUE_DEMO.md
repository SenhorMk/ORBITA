# Demonstração de baixa de estoque pelo assistente

## Roteiro no laboratório

1. Entre no ORBITA como proprietário ou administrador da **Loja Demonstração**, em um banco isolado. Se a inicialização oferecer modo offline, use **Ignorar (Modo Offline)**.
2. Em **Estoque & Produtos → Assistente de estoque**, pergunte “Quanto temos em estoque do SKU DEMO-BANCA?”. O laboratório começou com 8 unidades físicas, 2 reservadas e 6 disponíveis.
3. Pergunte “Dê baixa de uma unidade desse produto.” Confira o nome, a quantidade e o saldo na proposta. A proposta dura cinco minutos.
4. Clique uma vez em **Confirmar baixa**. O recibo mostra 5 disponíveis e o identificador de auditoria. Se a conexão cair, repita a confirmação no mesmo cartão para recuperar o recibo pela mesma chave.
5. Repita a consulta por SKU. O laboratório retornou 7 físicas, 2 reservadas e 5 disponíveis.

O navegador usou autenticação real do Supabase descartável e Groq real. O banco registrou uma movimentação, um evento `inventory.demo_debit_applied`, nenhuma conexão de integração e nenhum envio para a outbox. Auditoria do ensaio `b268d749-cf99-42bc-bd9f-cf51cf16e70f`. Chave da operação `c4aa00d2-24f0-4cb2-8158-84b541548f34`.

## Proteções e testes

A migration de ordem 105 cria propostas privadas com chave única por organização e uma lista de produtos de demonstração inicialmente vazia. O servidor exige `organization:manage` nas duas etapas. A confirmação recebe a chave da proposta. O banco revalida o vínculo e o papel persistido, trava a organização, a proposta e o produto, e aplica uma baixa somente se houver saldo disponível. Movimento, auditoria e recibo são gravados na mesma transação. Uma confirmação repetida devolve o recibo original enquanto o ator continuar autorizado.

`npm run test:db` roda a migration e os testes de autorização, escopo, validade, reserva, dupla confirmação simultânea e perda simulada da resposta após commit. A suíte confirma uma movimentação e uma auditoria por sucesso e nenhuma saída de integração. Os testes da rota de confirmação rejeitam parâmetros extras e verificam os limites da sessão.

## Acesso para a banca

O laboratório atual usa endereços de loopback e roda no computador que hospeda o banco. O preview do PR #164 contém a consulta. A branch da baixa tem autoimplantação desabilitada por configuração de branch.

Para demonstrar de outro computador, após aprovação, use um projeto Supabase descartável exclusivo para a banca. Aplique a cadeia versionada com a ordem 105, crie o usuário gestor e uma organização sintética sem conexões de integração, e autorize no banco o par organização/produto de teste em `estoque_baixa_demo_produtos`. O produto deve estar ativo, ter SKU inequívoco e identificador local iniciado por `local-`.

Configure um preview manual protegido com as credenciais apenas do projeto descartável, `GROQ_API_KEY` no servidor e `ORBITA_BAIXA_DEMO_ENABLED=true`. Autorize o acesso ao preview para os avaliadores previstos e teste o login a partir do segundo computador. O navegador acessa a aplicação por HTTPS. Preserve a porta do PostgreSQL fora do acesso público e mantenha o Bling desconectado.
