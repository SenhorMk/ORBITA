export interface ConteudoDeAjuda {
  readonly titulo: string;
  readonly oQueE: string;
  readonly comoUsar: string;
  readonly depois: string;
  readonly atencao: string;
}

/** Conteúdo estático: sem dados de clientes, tokens ou respostas de API. */
export const catalogoDeAjuda = {
  "painel.visao": {
    "titulo": "Ler o resumo da organização ativa",
    "oQueE": "Os números resumem os dados disponíveis da organização ativa.",
    "comoUsar": "Selecione uma métrica para mudar a análise exibida abaixo.",
    "depois": "A seleção muda apenas a visualização; não altera pedidos ou valores.",
    "atencao": "Um erro de leitura não significa zero. Confira o período e a organização antes de comparar."
  },
  "painel.analise": {
    "titulo": "Interpretar a análise selecionada",
    "oQueE": "A área analítica mostra a série, distribuição ou fila disponível para a métrica escolhida.",
    "comoUsar": "Leia o título, o período e a legenda; troque a métrica nos cartões superiores.",
    "depois": "O gráfico acompanha a seleção sem criar dados novos.",
    "atencao": "Ausência de dados não é tendência nem previsão. Totais diferentes podem usar recortes diferentes."
  },
  "vendas.lista": {
    "titulo": "Encontrar pedidos pelo recorte exibido",
    "oQueE": "Esta lista reúne pedidos da organização ativa e os indicadores do recorte apresentado.",
    "comoUsar": "Use busca e filtros de situação; abra uma linha para conferir os detalhes.",
    "depois": "Os filtros mudam a lista exibida, sem atualizar o pedido no Bling.",
    "atencao": "Confira filtros e sincronização antes de concluir que um pedido não existe."
  },
  "vendas.detalhe": {
    "titulo": "Consultar os detalhes sem sair da lista",
    "oQueE": "O detalhe reúne os dados disponíveis do pedido selecionado e suas ações permitidas.",
    "comoUsar": "Confira cliente, itens, valores e situação antes de editar, cancelar ou abrir a conversa.",
    "depois": "Abrir o detalhe é uma consulta. As ações seguintes podem exigir confirmação.",
    "atencao": "Dados locais podem estar desatualizados. Abrir o chat não confirma identidade ou entrega."
  },
  "vendas.manual": {
    "titulo": "Registrar pedido manual com segurança",
    "oQueE": "O pedido manual registra uma venda com cliente, itens, quantidades e condições informadas.",
    "comoUsar": "Selecione os itens e revise cliente, estoque, valores, pagamento e frete antes de confirmar.",
    "depois": "O sistema tenta registrar o pedido e informa o resultado ou uma pendência.",
    "atencao": "Se o resultado ficar pendente ou incerto, confira a pendência antes de criar outro pedido."
  },
  "vendas.editar": {
    "titulo": "Revisar alterações do pedido",
    "oQueE": "A edição permite alterar os campos habilitados do pedido existente.",
    "comoUsar": "Revise os dados e confirme somente as alterações pretendidas.",
    "depois": "O sistema tenta salvar e apresenta sucesso, recusa ou erro.",
    "atencao": "Falha de comunicação não comprova que nada mudou. Releia o pedido antes de repetir."
  },
  "vendas.cancelar": {
    "titulo": "Entender os efeitos do cancelamento",
    "oQueE": "O cancelamento muda a situação do pedido; não é apenas fechar esta janela.",
    "comoUsar": "Confira o número, o cliente e as consequências exibidas antes de confirmar.",
    "depois": "O sistema registra a operação ou informa uma pendência para acompanhamento.",
    "atencao": "Não repita uma operação com resultado incerto. Cancelar não equivale automaticamente a devolver pagamento ou emitir documento fiscal."
  },
  "vendas.pendencias": {
    "titulo": "Acompanhar resultado comercial incerto",
    "oQueE": "Uma pendência indica que o resultado de uma operação manual precisa ser confirmado.",
    "comoUsar": "Leia o estado e use somente a ação de acompanhamento oferecida.",
    "depois": "A lista será atualizada conforme a confirmação disponível.",
    "atencao": "Uma pendência não autoriza duplicar a venda. Preserve o registro para conciliação."
  },
  "estoque.lista": {
    "titulo": "Localizar produtos e interpretar disponibilidade",
    "oQueE": "Esta área mostra os produtos e o estoque conhecido da organização ativa.",
    "comoUsar": "Busque por nome ou código, confira filtros e abra o produto para detalhes.",
    "depois": "Consultar ou filtrar não reserva nem movimenta estoque.",
    "atencao": "Saldo sincronizado pode não refletir uma alteração recente do Bling; confira a atualização antes de prometer disponibilidade."
  },
  "estoque.produto": {
    "titulo": "Conferir dados do produto antes de gravar",
    "oQueE": "O cadastro reúne identificação, situação, preço, estoque conhecido e imagem do produto.",
    "comoUsar": "Revise os campos habilitados e obrigatórios antes de salvar. Confira o código para evitar duplicidade.",
    "depois": "A gravação retorna o resultado ou avisos das etapas que não puderam ser concluídas.",
    "atencao": "Imagem e dados podem ter resultados distintos. Arquivar, excluir e desativar têm efeitos diferentes; leia a confirmação específica."
  },
  "estoque.arquivar": {
    "titulo": "Entender produto fora de linha",
    "oQueE": "Arquivar identifica um produto fora de linha sem apagar seu histórico.",
    "comoUsar": "Confira o produto e o aviso da ação antes de confirmar.",
    "depois": "O produto deixa de ser tratado como disponível para novas operações conforme sua situação.",
    "atencao": "Arquivamento não comprova exclusão no Bling nem elimina referências de pedidos antigos."
  },
  "clientes.lista": {
    "titulo": "Encontrar contatos da organização",
    "oQueE": "A lista mostra os contatos disponíveis na organização ativa.",
    "comoUsar": "Use a busca e abra o contato para consultar ou editar seus dados.",
    "depois": "A consulta não altera o cadastro nem confirma vínculo com uma conversa SAC.",
    "atencao": "Homônimos existem. Confira o contato antes de editar ou excluir; evite expor documentos."
  },
  "clientes.detalhe": {
    "titulo": "Consultar identidade e consequências da exclusão",
    "oQueE": "O detalhe reúne os dados do contato selecionado e as ações permitidas.",
    "comoUsar": "Confira nome e dados necessários; leia a confirmação antes de excluir.",
    "depois": "A ação tenta atualizar ou excluir conforme as regras do sistema e informa o resultado.",
    "atencao": "Excluir um contato não apaga automaticamente todo o histórico de atendimento. Não repita uma exclusão com resultado incerto."
  },
  "clientes.editar": {
    "titulo": "Revisar dados de contato",
    "oQueE": "Este formulário cadastra ou altera o contato e seu endereço.",
    "comoUsar": "Revise os campos e a organização ativa. Se consultar CNPJ, confira os dados sugeridos antes de gravar.",
    "depois": "Só a confirmação de salvar solicita a gravação do cadastro.",
    "atencao": "Consulta externa pode falhar ou estar desatualizada. Não substitua dados corretos sem conferir e não duplique um cadastro por timeout."
  },
  "clientes.cnpj": {
    "titulo": "Usar dados públicos como apoio ao cadastro",
    "oQueE": "A consulta de CNPJ busca dados de uma empresa para apoiar o preenchimento.",
    "comoUsar": "Informe o CNPJ e confira o retorno antes de usar os dados no formulário.",
    "depois": "O preenchimento sugerido ainda precisa de revisão e salvamento.",
    "atencao": "A consulta não comprova representação da empresa nem vínculo do contato. Indisponibilidade não impede preenchimento manual."
  },
  "financeiro.visao": {
    "titulo": "Interpretar os números financeiros",
    "oQueE": "O financeiro mostra títulos e o resumo retornado pelo servidor para o tipo consultado. O período visual recorta a tabela e os gráficos por vencimento.",
    "comoUsar": "Confira período e organização; abra uma movimentação para verificar sua origem e situação.",
    "depois": "Filtros e consultas mudam a visualização, sem efetuar pagamentos.",
    "atencao": "Saldo exibido não é saldo bancário confirmado. Um erro ou leitura antiga não equivale a valor zero."
  },
  "financeiro.resumo": {
    "titulo": "Entender o resumo financeiro",
    "oQueE": "Entradas, saídas e saldo vêm do resumo retornado pelo servidor para o tipo consultado.",
    "comoUsar": "Confira o tipo consultado. O filtro visual de período recorta tabela e gráficos, mas não recalcula estes cartões.",
    "depois": "Consultar os cartões não liquida títulos nem movimenta dinheiro.",
    "atencao": "Não compare os cartões com um período da tabela supondo que ambos foram recalculados juntos. O resumo não é conciliação bancária."
  },
  "financeiro.graficos": {
    "titulo": "Interpretar séries do financeiro",
    "oQueE": "Os gráficos organizam os registros financeiros por data para mostrar entradas, saídas e fluxo.",
    "comoUsar": "Leia o período e os rótulos antes de comparar barras ou pontos.",
    "depois": "A visualização acompanha o filtro atual.",
    "atencao": "Valores projetados ou registrados não provam recebimento ou pagamento no banco."
  },
  "financeiro.detalhe": {
    "titulo": "Conferir um título antes de agir",
    "oQueE": "O detalhe mostra a origem, o valor e a situação da movimentação selecionada.",
    "comoUsar": "Confira os dados e as consequências da ação oferecida antes de confirmar.",
    "depois": "A operação informa seu resultado; estados pendentes precisam de acompanhamento.",
    "atencao": "Baixa e cancelamento alteram registros financeiros. Falha de comunicação exige conferir o estado antes de repetir."
  },
  "financeiro.despesa": {
    "titulo": "Registrar saída com dados revisados",
    "oQueE": "O formulário registra uma saída com os dados e o fornecedor informados.",
    "comoUsar": "Revise valor, datas, categoria e fornecedor antes de confirmar.",
    "depois": "A solicitação tenta criar o registro e apresenta o resultado ou pendência.",
    "atencao": "Registrar uma saída não executa uma transferência bancária. Evite duplicar após resposta incerta."
  },
  "financeiro.fornecedor": {
    "titulo": "Identificar o favorecido corretamente",
    "oQueE": "O fornecedor identifica a pessoa ou empresa vinculada a despesas.",
    "comoUsar": "Confira nome e documentos necessários antes de salvar.",
    "depois": "O cadastro passa a poder ser selecionado nos fluxos permitidos.",
    "atencao": "Cadastrar não realiza pagamento nem verifica dados bancários. Evite duplicidades e exposição desnecessária de documentos."
  },
  "financeiro.pendencias": {
    "titulo": "Acompanhar alterações de resultado incerto",
    "oQueE": "As pendências preservam operações cujo resultado ainda precisa ser confirmado.",
    "comoUsar": "Leia a origem e o estado; use a ação de acompanhamento disponível.",
    "depois": "Uma confirmação pode atualizar a situação sem criar outra operação.",
    "atencao": "Não refaça baixa, cancelamento ou despesa enquanto o efeito anterior for incerto."
  },
  "org.visao": {
    "titulo": "Entender o escopo da organização",
    "oQueE": "A organização ativa define quais dados e permissões você utiliza.",
    "comoUsar": "Confira o nome no topo antes de consultar dados, convidar pessoas ou alterar membros.",
    "depois": "Trocar a organização muda o contexto; não transfere dados entre organizações.",
    "atencao": "Seu papel é conferido pelo servidor. Um nome ou botão visível não concede acesso."
  },
  "org.troca": {
    "titulo": "Mudar o contexto de trabalho",
    "oQueE": "Cada organização possui seus próprios dados e vínculos de participação.",
    "comoUsar": "Escolha a organização desejada e aguarde a confirmação da troca.",
    "depois": "Os painéis passam a carregar o contexto confirmado pelo servidor.",
    "atencao": "Se houver conflito ou falha, confirme a organização ativa antes de continuar uma edição."
  },
  "org.criar": {
    "titulo": "Criar um novo espaço de dados",
    "oQueE": "Uma organização separa dados, integrações e participantes.",
    "comoUsar": "Informe o nome e revise antes de confirmar a criação.",
    "depois": "O sistema cria a organização e informa seu vínculo conforme a operação.",
    "atencao": "Criar outra organização não copia estoque, contatos, integrações ou permissões existentes."
  },
  "org.membros": {
    "titulo": "Gerenciar participação com autoridade adequada",
    "oQueE": "Os papéis determinam quais ações cada participante pode solicitar.",
    "comoUsar": "Confira pessoa e papel antes de usar uma remoção disponível. A lista não permite editar papéis.",
    "depois": "O servidor valida a permissão e atualiza a participação quando permitido.",
    "atencao": "Uma alteração pode retirar acesso. Regras de proteção do proprietário e da organização continuam valendo."
  },
  "org.convites": {
    "titulo": "Acompanhar convites emitidos",
    "oQueE": "A lista apresenta os convites e seus estados na organização ativa.",
    "comoUsar": "Confira destino, papel e validade; revogue somente o convite pretendido.",
    "depois": "Convites revogados ou expirados deixam de permitir adesão conforme as regras.",
    "atencao": "O código é sensível: compartilhe apenas com a pessoa convidada, por canal apropriado."
  },
  "org.convidar": {
    "titulo": "Convidar com o papel correto",
    "oQueE": "O convite permite que uma pessoa entre na organização com o papel definido.",
    "comoUsar": "Revise papel e destinatário; entregue o código somente à pessoa pretendida.",
    "depois": "A emissão não significa que o convite foi aceito; acompanhe o estado na lista.",
    "atencao": "Não publique o código em capturas ou chats abertos. Convites não devem conceder autoridade além da necessária."
  },
  "org.aceitar": {
    "titulo": "Confirmar a organização antes de entrar",
    "oQueE": "Aceitar um convite cria seu vínculo com a organização indicada.",
    "comoUsar": "Confira a organização e o papel antes de confirmar.",
    "depois": "O sistema informa o aceite e se é necessário recarregar para atualizar o contexto.",
    "atencao": "Entrar não copia dados de outra organização. Em caso de aviso, confirme o contexto antes de operar."
  },
  "sac.lista": {
    "titulo": "Atender uma conversa com histórico",
    "oQueE": "O SAC organiza conversas, mensagens e estados de atendimento da organização ativa.",
    "comoUsar": "Selecione a conversa, leia o histórico e confira quem atende antes de responder.",
    "depois": "O envio entra na fila e seu estado será atualizado conforme a confirmação disponível.",
    "atencao": "Mensagem recebida, rascunho e entrega confirmada são estados diferentes. Não reenvie por conta própria quando o resultado for desconhecido."
  },
  "sac.controle": {
    "titulo": "Controlar quem pode responder",
    "oQueE": "Automação responde indica que a IA está disponível. Com você indica atendimento humano sob sua responsabilidade.",
    "comoUsar": "Assuma para interromper a IA e responder. Para devolver, confira a disponibilidade e informe um resumo; a IA só retoma após uma mensagem nova.",
    "depois": "Assumir bloqueia respostas automáticas e invalida envios pendentes. A confirmação no canal pode levar alguns segundos para aparecer.",
    "atencao": "Um envio já em voo pode precisar de conciliação. Devolver não liga um bot desligado. Produtos, pedidos, decisões comerciais e casos sensíveis ou incertos precisam de humano."
  },
  "sac.cliente": {
    "titulo": "Identidade do cliente e vínculo com a conversa",
    "oQueE": "O painel apoia a identificação do cliente da conversa e apresenta o vínculo disponível.",
    "comoUsar": "Confira as evidências e use a verificação oferecida antes de selecionar um pedido.",
    "depois": "Somente o vínculo vigente permite consultar o retrato autorizado do pedido.",
    "atencao": "Nome, telefone ou número citado pela IA não bastam para comprovar identidade; não exponha dados de outro cliente."
  },
  "sac.triagem": {
    "titulo": "Interpretar a análise da IA",
    "oQueE": "A triagem classifica o contexto e aponta dúvidas; ela é uma hipótese.",
    "comoUsar": "Confira o histórico, a intenção, os dados faltantes e a necessidade de atendente.",
    "depois": "Mostrar triagem não envia resposta nem confirma o pedido citado.",
    "atencao": "Mensagem nova pode tornar uma execução obsoleta. Modelo falso é demonstração; confiança não substitui verificação."
  },
  "sac.rascunho": {
    "titulo": "Preparar uma resposta sem enviar automaticamente",
    "oQueE": "O rascunho sugere uma resposta baseada no contexto vigente permitido.",
    "comoUsar": "Gere, leia e revise. Use no compositor e confirme o texto antes de enviar.",
    "depois": "Usar no compositor apenas preenche a mensagem; o envio exige uma ação própria.",
    "atencao": "Se o contexto mudar ou a IA falhar, solicite novo rascunho ou responda manualmente. Não trate o modelo de demonstração como IA real."
  },
  "sac.pedido": {
    "titulo": "Ler somente dados comprovados do pedido",
    "oQueE": "O retrato reúne os dados autorizados do pedido ligado ao cliente verificado.",
    "comoUsar": "Leia as situações de estoque, pagamento, rastreio e os avisos de atualização.",
    "depois": "É uma consulta; não sincroniza o Bling nem executa ações no pedido.",
    "atencao": "Desconhecido não significa pago, disponível ou entregue. Dados antigos precisam de conferência antes de prometer algo."
  },
  "integracoes.visao": {
    "titulo": "Distinguir conexão de funcionamento",
    "oQueE": "As integrações conectam Bling e Chatwoot à organização ativa.",
    "comoUsar": "Confira o provedor, o estado e os detalhes antes de conectar, sincronizar ou desligar.",
    "depois": "Autorizar OAuth registra uma conexão; sincronização e recebimento têm estados próprios.",
    "atencao": "Conectado não comprova worker ativo ou sincronização concluída. Não exponha tokens; desligar não apaga o histórico."
  },
  "integracoes.inbox": {
    "titulo": "Acompanhar processamento de mensagens recebidas",
    "oQueE": "A inbox preserva entregas recebidas e seu estado de processamento.",
    "comoUsar": "Confira a conexão e o estado do evento antes de usar a recuperação permitida.",
    "depois": "Um evento aceito pode aguardar worker antes de aparecer na conversa.",
    "atencao": "Webhook acessível não prova processamento. Recuperação não autoriza enviar uma resposta duplicada."
  },
  "integracoes.envios": {
    "titulo": "Resolver envio com resultado ambíguo",
    "oQueE": "Esta lista separa envios que exigem atenção ou confirmação do efeito externo.",
    "comoUsar": "Confira conversa, tentativa e estado; use somente a ação de conciliação oferecida.",
    "depois": "A confirmação registra o resultado conhecido sem pressupor uma nova entrega.",
    "atencao": "Unknown pode significar que o destinatário já recebeu. Nunca reenvie automaticamente para tentar descobrir."
  },
  "billing.plano": {
    "titulo": "Entender as ações de assinatura",
    "oQueE": "Este painel consulta a assinatura e oferece as ações de faturamento permitidas.",
    "comoUsar": "Confira organização, plano e consequências antes de abrir o checkout ou portal.",
    "depois": "As ações podem abrir um serviço externo de cobrança.",
    "atencao": "Esta superfície está oculta na navegação do MVP. Não use cobrança real durante a demonstração."
  },
  "integracoes.bling": {
    "titulo": "Autorizar o Bling na organização certa",
    "oQueE": "Salvar as credenciais do aplicativo e autorizar a conta no Bling são etapas diferentes.",
    "comoUsar": "Confira a organização e a URL de retorno estável exibida. Salve as credenciais e só então inicie a autorização.",
    "depois": "O retorno OAuth registra os tokens no cofre. A sincronização deve ser acompanhada separadamente.",
    "atencao": "Não use URL de preview como callback nem copie segredos em relatórios. Conectado não significa que o último job terminou com sucesso."
  },
  "integracoes.chatwoot": {
    "titulo": "Conectar a instância e configurar a entrada",
    "oQueE": "A conexão identifica a instância Chatwoot, sua conta e a entrega de webhooks para esta organização.",
    "comoUsar": "Confira URL e ID da conta; use as credenciais autorizadas e a URL de webhook exibida.",
    "depois": "Mensagens aceitas ainda precisam ser processadas pelo worker para aparecer no atendimento.",
    "atencao": "Salvar não comprova conectividade. Não compartilhe o token ou segredo do webhook, nem desative a verificação da assinatura para testar."
  },
  "integracoes.sync": {
    "titulo": "Acompanhar uma sincronização do Bling",
    "oQueE": "Sincronizar solicita a atualização dos registros da organização a partir do Bling.",
    "comoUsar": "Confirme a organização, inicie uma vez e acompanhe o progresso e o resultado apresentado.",
    "depois": "O processo pode terminar com sucesso, falha ou resultado parcial. Releia os dados após a confirmação.",
    "atencao": "OAuth conectado não garante permissão de sincronização. Falha parcial pode manter dados antigos; não use repetição como prova de correção."
  },
  "sac.envio": {
    "titulo": "Fila e confirmação da resposta humana",
    "oQueE": "O compositor prepara o texto que você solicita enviar nesta conversa.",
    "comoUsar": "Confira o destinatário, revise o texto e envie uma única vez. Acompanhe o estado no histórico.",
    "depois": "A solicitação passa pela fila de envio; confirmação de entrega é distinta da aceitação da solicitação.",
    "atencao": "Em estado desconhecido, a mensagem pode já ter chegado. Não duplique o envio; use a conciliação. Atendimento humano continua sujeito à organização e às permissões."
  },
  "shell.org": {
    "titulo": "Reconhecer o contexto antes de agir",
    "oQueE": "O indicador informa a organização que determina seus dados e permissões atuais.",
    "comoUsar": "Confira o nome antes de abrir cadastros, conversar ou sincronizar.",
    "depois": "A troca, quando disponível, precisa ser confirmada pelo servidor.",
    "atencao": "Se o contexto ainda estiver carregando ou falhar, aguarde antes de operar sobre dados."
  },
  "estoque.foto": {
    "titulo": "Entender a gravação independente da foto",
    "oQueE": "A foto tem uma gravação própria, separada do botão de salvar os dados do produto.",
    "comoUsar": "Escolha um arquivo permitido e acompanhe o retorno. Para remover ou sincronizar novamente, confira o estado exibido.",
    "depois": "A imagem pode ficar salva no ORBITA enquanto sua atualização ou remoção no Bling permanece pendente.",
    "atencao": "Fechar ou cancelar a edição do produto não desfaz uma foto já gravada. Não repita o upload se a pendência for apenas no Bling."
  },
  "auth.entrada": {
    "titulo": "Entrar com segurança na sua conta",
    "oQueE": "A entrada identifica sua conta; os dados disponíveis dependem dos seus vínculos com organizações.",
    "comoUsar": "Informe e-mail e senha nos campos próprios. Use o cadastro se precisar criar uma conta e confira as instruções apresentadas.",
    "depois": "Após entrar, confirme a organização ativa antes de trabalhar com dados.",
    "atencao": "Não compartilhe senha ou sessão. Criar conta não concede acesso a organizações de outras pessoas."
  },
  "diagnostico.erro": {
    "titulo": "Detalhes de falha e resultado incerto",
    "oQueE": "O detalhe apresenta o resultado conhecido de uma operação que falhou ou ficou incompleta.",
    "comoUsar": "Leia o resumo e use a ação de acompanhamento permitida. Antes de compartilhar o erro, confira e remova dados sensíveis.",
    "depois": "Fechar o aviso não comprova que a operação foi desfeita.",
    "atencao": "Logs podem conter informações sensíveis. Não repita ações comerciais ou financeiras se o resultado anterior ainda for incerto."
  },
  "painel.metricas-detalhadas": {
    "titulo": "Definições dos indicadores do painel",
    "oQueE": "Pedidos conta todos os pedidos carregados; Pendentes reúne status com pend ou aberto, Atendidos reúne atend ou fatur, Cancelados reúne status com cancel e Outros é o restante. A emitir NF-e conta vendas não canceladas com status A Emitir ou sem nota registrada.",
    "comoUsar": "Faturamento 30d soma vendas não canceladas pela data do pedido, dos 30 dias anteriores até antes do instante usado pela tela. O ticket divide esse valor pela quantidade dessas vendas; sem vendas, aparece um traço. Produtos e Clientes contam os cadastros carregados.",
    "depois": "A comparação usa os 30 dias anteriores à mesma janela; se o faturamento anterior for zero, aparece sem base. O anel reparte todos os pedidos entre os quatro grupos.",
    "atencao": "Os totais gerais não têm todos o recorte de 30 dias. A indicação de NF-e não valida documento fiscal, e faturamento de pedidos não comprova recebimento no banco."
  },
  "estoque.codigos": {
    "titulo": "Código SKU e referência do produto",
    "oQueE": "SKU é o código de identificação exibido no cadastro. Ele é diferente do identificador interno e do ID de vínculo com o Bling.",
    "comoUsar": "Confira o código antes de salvar. O botão de copiar leva apenas esse código para a área de transferência.",
    "depois": "Copiar não grava o produto nem cria vínculo com o ERP; salvar solicita a atualização do cadastro.",
    "atencao": "Não deduza que dois registros são o mesmo produto só por nome ou código parecido. Não altere um código apenas para contornar uma falha de gravação."
  },
  "estoque.precos": {
    "titulo": "Preço de venda do produto",
    "oQueE": "Este campo informa o preço de venda em reais. Esta tela não oferece um campo de custo nem calcula margem.",
    "comoUsar": "Revise o valor decimal no campo Preço de venda antes de salvar os dados do produto.",
    "depois": "A gravação solicita a atualização do cadastro; ela não confirma uma venda ou um pagamento.",
    "atencao": "Alterar o preço do cadastro não comprova alteração de pedidos antigos. Não use este valor como custo ou lucro."
  },
  "estoque.categoria": {
    "titulo": "Categoria do catálogo",
    "oQueE": "A categoria organiza o produto. A seleção usa o catálogo local; quando vazio, a abertura pode tentar buscar categorias no Bling uma vez, conforme a permissão.",
    "comoUsar": "Escolha uma categoria disponível ou Sem categoria. Leia o aviso caso a lista não possa ser carregada.",
    "depois": "A seleção é enviada com os dados ao salvar. Categoria é opcional neste cadastro.",
    "atencao": "Lista vazia e falha de sincronização são situações diferentes. Não crie uma categoria improvisada para esconder um erro."
  },
  "estoque.obrigatorios": {
    "titulo": "Campos obrigatórios do cadastro Bling",
    "oQueE": "Tipo distingue as opções de produto e serviço exibidas; Situação oferece Ativo e Inativo; Formato oferece Simples, Variações e Composição. Unidade identifica a medida, como UN, CX ou KG.",
    "comoUsar": "Confira os valores lidos do Bling ou selecione os corretos. A unidade aceita até seis caracteres. Um campo sem valor não deve ser tratado como um padrão confirmado.",
    "depois": "Salvar envia os campos exigidos pelo contrato; falhas de leitura ou validação continuam visíveis.",
    "atencao": "Ativo não significa estoque disponível. A ajuda descreve as opções do formulário e não escolhe uma classificação fiscal pela organização."
  },
  "vendas.pagamento": {
    "titulo": "Forma de pagamento registrada",
    "oQueE": "A opção registra a forma de pagamento do pedido: Dinheiro, PIX, Cartão de Crédito ou Cartão de Débito.",
    "comoUsar": "Escolha a forma acordada e confira os demais dados antes de finalizar.",
    "depois": "O rótulo segue na solicitação. Ele não é o ID da forma de pagamento no Bling; sem esse ID específico, o servidor usa a forma padrão da conta.",
    "atencao": "Selecionar PIX ou cartão não inicia uma cobrança, confirma recebimento ou liquida uma conta."
  },
  "vendas.desconto-frete": {
    "titulo": "Desconto e frete no total do pedido",
    "oQueE": "Os campos são valores em reais, não percentuais. A prévia soma os itens, adiciona frete e subtrai desconto, com piso zero.",
    "comoUsar": "Informe valores não negativos e confira o total líquido antes de confirmar o pedido.",
    "depois": "O servidor recalcula e valida o total; o número da tela é uma prévia, não autoridade final.",
    "atencao": "Desconto e frete alteram o valor solicitado. Não repita uma venda de resultado incerto para tentar corrigir o total."
  },
  "vendas.sincronizar-checkbox": {
    "titulo": "Destino do pedido manual",
    "oQueE": "A opção define se o pedido será solicitado com sincronização ao Bling ou apenas como registro local no ORBITA.",
    "comoUsar": "Confira a caixa Sincronizar pedido com o Bling v3 antes de finalizar; ela começa marcada.",
    "depois": "O pedido seguirá o caminho escolhido e o sistema informará confirmação, falha ou pendência.",
    "atencao": "Desmarcar não envia o pedido ao ERP. Se houver resultado incerto, não mude a opção e envie de novo: confira a tentativa anterior."
  },
  "clientes.tipo-documento": {
    "titulo": "Documento, pessoa e contribuinte",
    "oQueE": "CPF/CNPJ, tipo de pessoa e tipo de contribuinte são campos distintos. Pessoa oferece Física, Jurídica e Estrangeiro; contribuinte oferece as opções 1, 2 e 9 descritas no seletor.",
    "comoUsar": "Revise documento e seleções; um documento válido pode sugerir o tipo de pessoa. Ao usar consulta de empresa, confira eventuais divergências antes de salvar.",
    "depois": "O salvamento aplica as validações do cadastro; uma consulta não confirmada não deve substituir dados corretos.",
    "atencao": "O enquadramento correto deve vir do cadastro validado pela organização, não de uma suposição da ajuda. Documento no cadastro não confirma sozinho o cliente de uma conversa."
  },
  "clientes.endereco": {
    "titulo": "Endereço do contato",
    "oQueE": "CEP, rua, número, bairro, cidade e UF compõem o endereço cadastrado do contato.",
    "comoUsar": "Confira os campos, inclusive dados aproveitados da consulta de empresa, e revise a UF antes de salvar.",
    "depois": "O endereço é solicitado junto com o cadastro; consultar ou preencher os campos não despacha mercadoria.",
    "atencao": "Não presuma que informar o CEP verifica ou completa automaticamente todo o endereço. Confira com o contato quando a informação estiver incompleta."
  },
  "financeiro.filtros": {
    "titulo": "Recortes do extrato e dos gráficos",
    "oQueE": "Todos, Entradas e Saídas mudam a leitura do servidor. O período recorta tabela e gráficos pela data de vencimento, não pela data de pagamento.",
    "comoUsar": "Escolha o tipo e depois o período. Os períodos de 7 ou 30 dias incluem hoje e os dias anteriores; Todo o período também permite vencimentos futuros.",
    "depois": "Os dois gráficos usam a mesma lista elegível. Cancelados e estornados ficam no histórico da tabela, mas fora dos gráficos.",
    "atencao": "Os cartões de entradas, saídas e saldo vêm do resumo do servidor e não são recalculados pelo filtro visual de período. Esta tela não possui campo de busca textual."
  },
  "financeiro.baixa": {
    "titulo": "Situação e data de pagamento",
    "oQueE": "O campo Pagamento mostra a data disponível do título ou um traço quando ela não existe. É uma consulta.",
    "comoUsar": "Confira a situação e a origem junto com a data. Se houver dúvida sobre quitação, valide o registro na origem antes de concluir o atendimento.",
    "depois": "Abrir o detalhe ou consultar esta ajuda não dá baixa e não movimenta dinheiro.",
    "atencao": "Este detalhe não oferece ação de baixa manual. Ausência de data não autoriza registrar pagamento por outro botão nem pressupor que a conta está quitada."
  },
  "financeiro.correcao": {
    "titulo": "Correção de uma saída financeira",
    "oQueE": "Excluir lançamento remove definitivamente uma saída interna. Cancelar despesa de origem Bling pede verificação da situação atual; se estiver aberta, remove a conta no ERP e mantém o histórico local como cancelado.",
    "comoUsar": "Confira origem, título e valor e leia a confirmação. A interface não oferece estorno automático de saída já paga no Bling.",
    "depois": "Somente um desfecho confirmado encerra o detalhe e atualiza a leitura. Recusas ou resultados incertos mantêm um aviso para acompanhamento.",
    "atencao": "Entradas, títulos de pedido e registros terminais não oferecem essas ações aqui. Se o resultado for incerto, não repita nem escolha outra ação para contornar a pendência."
  },
  "org.papeis-detalhados": {
    "titulo": "Papéis e autoridade na organização",
    "oQueE": "Dono e Administrador possuem as capacidades de acesso e gestão da organização; Membro possui acesso. Outras ações ainda podem exigir regras específicas no servidor.",
    "comoUsar": "Confira o papel da pessoa e seu próprio contexto antes de usar os controles de participação.",
    "depois": "Esta lista permite solicitar remoção de participantes quando autorizado; ela não oferece um editor de papéis.",
    "atencao": "Nenhum Dono aparece removível nesta lista, não apenas o último. O servidor também valida a operação; ocultar ou mostrar um botão não é a autorização."
  },
  "integracoes.formato-url": {
    "titulo": "Endereços e identificadores da conexão",
    "oQueE": "A URL da instância aponta para o servidor Chatwoot. O ID da conta identifica a conta nessa instância; não é o ID de inbox nem o identificador local da conexão.",
    "comoUsar": "Use o endereço e a conta autorizados pela operação. Copie a URL de webhook exibida para receber eventos; no Bling, use a URL estável de retorno OAuth exibida no cartão dele.",
    "depois": "Salvar solicita a configuração da conexão. O campo de URL é validado como URL; o servidor ainda precisa conseguir acessar a instância.",
    "atencao": "Não coloque tokens na URL nem troque ID da conta por inbox. URL sintaticamente válida não comprova HTTPS público, conectividade ou webhook operacional."
  },
  "integracoes.estado-job": {
    "titulo": "Progresso da sincronização",
    "oQueE": "A sincronização Bling cria um job acompanhado pela tela. O progresso mostra fases e quantidades reportadas pelo servidor, não uma confirmação de que tudo já foi atualizado.",
    "comoUsar": "Inicie uma vez com a organização correta e acompanhe o resultado. O acompanhamento consulta a cada dois segundos por até dez minutos.",
    "depois": "Concluído, falhou e cancelado são desfechos do job. Se acabar o acompanhamento ou falhar a leitura do estado, o processo pode continuar no servidor.",
    "atencao": "Não inicie outra sincronização só porque a tela parou de acompanhar. Releia o estado e confira dados e erros; Conectado no OAuth não prova conclusão do job."
  },
  "billing.limites": {
    "titulo": "Limites e estado da assinatura",
    "oQueE": "Os números mostram os limites de membros, conexões Bling e conexões Chatwoot devolvidos pelo servidor para a organização atual. O estado da assinatura vem dessa mesma leitura.",
    "comoUsar": "Compare os limites exibidos com a necessidade da organização. Consulte plano e estado antes de abrir checkout ou portal.",
    "depois": "Uma solicitação de alteração pode abrir um serviço externo; somente a confirmação do servidor atualiza os direitos efetivos.",
    "atencao": "A ajuda não aciona cobrança nem promete que trocar o plano remove dados ou cria acesso imediatamente. Não faça cobranças reais no ensaio do MVP."
  },
  "estoque.movimentacoes": {
    "titulo": "Entender as movimentações de estoque",
    "oQueE": "Este histórico consulta as entradas e saídas que o ORBITA registrou para o produto, com as mais recentes primeiro.",
    "comoUsar": "Confira a data, a origem e a quantidade. O sinal − indica saída e o sinal + indica entrada.",
    "depois": "Consultar o histórico ou esta ajuda não muda o saldo, registra movimentações nem sincroniza o Bling.",
    "atencao": "Lista vazia indica ausência de registros no ORBITA; não comprova histórico vazio no Bling. Uma falha de leitura não significa zero movimentações."
  },
  "shell.fundo": {
    "titulo": "Preferência visual de fundo",
    "oQueE": "Armazém, Lima, Lavanda e Grafite alteram o fundo atrás da janela do ORBITA; essa escolha não é a troca de tema claro ou escuro.",
    "comoUsar": "Selecione uma amostra para mudar o fundo da sessão atual.",
    "depois": "A preferência é aplicada na tela. Neste código ela não é salva; uma nova montagem começa novamente com Armazém.",
    "atencao": "A escolha não muda dados, permissões ou organizações. Não há envio de foto pessoal por este seletor."
  }
} as const satisfies Record<string, ConteudoDeAjuda>;

export type AjudaId = keyof typeof catalogoDeAjuda;
