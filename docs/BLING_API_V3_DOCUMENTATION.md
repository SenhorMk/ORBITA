# 📚 Documentação Técnica: Integração Bling API v3 & Supabase — Projeto Órbita

> **⚠️ REGRA CRÍTICA**: Todo salvamento de dados (produto, contato, pedido) DEVE ser **duplo**:
> primeiro no Bling ERP v3 (para obter o `bling_id` oficial) e depois no Supabase (cache relacional).
> Se um dos dois falhar, exibir o `ErrorLogModal` com log detalhado.

---

## 🔐 1. Autenticação OAuth 2.0

### Headers Padrão (TODAS as requisições):
```http
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
Accept: application/json
```

### Renovação de Token:
- **Endpoint**: `POST https://www.bling.com.br/Api/v3/oauth/token`
- **Headers**:
  ```http
  Authorization: Basic <base64(client_id:client_secret)>
  Content-Type: application/x-www-form-urlencoded
  enable-jwt: 1
  ```
- **Body**: `grant_type=refresh_token&refresh_token=<REFRESH_TOKEN>`
- **Validade do access_token**: ~6 horas
- **Validade do refresh_token**: ~30 dias
- **Auto-refresh**: O `BlingClient.fetchWithAuth()` detecta HTTP 401 e renova automaticamente

---

## 📦 2. Produtos — `/Api/v3/produtos`

### ⚠️ CAMPOS OBRIGATÓRIOS para POST (criar):
| Campo       | Tipo    | Valor Padrão | Descrição                                    |
|-------------|---------|--------------|----------------------------------------------|
| `nome`      | string  | —            | Nome do produto (OBRIGATÓRIO)                |
| `tipo`      | string  | `"P"`        | `"P"` = Produto, `"S"` = Serviço             |
| `situacao`  | string  | `"A"`        | `"A"` = Ativo, `"I"` = Inativo               |
| `formato`   | string  | `"S"`        | `"S"` = Simples, `"V"` = Variações, `"E"` = Composição |
| `preco`     | number  | `0`          | Preço de venda                               |
| `unidade`   | string  | `"UN"`       | Unidade de medida (OBRIGATÓRIO para NF-e)    |

### ⚠️ ERROS COMUNS:
- **`format` vs `formato`**: O campo correto é **`formato`** (NÃO `format`!)
- **Falta de `situacao`**: Sem este campo o Bling pode rejeitar o produto
- **Falta de `unidade`**: Sem este campo não é possível emitir NF-e

### POST — Criar Produto
```
POST https://api.bling.com.br/Api/v3/produtos
```
```json
{
  "nome": "Kuripe Floral",
  "codigo": "KFL-001",
  "preco": 100.00,
  "tipo": "P",
  "situacao": "A",
  "formato": "S",
  "unidade": "UN"
}
```
**Resposta (201)**: `{ "data": { "id": 16678912340 } }`

### PUT — Atualizar Produto
```
PUT https://api.bling.com.br/Api/v3/produtos/{idProduto}
```
Mesma estrutura JSON. Campos obrigatórios: `tipo`, `situacao`, `formato`.

### PATCH — Atualização Parcial
```
PATCH https://api.bling.com.br/Api/v3/produtos/{idProduto}
```
Permite enviar apenas os campos que deseja alterar.

### GET — Listar Produtos
```
GET https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=100
```

---

## 👤 3. Contatos — `/Api/v3/contatos`

### ⚠️ CAMPOS OBRIGATÓRIOS para POST (criar):
| Campo          | Tipo    | Valor Padrão | Descrição                                      |
|----------------|---------|--------------|------------------------------------------------|
| `nome`         | string  | —            | Nome do contato (OBRIGATÓRIO)                  |
| `tipo`         | string  | `"F"`        | `"F"` = Pessoa Física, `"J"` = Jurídica, `"E"` = Estrangeiro |
| `contribuinte` | integer | `9`          | `1` = Contribuinte ICMS, `2` = Isento, `9` = Não contribuinte |

### ⚠️ ERROS COMUNS:
- **`telefone` vs `fone`**: O campo correto é **`fone`** (NÃO `telefone`!)
- **Falta de `contribuinte`**: O Bling REJEITA contatos sem este campo
- **CPF vs CNPJ**: Se `numeroDocumento` tem 14 dígitos → `tipo: "J"`, `contribuinte: 1`

### POST — Criar Contato
```
POST https://api.bling.com.br/Api/v3/contatos
```
```json
{
  "nome": "João da Silva",
  "tipo": "F",
  "contribuinte": 9,
  "email": "joao@email.com",
  "fone": "11987654321",
  "numeroDocumento": "12345678900"
}
```
**Resposta (201)**: `{ "data": { "id": 16678912340 } }`

### PUT — Atualizar Contato
```
PUT https://api.bling.com.br/Api/v3/contatos/{idContato}
```

---

## 🧾 4. Pedidos de Venda — `/Api/v3/pedidos/vendas`

### GET — Listar Pedidos
```
GET https://api.bling.com.br/Api/v3/pedidos/vendas?pagina=1&limite=100&dataInicial=2024-01-01
```

---

## 📄 5. Notas Fiscais — `/Api/v3/nfe`

### POST — Emitir NF-e
```
POST https://api.bling.com.br/Api/v3/nfe
```

---

## 🔄 6. Fluxo de Sincronização Bidirecional

### Ao Criar/Editar na UI do App:
1. Extrair campos do formulário (nome, código, preço, estoque)
2. **Primeiro**: Enviar `POST` ou `PUT` para o Bling ERP v3
3. Capturar o `data.id` retornado pelo Bling (ID numérico oficial)
4. **Segundo**: Salvar no Supabase via `upsert({ ..., bling_id: <ID_REAL> })`
5. Se qualquer etapa falhar → abrir `ErrorLogModal` com o log completo

### Ao Clicar "Sincronizar Bling":
1. **Pull (Bling → Supabase)**: Buscar todos os produtos/contatos/pedidos do Bling e atualizar Supabase
2. **Push Diferencial (Supabase → Bling)**: Para cada registro no Supabase cujo `bling_id` **não é numérico** (ex: `LOCAL-`, `prod-teste-`), enviar `POST` ao Bling para criar e atualizar o `bling_id` real

### Detecção de Dessincronia:
- **Produto local sem Bling**: `bling_id` não é numérico (`/^\d+$/.test(bling_id)` retorna `false`)
- **Produto no Bling sem local**: Pull automático durante sincronização

---

## ⚡ 7. Rate Limiting
- **Limite**: 3 requisições por segundo
- **Limite diário**: Variável por plano
- **Erro 429**: Contém campos `period` e `limit` na resposta
