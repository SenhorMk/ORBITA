# Verificação do cliente na conversa (MSG-010) — migration 92_vinculo_cliente_conversa.sql

Uma conversa só revela pedidos depois que um atendente confirma quem é a
pessoa. A consulta fica presa ao cliente confirmado. Arquivo na ordem 95 do
ledger, sobre a migration 91 do MSG-009 (PR #141).

**D2 (método de verificação) continua pendente.** O que existe é o padrão seguro
do plano: verificação por atendente. Nenhuma automação consulta pedidos hoje; a
ferramenta já nasce fechada para quando existir (MSG-011, MSG-014).

## 1. Caminho

```text
cockpit: GET  /api/sac/verificacao?conversaId=…
              ler_verificacao_cliente_sac + listar_candidatos_cliente_sac
              → { verificacao: { estado, cliente, expiraEm, totalDeCandidatos, consultaPorNumeroBloqueada },
                  candidatos: [{ clienteId, nome, documentoFinal }] }
         POST /api/sac/verificacao { acao: 'confirmar', conversaId, commandId, clienteId }
              confirmar_vinculo_cliente_sac: substitui a prova anterior, grava a nova, audita
         POST /api/sac/verificacao { acao: 'revogar', conversaId }
         GET  /api/sac/pedidos?conversaId=…            → pedidos do cliente confirmado
         POST /api/sac/pedidos { conversaId, numero }  → um número, só entre os pedidos dele
              consultar_pedidos_do_cliente_verificado_sac
```

| Peça | Onde |
|---|---|
| Prova e tentativas | `sac_vinculos_cliente`, `sac_consultas_recusadas` (sem privilégio direto, nem para `service_role`) |
| Funções | `ler_verificacao_cliente_sac`, `listar_candidatos_cliente_sac`, `confirmar_vinculo_cliente_sac`, `revogar_vinculo_cliente_sac`, `consultar_pedidos_do_cliente_verificado_sac` (só `service_role`) |
| Serviço e ferramenta | `src/services/sac/clienteVerificado.ts` (`criarConsultaDePedidos`) |
| Rotas | `src/app/api/sac/verificacao`, `src/app/api/sac/pedidos` |
| Contrato | `src/lib/integrations/contratoDaVerificacao.ts` (v1) |
| Tela | `src/components/mensageria/PainelDoCliente.tsx`, `useVerificacao.ts` |

## 2. Regras

- **Telefone não prova.** Cliente com o telefone do contato é candidato: aparece
  para o atendente, com nome e os dois últimos dígitos do documento. Zero, um ou
  vários candidatos dão o mesmo estado, `sem_prova`.
- **Quem confirma.** Quem atende (`organization:access`), como responder. O
  cliente precisa ser da organização e não estar anonimizado; cliente de outra
  organização, anonimizado ou inexistente dão a mesma resposta (404).
- **Validade.** 24 horas, enquanto o caso aberto na hora da confirmação continuar
  aberto e o cliente não for anonimizado. Depois disso o estado é `expirada` e a
  consulta volta a `sem_prova`. A prova não é editada: só substituída por outra
  confirmação ou revogada.
- **Uma prova por conversa.** Confirmar de novo revoga a anterior (`substituido`)
  na mesma transação. Um índice único parcial impede duas vigentes.
- **Consulta.** Não recebe cliente: ele vem da prova. Devolve número, data,
  situação e total de até 10 pedidos. Itens, rastreio e pagamento são do MSG-011.
- **Sem enumeração.** Número de outro cliente, de outra organização e
  inexistente respondem igual (`nao_encontrado`).
- **Tentativas.** Cinco números sem resultado em 15 minutos bloqueiam a busca por
  número daquela conversa (429). A lista dos pedidos do cliente confirmado
  continua disponível. O bloqueio sai sozinho quando as tentativas saem da janela.
- **Para a automação (futuro).** `SemProva` e `Bloqueada` trazem só
  `proximoPasso: 'encaminhar_para_humano'`. Não levam candidato nem motivo.

| Resultado | HTTP |
|---|---|
| confirmação aplicada ou repetida com o mesmo `commandId` | 200 |
| `cliente_nao_encontrado`, `conversa_nao_encontrada`, `nao_encontrado` | 404 |
| `conflito_comando` (mesmo `commandId`, outros dados) | 409 |
| `sem_prova` na consulta de pedidos | 409 |
| `bloqueada` | 429 |
| sem sessão / sem vínculo ou capacidade | 401 / 403 |
| banco fora ou resposta fora do contrato | 503, nada alterado nem consultado |

**Trilha.** `sac.customer_verified` (ator, conversa, caso, cliente, método, se o
telefone confere, se substituiu), `sac.customer_verification_revoked` e
`sac.order_lookup_blocked`. Sem documento, telefone ou número tentado. A rota
registra `sac.verificacao` e `sac.consulta_de_pedido` com `correlationId`,
organização, ator, conversa e desfecho; o `vinculoId` do log é o `recurso_id` da
auditoria.

## 3. Decisões para a proprietária

1. **D2:** além do atendente, algum método automático será aceito (por exemplo,
   a pessoa informar dados que o sistema confere)? Até decidir, a automação
   nunca passa de `sem_prova`.
2. O prazo de 24 horas e o limite de 5 tentativas em 15 minutos são padrões
   conservadores escolhidos na implementação. Confirmar ou ajustar.
3. Confirmar o cliente deve exigir uma capacidade própria de atendimento?
4. Hoje a tela só oferece os candidatos pelo telefone. Quem escreve de um número
   sem cadastro aparece sem candidato. Buscar o cliente por nome nesse painel
   fica para um ticket próprio, se desejado.

## 4. Implantação da migration 92

Depende da 91 (MSG-009) já aplicada. A PR do MSG-010 só entra depois da #141.

| Banco \ App | App anterior | App deste PR |
|---|---|---|
| **Sem a 92** | funciona | **Não pode acontecer:** o painel "Cliente" mostra erro em toda conversa (as RPCs não existem; 503). O resto da Mensageria funciona |
| **Com a 92** | funciona (a 92 só cria objetos novos) | funciona |

Ordem, cada passo com autorização explícita:

1. **Conferir o alvo, só leitura:** `npm run db:remoto:status` contra o Staging
   mostra a 91 aplicada e só a 92 (ordem 95) pendente.
2. **Aplicar a 92** (`npm run db:remoto:aplicar`). Impacto: cria duas tabelas
   vazias, um gatilho na tabela nova, nove funções e três linhas no catálogo de
   auditoria. Não altera tabela existente e não varre dados. As FKs novas pedem
   trava breve em `organizacoes`, `clientes`, `chatwoot_conversations`,
   `sac_cases` e `auth.users`; com `lock_timeout = 5s`, se a trava não vier a
   migration falha inteira e nada muda.
3. **Validar, só leitura:**

   ```sql
   select count(*) from public.sac_vinculos_cliente;            -- 0
   select has_function_privilege('authenticated',
     'public.consultar_pedidos_do_cliente_verificado_sac(uuid,uuid,text)', 'execute');  -- false
   select count(*) from public.catalogo_eventos_auditoria
    where nome in ('sac.customer_verified', 'sac.customer_verification_revoked', 'sac.order_lookup_blocked');  -- 3
   ```

   A autoverificação no fim da migration já aborta se a superfície estiver exposta.
4. **Merge** (autorização separada), depois da #141.

### Rollback

- **App:** reimplantar o deployment anterior. Banco com a 92 e app antigo é compatível.
- **Banco:** forward-only. Para fechar a consulta sem migration, revogar as
  provas (`revogar_vinculo_cliente_sac` por conversa); sem prova nada é consultado.
  Um defeito na 92 é corrigido por uma migration nova.

## 5. Verificação

```bash
npx vitest run src/services/sac src/app/api/sac src/components/mensageria
```

```bash
npm run test:db
```
