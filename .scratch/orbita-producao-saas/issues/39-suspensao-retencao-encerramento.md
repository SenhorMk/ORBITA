# 39 — Implementar suspensão, retenção e encerramento

**What to build:** controlar o ciclo de vida de uma organização preservando segurança, retenção, recuperação e obrigações de auditoria.

**Blocked by:** 36 — Contrair o tenancy legado por usuário; 38 — Integrar Stripe para assinatura e cobrança.

**Status:** ready-for-agent

- [ ] Suspensão impede operações proibidas sem apagar dados.
- [ ] Reativação restaura somente acessos permitidos.
- [ ] Encerramento segue período de retenção e confirmação adequada.
- [ ] Eventos sensíveis ficam auditáveis e dados são excluídos ou anonimizados conforme a política aprovada.
