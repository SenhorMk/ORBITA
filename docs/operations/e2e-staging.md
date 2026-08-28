# E2E real em staging (ticket 24)

Este documento descreve como rodar a suíte Playwright real contra um
ambiente de staging quando ele existir. **Nenhum passo abaixo foi executado
de verdade neste ticket** — staging real, Supabase sincronizado (ticket 23)
e credenciais Bling/Chatwoot/Stripe controladas (ticket 25) ainda não
existem. Ver `.scratch/orbita-mvp-producao-v2/evidence/24-final-evidence.md`
para o estado exato.

## Pré-requisitos

1. `STAGING_URL` — URL HTTPS pública do ambiente de staging, com `staging`
   no hostname (ex.: `https://staging.orbita.example.com`). Sem essa
   variável, `playwright.config.ts` recusa-se a carregar — não há fallback
   para `localhost`.
2. `SUPABASE_URL` (ou `NEXT_PUBLIC_SUPABASE_URL`) — projeto Supabase de
   staging, também com `staging` no hostname. Nunca aponte para o projeto de
   produção.
3. `SUPABASE_SERVICE_ROLE_KEY` — apenas para os scripts de seed/cleanup
   (nunca exposta ao navegador nem versionada).
4. `STRIPE_SECRET_KEY` — se presente, deve começar com `sk_test_`. Uma chave
   `sk_live_` faz a configuração falhar imediatamente.
5. Contas Bling/Chatwoot controladas (sandbox), não contas de clientes reais.

## Validação estrutural (sem staging real)

Para confirmar que a suíte compila e carrega, sem rodar nada contra
qualquer host real:

```bash
STAGING_URL=https://staging.example.invalid npx playwright test --list
```

`example.invalid` é um domínio reservado pela RFC 2606 — nunca resolve em
nenhuma rede. Isso prova apenas que os arquivos de spec/config carregam
estruturalmente; **não é evidência de execução em staging** e nunca deve ser
apresentado como tal.

## Seed de dados sintéticos

```bash
STAGING_URL=https://staging.orbita.example.com \
SUPABASE_URL=https://orbita-staging.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
npm run e2e:seed
```

Cria duas organizações (`org-a`, `org-b`) e cinco personas sintéticas
(owner/admin/member de A, owner de B, um usuário totalmente externo — sem
vínculo com A ou B), todas com identificadores prefixados por
`orbita-e2e-<runId>-`. Escreve o manifest em
`e2e/.manifests/<runId>.json` (não versionado).

## Rodando a suíte real

```bash
STAGING_URL=https://staging.orbita.example.com \
SUPABASE_URL=https://orbita-staging.supabase.co \
E2E_SEED_MANIFEST_PATH=e2e/.manifests/<runId>.json \
npm run e2e
```

Regras aplicadas pelo `playwright.config.ts`:

- `retries: 0` — flaky é bug, nunca é mascarado por retry (ticket 24).
- `workers: 1`, `fullyParallel: false` por padrão — specs rodam isoladas
  primeiro; paralelizar exige revisão explícita de isolamento de dados.
- Trace, screenshot e vídeo só em falha (`retain-on-failure` /
  `only-on-failure`). **Playwright não redige segredos automaticamente** —
  quem revisar uma trace de falha deve confirmar que não há segredo antes de
  compartilhar.

## Cleanup

```bash
STAGING_URL=https://staging.orbita.example.com \
SUPABASE_URL=https://orbita-staging.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
npm run e2e:cleanup -- e2e/.manifests/<runId>.json
```

Remove apenas as organizações/membros/usuários com o prefixo daquele
manifest (`filterSyntheticRecords` em `src/lib/e2e/syntheticSeedData.ts`) —
nunca um `DELETE` amplo.

## Cobertura atual vs. matriz mínima do ticket

Ver a lista exata (specs escritas vs. `needs-owner`) em
`.scratch/orbita-mvp-producao-v2/evidence/24-final-evidence.md`.
