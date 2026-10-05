# Busca de empresa (Contatos e Financeiro)

A busca ajuda a **preencher** o cadastro de contato pessoa jurídica (e o de
fornecedor no Financeiro). Ela não grava: o contato só é salvo por "Salvar
contato", pelo fluxo de sempre (`POST /api/clientes/update`), com Bling-first,
retry seguro e `organization:manage` inalterados.

## Fluxo

1. A pessoa digita no campo "Buscar empresa" (só no cadastro novo).
2. Menos de 3 caracteres: nada é consultado.
3. CNPJ válido (dígitos verificadores corretos): consulta completa direta.
4. Outro texto: busca por nome, com debounce de 400 ms. Cada tecla cancela a
   requisição anterior, e uma resposta antiga nunca substitui uma mais nova.
5. Escolher uma sugestão dispara a **consulta completa por CNPJ**; o resumo da
   lista nunca preenche o formulário.
6. O preenchimento:
   - **Nome:** recebe a razão social. O nome fantasia aparece no aviso e só vira
     o nome se a pessoa clicar em "Usar nome fantasia como nome".
   - **Documento:** CPF/CNPJ recebe o CNPJ formatado.
   - **Contato e endereço:** e-mail, telefone, CEP, endereço, número, bairro,
     cidade e UF.
   - **Tipo:** vira `J`.
7. O **tipo de contribuinte não é deduzido**: ter CNPJ não diz se a empresa
   contribui ICMS. O valor escolhido fica, e o aviso pede para conferir.
8. Campos que a pessoa já tinha preenchido **não são sobrescritos** e aparecem
   listados no aviso. Campos vazios, ou ainda com o valor de uma busca anterior,
   recebem o da empresa escolhida.

## Rotas (servidor)

| Rota | Faz | Limite |
|---|---|---|
| `GET /api/empresas/cnpj/[cnpj]` | Consulta completa na BrasilAPI, validada (zod) e mapeada para o ORBITA | 20/min por pessoa da organização |
| `GET /api/empresas/busca?termo=` | Busca por nome via `EmpresaSearchProvider` (3 a 80 caracteres, até 8 sugestões) | 30/min por pessoa da organização |

As duas exigem sessão com organização verificada.
- **Rate limit:** limite estourado responde 429; armazenamento de rate limit
  indisponível responde 503 (falha fechada).
- **URL:** o endpoint externo é fixo no servidor (`BRASILAPI_CNPJ_URL`
  opcional, só servidor); nenhuma URL vem do cliente.
- **Log:** não leva o termo, a chave nem o payload do provedor, só a categoria
  da falha.
- **Financeiro:** o cadastro de fornecedor consultava a BrasilAPI direto do
  navegador e agora usa a mesma rota.

## Busca por nome: provedor pendente de decisão

A BrasilAPI não tem busca livre por nome, e o ORBITA não faz scraping. A busca
por nome depende de um provedor comercial atrás de `EmpresaSearchProvider`
(`src/services/empresas/buscaDeEmpresas.ts`), com a chave **só no servidor**
(nunca `NEXT_PUBLIC_*`). Enquanto nenhum provedor estiver contratado,
`provedorDeBuscaConfigurado()` devolve `null`. A rota responde
`BuscaPorNomeIndisponivel`, e a tela orienta a informar o CNPJ ou preencher
manualmente.

Para plugar: implementar `buscar(termo, limite)` para o provedor escolhido e
devolvê-lo de `provedorDeBuscaConfigurado()` quando a variável da chave existir.
