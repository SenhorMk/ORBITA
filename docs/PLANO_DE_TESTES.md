# PLANO DE TESTES DE SOFTWARE E GARANTIA DE QUALIDADE

**Projeto:** O.R.B.I.T.A. (Orquestrador de Recursos, Bling e Integração de Tecnologias Avançadas)  
**Objetivo:** Validar o comportamento do sistema sob condições normais de uso (Caminho Feliz), cenários de indisponibilidade ou falhas externas (Testes de Resiliência/Falha), e garantir que as Regras de Negócio implementadas no banco de dados impeçam inconsistências transacionais.

---

## 1. METODOLOGIA E CASOS DE TESTE

Em engenharia de software, a garantia de que as regras lógicas e físicas funcionam corretamente depende da definição de **Casos de Teste (CT)**. Cada caso de teste especifica:
- **Ação:** O evento originado pelo usuário ou integração externa.
- **Resultado Esperado (Sucesso):** O comportamento regular esperado do sistema.
- **Teste de Falha (Exceção/Resiliência):** O que ocorre se houver falha de infraestrutura, indisponibilidade ou tentativa de violação de dados.
- **Garantia Física no Banco:** A constraint ou trigger que atua como última linha de defesa a nível de banco de dados.

---

## 2. MATRIZ DE CASOS DE TESTE (Tabela Estruturada)

| ID | Componente | Ação do Usuário | Resultado Esperado (Sucesso) | Teste de Falha (Cenário de Exceção) | Garantia Nativa no Banco (Supabase/Postgres) |
|---|---|---|---|---|---|
| **CT-001** | **ETL / Sincronização** | Clicar no botão **"Sincronizar"** no Dashboard para importar dados em lote do ERP Bling. | Os dados de contatos, produtos e pedidos são lidos e gravados no cache do Supabase com sucesso. | Caso o usuário clique consecutivamente durante um processo ativo, o sistema exibe o aviso: *"Uma sincronização já está em execução"*, impedindo concorrência. | Clausula `ON CONFLICT (bling_id)` evita registros duplicados e garante a idempotência dos dados. |
| **CT-002** | **ETL / Resiliência** | Falha ou oscilação de rede de internet no meio do processo de sincronização de lote. | O sistema faz novas tentativas de conexão até completar ou abortar graciosamente. | O processo de sincronização é interrompido com erro exibido no console; os dados inseridos são mantidos de forma íntegra e não há corrupção. | O PostgreSQL gerencia as inserções dentro de transações atômicas relacionais nativas. |
| **CT-003** | **Faturamento / Emissão** | Clicar em **"Emitir NF-e"** para 50 pedidos ao mesmo tempo (lote). | O sistema envia as 50 requisições individuais ao Bling e atualiza os status locais para `"Atendido"`. | Caso 5 das 50 requisições falhem (ex: limite de API do Bling), esses 5 pedidos retornam ao status `"A Emitir"` com erro amigável, enquanto os outros 45 faturam. | A tabela `nfes` possui chave `UNIQUE (pedido_id)` que impede faturamento duplicado de um mesmo pedido sob concorrência. |
| **CT-004** | **Faturamento / Queda de Rede** | Ocorre queda total de conexão com o servidor Bling durante o processamento do lote de NF-e. | As notas que já foram criadas com sucesso no Bling são persistidas no Supabase local. | O sistema exibe o aviso *"Falha de conexão com o Bling"*; os pedidos restantes não faturados sofrem Rollback e retornam de imediato ao status `"A Emitir"`. | O banco de dados bloqueia alterações no status do pedido caso a criação física da NF-e falhe, revertendo a transação. |
| **CT-005** | **Integridade / Segurança** | Tentar excluir um **Cliente** que possui um ou mais **Pedidos ativos** no sistema. | O sistema bloqueia a ação na interface do usuário se detectar relacionamentos pendentes. | Se uma requisição direta de exclusão (via API ou terminal) for disparada, a operação é rejeitada fisicamente com código de erro `PG-23503`. | A chave estrangeira `fk_pedido_cliente` está definida como `ON DELETE RESTRICT` na tabela `pedidos`, impedindo a deleção do cliente. |
| **CT-006** | **Integridade / Domínio** | Cadastrar ou atualizar um **Produto** com preço negativo (ex: `preco = -15.50`). | O sistema rejeita o valor negativo diretamente no formulário da interface. | Se uma requisição direta burlar o front-end e enviar o valor negativo, o banco de dados recusa a inserção e cancela a transação. | `CONSTRAINT chk_produto_preco CHECK (preco >= 0.00)` na tabela de `produtos`. |
| **CT-007** | **Regra de Negócio / Estoque** | Inserir um novo registro na tabela `itens_pedido` com a quantidade igual a `3`. | O banco registra o item do pedido e deduz exatamente `3` unidades do saldo atual de estoque do produto correspondente. | N/A (Ação automatizada sem intervenção manual do usuário ou do código do Next.js). | A trigger nativa `tg_atualizar_estoque` no evento `AFTER INSERT` atualiza o estoque de produtos no PostgreSQL. |
| **CT-008** | **Regra de Negócio / Limite** | Tentar inserir um item de pedido cuja quantidade é superior ao estoque atual do produto (Venda sem estoque). | O front-end avisa que o estoque é insuficiente e desabilita o fechamento. | Se for enviada uma requisição direta, o banco tenta subtrair a quantidade e bate no valor menor que zero. A operação é abortada e a transação inteira sofre Rollback. | `CONSTRAINT chk_produto_estoque CHECK (estoque >= 0)` associada à Trigger de estoque impede fisicamente o saldo negativo. |

