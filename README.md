# O.R.B.I.T.A. - Orquestrador de Recursos, Bling e Integração de Tecnologias Avançadas

Orbita é um painel administrativo e orquestrador que integra o ERP **Bling v3** (vendas, produtos, clientes e NF-e) e a plataforma de atendimento **Chatwoot** (conversas e mensagens do WhatsApp) em uma única interface unificada, utilizando o **Supabase** como cache relacional seguro de alta performance.

---

## 🚀 Como Começar

### Pré-requisitos
* Node.js (versão recomendada: 20+)
* Banco de dados PostgreSQL (Supabase recomendado)

### 1. Configuração do Banco de Dados
Para configurar a estrutura e as regras de negócio de banco de dados, acesse o editor SQL do Supabase e execute os scripts na seguinte ordem:

* **Para uma base nova:**
  1. Execute o arquivo [`database/schema.sql`](file:///c:/Users/mateu/OneDrive/Documentos/Mateus/Orbita/database/schema.sql)
  2. Execute o arquivo [`database/triggers.sql`](file:///c:/Users/mateu/OneDrive/Documentos/Mateus/Orbita/database/triggers.sql)

* **Para uma base preexistente:**
  1. Execute o arquivo [`database/migration.sql`](file:///c:/Users/mateu/OneDrive/Documentos/Mateus/Orbita/database/migration.sql)
  2. Execute o arquivo [`database/triggers.sql`](file:///c:/Users/mateu/OneDrive/Documentos/Mateus/Orbita/database/triggers.sql)

> [!NOTE]
> O arquivo [`docs/PLANO_DE_TESTES.md`](file:///c:/Users/mateu/OneDrive/Documentos/Mateus/Orbita/docs/PLANO_DE_TESTES.md) possui scripts autossuficientes e casos de teste prontos para serem rodados no banco de dados para atestar as triggers e constraints.

### 2. Configuração de Variáveis de Ambiente
Crie um arquivo `.env.local` na raiz do projeto copiando o modelo de [`env.example`](file:///c:/Users/mateu/OneDrive/Documentos/Mateus/Orbita/.env.example) e preenchendo as suas chaves:

```bash
cp .env.example .env.local
```

### 3. Instalação e Execução
Instale as dependências e inicie o servidor de desenvolvimento local:

```bash
npm install
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
