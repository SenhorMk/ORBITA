# MSG-012 — Alternativas elegíveis de produto

## Escopo deste PR

A main `34d103f` já oferece vínculo de cliente e retrato de pedido por conversa (MSG-010/011). O chatbot comercial consulta catálogo e linhas por termos, para orientar atendimento. Esse caminho não comprova compatibilidade, quantidade suficiente nem diferença em centavos para troca.

Este PR implementa o ranking de domínio e o port de leitura, com fonte sintética nos testes. O port recebe escopo verificado e referência de conversa, pedido, item e quantidade. O retorno é versionado e entrega até três candidatos, com razões e delta total em centavos. A ordem é preferência informada entre os elegíveis, menor diferença absoluta e UUID estável. Duplicatas contraditórias são descartadas. Candidato de outro tenant, inativo, arquivado, sem quantidade, sem preço ou com frescor insuficiente fica fora.

## Dependências da conclusão e habilitação

Falta ligar o port a uma fonte de compatibilidade versionada, comprovada por produto/variante e organização, e fazer a prova ponta a ponta por pedido do cliente confirmado. Sem essa fonte, a aplicação deve retornar zero alternativas elegíveis. Nome de produto, categoria e recomendação livre da IA não comprovam essa equivalência.

Nenhum endpoint, worker, serviço remoto, migration ou efeito foi adicionado. O PR é uma dependência da MSG-015, não autorização para aprovar troca nem execução. PRE-003 e PRE-004 continuam gates para catálogo real.

[Contrato oficial MSG-012](https://docs.google.com/document/d/1RZ0f8YWcelIz9j84wRd6gilNyN8HnRpp/edit)