---

## 3. ROTEIRO DE VERIFICAÇÃO PARA A BANCA EXAMINADORA

Para que as constraints e triggers funcionem em um banco de dados onde as tabelas **já existiam anteriormente**, é necessário aplicar as regras de negócio explicitamente usando comandos `ALTER TABLE`. Se você apenas rodou o `CREATE TABLE IF NOT EXISTS` em tabelas que já tinham sido criadas antes, o PostgreSQL ignorou as novas restrições e gatilhos.

Siga os dois passos abaixo no editor SQL do Supabase para configurar e testar com sucesso.

---

### PASSO 1: Garantir que as Regras e Gatilhos estão aplicados (Tabelas Preexistentes)

Cole e execute este bloco de código para aplicar as restrições e gatilhos em suas tabelas atuais:

```sql
-- 0. Limpar registros de teste inválidos que violam as restrições
DELETE FROM produtos WHERE preco < 0 OR estoque < 0;

-- 1. Aplicar constraints de domínio às tabelas existentes
ALTER TABLE produtos DROP CONSTRAINT IF EXISTS chk_produto_preco;
ALTER TABLE produtos ADD CONSTRAINT chk_produto_preco CHECK (preco >= 0.00);

ALTER TABLE produtos DROP CONSTRAINT IF EXISTS chk_produto_estoque;
ALTER TABLE produtos ADD CONSTRAINT chk_produto_estoque CHECK (estoque >= 0);

ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS chk_pedido_total;
ALTER TABLE pedidos ADD CONSTRAINT chk_pedido_total CHECK (total >= 0.00);

ALTER TABLE itens_pedido DROP CONSTRAINT IF EXISTS chk_item_quantidade;
ALTER TABLE itens_pedido ADD CONSTRAINT chk_item_quantidade CHECK (quantidade > 0);

ALTER TABLE itens_pedido DROP CONSTRAINT IF EXISTS chk_item_valor_unitario;
ALTER TABLE itens_pedido ADD CONSTRAINT chk_item_valor_unitario CHECK (valor_unitario >= 0.00);

-- 2. Garantir integridade referencial impeditiva na exclusão de clientes
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS fk_pedido_cliente;
ALTER TABLE pedidos ADD CONSTRAINT fk_pedido_cliente FOREIGN KEY (cliente_id) 
    REFERENCES clientes(id) 
    ON DELETE RESTRICT;

-- 3. Garantir integridade na exclusão dos itens e produtos
ALTER TABLE itens_pedido DROP CONSTRAINT IF EXISTS fk_item_produto;
ALTER TABLE itens_pedido ADD CONSTRAINT fk_item_produto FOREIGN KEY (produto_id) 
    REFERENCES produtos(id) 
    ON DELETE RESTRICT;
```

*(Certifique-se de executar também o código do arquivo `database/triggers.sql` no Supabase para registrar as funções de estoque).*

---

### PASSO 2: Script de Teste Completo e Autossuficiente (Sem Erros de Sintaxe ou UUID)

