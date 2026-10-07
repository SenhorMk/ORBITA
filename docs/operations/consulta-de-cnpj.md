# Consulta de CNPJ no cadastro de contatos

A consulta ajuda a **preencher** o cadastro de um contato pessoa jurídica. Ela
não grava: o contato só é salvo por "Salvar contato", pelo fluxo de sempre
(`POST /api/clientes/update`), com Bling-first, retry seguro, reconciliação e
`organization:manage` inalterados.

## Fluxo

1. A pessoa digita o CNPJ no campo "Consultar CNPJ" (só no cadastro novo),
   com ou sem pontuação.
2. Incompleto: nada é consultado. 14 dígitos com verificador errado, ou
   sequência repetida: "CNPJ inválido", sem requisição. Letras: a tela avisa
   que a consulta é só por CNPJ, sem requisição.
3. CNPJ válido: uma consulta, 400 ms depois da última tecla. Cada tecla cancela
   a anterior, uma resposta antiga nunca substitui uma mais nova, e fechar o
   modal cancela a que estiver no ar.
4. O preenchimento:
   - **CPF/CNPJ:** recebe sempre o CNPJ consultado, porque é ele que identifica
     a empresa. Se a pessoa tinha digitado outro documento, a tela diz qual foi
     substituído.
   - **Nome:** a razão social. O nome fantasia aparece no aviso e só vira o
     nome se a pessoa clicar em "Usar nome fantasia como nome".
   - **Contato e endereço:** e-mail, telefone, CEP, endereço, número, bairro,
     cidade e UF.
   - **Tipo de pessoa:** `J`.
   - Campos que a pessoa já tinha preenchido com outro valor **não são
     sobrescritos** e aparecem listados no aviso. Campos vazios, ou ainda com o
     valor de uma consulta anterior, recebem o da empresa consultada.
   - O aviso usa o formulário como ele está quando a resposta chega: o que se
     digita durante a consulta também é preservado.
5. **Tipo de contribuinte não é deduzido.** Ter CNPJ não diz se a empresa
   contribui ICMS. O campo continua como estava e o aviso pede para conferir.
6. Se, depois do preenchimento, o CPF/CNPJ do formulário deixar de ser o da
   empresa consultada, a tela alerta e **"Salvar contato" é recusado** até a
   pessoa corrigir o documento ou clicar em "Descartar consulta", que assume os
   dados como estão.

## Tipo de pessoa e tipo de contribuinte no cadastro

Valem para qualquer contato, com ou sem consulta:

- `indicadorIe` do Bling: `1` contribuinte ICMS, `2` contribuinte isento,
  `9` não contribuinte. É sempre escolha explícita: nada pré-selecionado
  quando o contato não tem classificação gravada, e digitar um documento não o
  altera. `POST /api/clientes/update` recusa corpo sem `tipo` ou sem
  `indicadorIe` (400, `retrySafe`).
- Tipo de pessoa: um documento **válido** indica `J` (CNPJ) ou `F` (CPF),
  salvo `E` (estrangeiro), que é escolha explícita. Documento inválido não
  indica nada.

## Rota (servidor)

| Rota | Faz | Limite |
|---|---|---|
| `GET /api/empresas/cnpj/[cnpj]` | Consulta na BrasilAPI, validada (zod) e mapeada para o ORBITA | 20/min por pessoa da organização |

- **Acesso:** sessão com organização verificada e `organization:manage`, a mesma
  capacidade que salvar o contato exige. Sem ela: 403 `SemPermissao`.
- **Entrada:** CNPJ inválido é recusado (400) antes do rate limit e do provedor.
- **Rate limit:** estourado responde 429; armazenamento indisponível responde
  503 (falha fechada).
- **Provedor:** endpoint decidido no servidor (`BRASILAPI_CNPJ_URL`, só servidor, opcional; padrão: a BrasilAPI pública), com prazo de 8 s. Resposta de outro
  CNPJ, corpo vazio, JSON inválido ou fora do contrato: 503
  `ConsultaIndisponivel`. 404 do provedor: `EmpresaNaoEncontrada`.
- **Log:** só a categoria da falha; nunca o payload do provedor.
- **Escrita:** nenhuma, nem no Supabase nem no Bling.

## Fora desta entrega

- **Busca por nome.** A BrasilAPI só consulta por CNPJ, e o ORBITA não faz
  scraping nem simula resultados. A busca por nome depende de um provedor
  comercial ainda não escolhido. Quando houver: uma rota própria no servidor,
  com a chave só no servidor (nunca `NEXT_PUBLIC_*`), atrás de uma porta que
  devolva sugestões; escolher uma sugestão leva à mesma consulta completa por
  CNPJ desta página.
- **Cadastro de fornecedor (Financeiro).** Continua como na `main`: consulta a
  BrasilAPI pelo navegador e tem um contrato quebrado com
  `POST /api/financeiro/fornecedores`. A correção é um PR próprio.

## Smoke autenticado (pendente, exige sessão da proprietária)

1. Contatos → novo contato → "Consultar CNPJ" com um CNPJ real conhecido.
2. Conferir cada campo preenchido, o aviso "Empresa consultada" e o tipo `J`.
3. Conferir que o tipo de contribuinte continua sem escolha.
4. Editar um campo à mão e consultar de novo: o campo editado fica e é listado.
5. CNPJ com verificador errado e texto com letras: aviso, sem consulta.
6. Antes de salvar, conferir em Contatos e no Bling que nada foi criado.
7. Salvar, **só em ambiente controlado e com autorização**: um contato no
   Bling, com o `indicadorIe` escolhido.
