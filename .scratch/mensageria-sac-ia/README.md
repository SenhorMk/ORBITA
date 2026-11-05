# Planejamento de mensageria, SAC e IA

> Publicação para revisão em 05/11/2026: esta branch parte da main `b7dbddc877770aa6f2805ad3ee9f6e4acf974de6`, mas preserva o planejamento original de 08/10/2026 (44 rascunhos), recuperado do commit documental `85f91ba57041333f0f90f5286def30a9f05b66d4`. Os achados e estados abaixo descrevem a baseline de outubro; não foram revalidados contra a main de novembro. Revisões posteriores e evidências de implementação não integram este snapshot. Nenhum ticket foi iniciado ou publicado por esta operação de revisão.


Status: proposta para revisão. Baseline remoto: `e71354ee3f05f95436f82620b0303c7221f4f493`, confirmado em 08/10/2026.

Este pacote contém apenas planejamento e **44 tickets completos em rascunho**, um por arquivo. Nenhum ticket foi iniciado e nenhuma issue externa foi publicada.

1. [Estado atual e evidências](01-baseline-e-evidencias.md)
2. [Arquitetura, ADR, modelo de dados, estados e falhas](02-arquitetura.md)
3. [Tickets, grafo, critical path, milestones e decisões](03-tickets-e-dependencias.md)
4. [Validação documental](04-validacao.md)

Recomendação: evoluir inbox/outbox PostgreSQL com worker explícito e reconciliação; Chatwoot como cockpit; AI SDK somente leitura/propostas no stack atual. Handoff precede autorresposta. Pagamento e guard precedem publicação/expedição do substituto.

Próxima ação: revisar/aprovar arquitetura, granularidade e dependências. Os rascunhos não autorizam implementação.