Para evitar erros de formatação de UUID (como a mensagem de erro `22P02: invalid input syntax for type uuid: "ID_DE_UM_CLIENTE_VALIDO"`), utilize este script de teste unificado que usa UUIDs sintáticos válidos.

Você pode colar e executar cada bloco individualmente no editor SQL do Supabase:

#### 3.1 Preparação do Ambiente de Testes (Massa de Dados)
Insere um cliente de teste e um produto de teste com estoque inicial de 100 unidades:
```sql
-- Insere um Cliente com UUID sintático válido
INSERT INTO clientes (id, bling_id, nome, cpf_cnpj, email, telefone)
VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'cli-teste-123', 'Cliente Teste Integridade', '12345678901', 'teste@email.com', '11999999999')
ON CONFLICT (bling_id) DO UPDATE SET nome = EXCLUDED.nome;

-- Insere um Produto com UUID sintático válido e estoque 100
INSERT INTO produtos (id, bling_id, nome, preco, estoque)
VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'prod-teste-123', 'Produto Teste Integridade', 10.00, 100)
ON CONFLICT (bling_id) DO UPDATE SET estoque = EXCLUDED.estoque, preco = EXCLUDED.preco;
```

#### 3.2 Teste de Preço Negativo (CT-006)
Tente cadastrar um produto com preço negativo:
```sql
-- Este comando DEVE FALHAR e disparar erro chk_produto_preco
INSERT INTO produtos (id, bling_id, nome, preco, estoque)
VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'prod-teste-negativo', 'Produto Negativo Teste', -5.50, 10);
```
* **Erro esperado no Supabase:**  
  `ERROR: new row for relation "produtos" violates check constraint "chk_produto_preco"`

#### 3.3 Teste de Exclusão Impeditiva de Cliente (CT-005)
Crie um pedido vinculado ao cliente e tente excluí-lo:
```sql
-- 1. Cria o pedido vinculado ao cliente criado no item 3.1
INSERT INTO pedidos (id, bling_id, numero, data, total, status, cliente_id)
VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'ped-teste-123', '88888', now(), 50.00, 'Aberto', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
ON CONFLICT (bling_id) DO UPDATE SET total = EXCLUDED.total;

-- 2. Tenta excluir o cliente (DEVE FALHAR pela integridade referencial RESTRICT)
DELETE FROM clientes WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
```
* **Erro esperado no Supabase:**  
  `ERROR: update or delete on table "clientes" violates foreign key constraint "fk_pedido_cliente" on table "pedidos"`  
  *(ou erro personalizado da trigger: `Não é permitido excluir o cliente "Cliente Teste Integridade"...`)*

#### 3.4 Teste da Trigger de Estoque - INSERT (CT-007)
Insira um item no pedido com quantidade `5` e consulte o saldo de estoque do produto:
```sql
-- 1. Insere o item de pedido vinculando o produto (estoque inicial 100) com quantidade 5
INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, valor_unitario)
VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 5, 10.00);

-- 2. Consulta o estoque físico do produto
SELECT nome, estoque FROM produtos WHERE id = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
```
* **Resultado esperado:** O estoque do produto deve ser exatamente **95** (provando que a trigger deduziu o estoque).

#### 3.5 Teste de Venda Sem Estoque / Limite (CT-008)
Tente inserir um item com quantidade superior ao estoque atual (estoque atual é 95, tentaremos vender 120):
```sql
-- Este comando DEVE FALHAR porque violaria chk_produto_estoque (estoque < 0)
INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, valor_unitario)
VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 120, 10.00);
```
* **Erro esperado no Supabase:**  
  `ERROR: new row for relation "produtos" violates check constraint "chk_produto_estoque"`

#### 3.6 Teste da Trigger de Estoque - DELETE (CT-007)
Deleta o item do pedido e verifica se o estoque voltou ao estado original:
```sql
-- 1. Deleta o item de quantidade 5
DELETE FROM itens_pedido 
WHERE pedido_id = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33' 
  AND produto_id = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

-- 2. Consulta o estoque físico do produto
SELECT nome, estoque FROM produtos WHERE id = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
```
* **Resultado esperado:** O estoque do produto deve ter retornado para **100** (provando que a trigger devolveu o estoque ao excluir o item).
