# O.R.B.I.T.A. - Orquestrador de Recursos, Bling e Integração de Tecnologias Avançadas

Orbita é um painel administrativo e orquestrador que integra o ERP **Bling v3** (vendas, produtos, clientes e NF-e) e a plataforma de atendimento **Chatwoot** (conversas e mensagens do WhatsApp) em uma única interface unificada, utilizando o **Supabase** como cache relacional seguro de alta performance.

---

## 🚀 Como Começar

### Pré-requisitos
* Node.js (versão recomendada: 20+)
* Docker Desktop para executar o banco de testes descartável

### 1. Laboratório descartável do banco

Instale as dependências e execute a suíte PostgreSQL/pgTAP:

```bash
npm ci
npm run test:db
```

O comando usa somente o projeto local `orbita-database-lab`, força `db reset` e `test db` com `--local` e remove os containers e volumes ao terminar, inclusive quando um teste falha. Ele não requer login, API key, senha ou acesso ao projeto Supabase hospedado.

> [!WARNING]
> Os arquivos em `database/` ainda representam o estado legado e não devem ser executados manualmente em um banco remoto. A baseline canônica e o ledger de migrations serão reconciliados nos tickets 14 e 15. Até lá, novos testes de RLS, grants e funções devem ser adicionados em `supabase/tests/database/`.

### 2. Configuração de Variáveis de Ambiente
Crie um arquivo `.env.local` na raiz do projeto copiando o modelo `.env.example` e preenchendo as suas chaves:

```bash
cp .env.example .env.local
```

### 3. Instalação e Execução
Inicie o servidor de desenvolvimento local:

```bash
npm run dev
```

Acesse o painel em `http://localhost:3000`.

---

## 🔒 Segurança e Modelo de Confiança

A arquitetura de segurança do Orbita foi desenhada seguindo o princípio do privilégio mínimo:
* **Leitura Pública/Browser:** Clientes autenticados no navegador utilizam a chave pública anon para subscrever a canais de realtime e fazer leituras do banco respeitando as regras de RLS (Row Level Security).
* **Escrita e Leituras Privilegiadas (Servidor):** Rotas de API e repositórios operam no servidor por meio de uma instância do Supabase que consome a chave privada `SUPABASE_SERVICE_ROLE_KEY`. Isso protege chaves de API e chaves criptográficas de autenticação e permite a execução de rotas críticas e webhooks sem expor credenciais ao cliente.

---

## 🛰️ Integrações e Fallback Mode

* **Bling v3:** Sincronização automatizada e bidirecional de produtos, contatos de clientes, faturamento de pedidos e emissão fiscal de notas.
* **Chatwoot:** Recepção de contatos, mensagens e conversações via webhook, com normalização de números telefônicos para formato E.164 (+55...) e vinculação inteligente entre conversas do WhatsApp e a base de clientes do ERP.
* **Modo de Simulação (MOCK_MODE):** Caso chaves de API externas não estejam presentes no arquivo `.env`, o sistema ativará automaticamente dados mockados para demonstração ou desenvolvimento, isolando erros de rede do fluxo transacional real.
