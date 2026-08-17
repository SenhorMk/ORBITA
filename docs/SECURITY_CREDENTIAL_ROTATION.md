# Rotação de credenciais do ORBITA

## Estado

O histórico do repositório contém versões antigas do arquivo de ambiente. Os valores não são reproduzidos neste documento. Remover o arquivo do estado atual do Git não revoga credenciais já expostas; cada provedor deve invalidá-las.

## Credenciais que exigem ação do proprietário

- Supabase: rotacionar a chave de service role exposta e revisar chaves legadas do projeto.
- OpenAI: revogar a chave histórica e criar outra somente se ainda houver uso aprovado.
- Google Gemini: revogar a chave histórica e criar outra somente se ainda houver uso aprovado.
- NVIDIA NIM: revogar a chave histórica e criar outra somente se ainda houver uso aprovado.
- Bling: confirmar que client secret e tokens atuais nunca reutilizam valores que passaram pelo repositório.
- Chatwoot: confirmar que API token e webhook secret atuais nunca reutilizam valores que passaram pelo repositório.

## Sequência segura

1. Criar a nova credencial no painel oficial do provedor.
2. Atualizar o ambiente de desenvolvimento e o cofre do ambiente hospedado sem enviar o valor por chat, issue ou commit.
3. Validar o fluxo mínimo correspondente.
4. Revogar a credencial antiga.
5. Registrar somente data, provedor, responsável e resultado — nunca o valor.

## Evidência de conclusão

| Provedor | Credencial | Rotacionada em | Validada por | Antiga revogada |
|---|---|---|---|---|
| Supabase | service role / chaves legadas | pendente | pendente | pendente |
| OpenAI | API key histórica | pendente | pendente | pendente |
| Google Gemini | API key histórica | pendente | pendente | pendente |
| NVIDIA NIM | API key histórica | pendente | pendente | pendente |
| Bling | client secret e tokens | pendente | pendente | pendente |
| Chatwoot | API token e webhook secret | pendente | pendente | pendente |

Reescrita de histórico é uma operação separada e coordenada. Ela não substitui rotação e não deve ocorrer enquanto houver clones ou branches ativas sem um plano de sincronização.
