import { test, expect, type Page } from '@playwright/test';

import { loadSeedManifest, organizacao, persona } from '../fixtures/personas';
import { CatalogOrderPage } from '../pages/CatalogOrderPage';
import { DashboardPage, DESTINOS_DA_JORNADA } from '../pages/DashboardPage';
import { LoginPage } from '../pages/LoginPage';
import { requirePersonaUserId, type SeedManifest } from '../../src/lib/e2e/syntheticSeedData';

/**
 * A spec desktop principal da banca (Ticket 09).
 *
 * É **uma** spec, de propósito. O ticket pede a costura de uma jornada já
 * construída, não uma suíte por tela: as negações cross-tenant continuam em
 * `cross-tenant-denial.spec.ts`, os papéis e o convite em
 * `organization.spec.ts`, e o comportamento de cada tela nos testes de
 * componente. O que só esta spec prova é que as peças, **em sequência e na
 * mesma sessão**, chegam do login ao logout sem quebrar no meio.
 *
 * ---------------------------------------------------------------------------
 * O QUE ESTA SPEC NÃO PROVA — e por quê
 * ---------------------------------------------------------------------------
 * A venda manual **executada**, com pedido novo aparecendo em Vendas e título
 * no Financeiro, não roda aqui. Não é excesso de zelo; é o que os dados
 * permitem afirmar:
 *
 * - o seed sintético (`e2e/seed/run-seed.ts`) cria usuários, organizações e
 *   vínculos — e nada comercial. As organizações que esta suíte pode usar não
 *   têm cliente nem produto;
 * - o único caminho de criação de cliente e de produto no Orbita passa pelo
 *   Bling (`POST /api/clientes/update` e `POST /api/produtos/update` chamam o
 *   ERP). Fabricar os dois para o teste seria escrita externa real, que exige
 *   autorização nominal da proprietária — e as organizações sintéticas nem
 *   conexão com o ERP têm.
 *
 * Então, na etapa comercial, esta spec afirma o que pode afirmar: abre o modal
 * da venda manual, **desliga a escrita externa** e comprova que o envio
 * permanece bloqueado enquanto faltar cliente ou item. A venda executada e o
 * detalhe de um pedido real são validação operacional na organização de
 * demonstração, registradas como tal — nunca simuladas aqui. Um `expect` verde
 * sobre um pedido que não existiu seria exatamente o risco que o ticket nomeia:
 * prova inválida com build verde.
 *
 * A **troca de organização dentro de uma sessão** — o seletor agindo com o
 * `switch` versionado por CAS no meio — também não roda aqui: nenhuma persona
 * do seed sintético pertence a duas organizações. O que existe é o caso de
 * resíduo entre sessões (`login A → logout → login B`), e ele está nomeado por
 * aquilo que faz. Ver o comentário sobre ele mais abaixo.
 */

let manifest: SeedManifest;

test.beforeAll(() => {
  manifest = loadSeedManifest();
});

/** Percorre os oito destinos da jornada e devolve o texto visível de cada um. */
async function percorrerAsSuperficies(dashboard: DashboardPage): Promise<Map<string, string>> {
  const textoPorSuperficie = new Map<string, string>();
  for (const destino of DESTINOS_DA_JORNADA) {
    await dashboard.abrir(destino.chave);
    textoPorSuperficie.set(destino.chave, await dashboard.textoVisivel());
  }
  return textoPorSuperficie;
}

async function entrarComo(page: Page, email: string, senha: string): Promise<DashboardPage> {
  const login = new LoginPage(page);
  await login.goto();
  await login.loginAndWaitForDashboard(email, senha);
  const dashboard = new DashboardPage(page);
  // O carregador de inicialização cobre a tela inteira; enquanto ele estiver
  // lá, clique nenhum chega ao rail. Ver `dispensarCarregadorDeInicializacao`.
  await dashboard.dispensarCarregadorDeInicializacao();
  return dashboard;
}

test.describe('jornada desktop da banca', () => {
  test('login → organização ativa → as oito superfícies → venda manual controlada → logout', async ({
    page,
  }) => {
    const owner = persona(manifest, 'owner-a');
    const orgA = organizacao(manifest, 'org-a');

    const dashboard = await entrarComo(page, owner.email, owner.password);

    // A organização ativa vem do rótulo do seletor, que é o mesmo texto que a
    // banca vai ler na tela. Sem esta linha, todo o resto da jornada poderia
    // estar acontecendo no tenant errado sem ninguém notar.
    expect(await dashboard.nomeDaOrganizacaoAtiva()).toBe(orgA.nome);

    for (const destino of DESTINOS_DA_JORNADA) {
      await dashboard.abrir(destino.chave);
    }

    // Vendas de uma organização recém-semeada não tem pedido nenhum, e a tela
    // diz isso com todas as letras. É a asserção honesta possível aqui: uma
    // tabela vazia sem explicação e um estado vazio declarado são coisas
    // diferentes, e é a segunda que a banca precisa ver.
    await dashboard.abrir('sales');
    await expect(page.getByText('Nenhum pedido neste período')).toBeVisible();

    const catalogo = new CatalogOrderPage(page);
    await catalogo.openModal();
    await catalogo.desligarEscritaNoBling();
    // Sem cliente e sem item, o envio não sai. A venda controlada da
    // apresentação começa por aqui: o botão libera quando a operação está
    // completa, e não porque alguém insistiu.
    await expect(catalogo.submitButton).toBeDisabled();
    await catalogo.cancelButton.click();
    await expect(catalogo.clienteSelect).not.toBeVisible();

    await dashboard.logout();
    await expect(new LoginPage(page).emailInput).toBeVisible({ timeout: 15_000 });
    await expect(dashboard.logoutButton).not.toBeVisible();
  });

  /**
   * Resíduo entre **sessões**, e não troca de organização.
   *
   * O que este caso executa é `login A → logout → login B`, no mesmo contexto
   * de navegador. Ele prova uma coisa só, e prova bem: encerrar a sessão de
   * quem pertence à organização A e entrar como quem pertence à B não deixa
   * nenhum dado de A nas telas de B — nem em memória do shell, nem em cache de
   * leitura, nem em painel que continua montado e escondido.
   *
   * **Isto não é a troca A → B.** A troca é o seletor de organização agindo
   * dentro de uma sessão só, sem logout, com o `switch` versionado por CAS no
   * meio: outra sequência, outro caminho de invalidação, outro risco. Este
   * teste não a alcança porque nenhuma persona do seed sintético pertence a
   * duas organizações, e ampliar o seed está fora desta fatia.
   *
   * Chamar isto de prova de switch seria dar por provada a metade que ninguém
   * mediu — exatamente o tipo de verde que este ticket existe para não
   * produzir. A troca real fica como validação operacional após o deploy, em
   * organizações sintéticas/controladas.
   */
  test('sessões em sequência: sair da organização A e entrar na B não deixa dado de A nas telas de B', async ({ page }) => {
    const ownerA = persona(manifest, 'owner-a');
    const ownerB = persona(manifest, 'owner-b');
    const orgA = organizacao(manifest, 'org-a');
    const orgB = organizacao(manifest, 'org-b');

    // ------------------------------------------------------------------
    // A: entra, percorre tudo, e deixa o cliente carregado de dado de A.
    // ------------------------------------------------------------------
    const sessaoA = await entrarComo(page, ownerA.email, ownerA.password);
    expect(await sessaoA.nomeDaOrganizacaoAtiva()).toBe(orgA.nome);

    // Os marcadores de A: o que a tela de fato imprime, e não o que se supõe
    // que ela imprima. A lista de membros publica **ids de usuário**, não
    // e-mails — a primeira versão desta spec procurava por e-mail e não achava
    // nem em A, o que teria deixado a checagem de resíduo verde sem medir nada.
    const marcadoresDeA = [
      orgA.nome,
      orgA.slug,
      requirePersonaUserId(ownerA),
      requirePersonaUserId(persona(manifest, 'admin-a')),
      requirePersonaUserId(persona(manifest, 'member-a')),
    ];

    const textoDeA = await percorrerAsSuperficies(sessaoA);
    // A presença em A é o par obrigatório da ausência em B: sem ela, "não
    // vazou" e "nunca esteve lá" ficariam indistinguíveis.
    for (const marcador of marcadoresDeA) {
      expect(
        textoDeA.get('organization'),
        `marcador ausente já na organização A — a checagem de resíduo mediria o vazio: ${marcador}`,
      ).toContain(marcador);
    }

    await sessaoA.logout();
    await expect(new LoginPage(page).emailInput).toBeVisible({ timeout: 15_000 });

    // ------------------------------------------------------------------
    // B: **no mesmo contexto de navegador**. É isso que dá sentido ao caso:
    // abrir tudo do zero em outro contexto não diria nada sobre o que o shell
    // guarda entre uma sessão e a seguinte. Continua sendo resíduo entre
    // sessões — a troca de organização dentro de uma sessão é outro caminho,
    // e não passa por aqui.
    // ------------------------------------------------------------------
    const sessaoB = await entrarComo(page, ownerB.email, ownerB.password);
    expect(await sessaoB.nomeDaOrganizacaoAtiva()).toBe(orgB.nome);

    const textoDeB = await percorrerAsSuperficies(sessaoB);
    for (const [superficie, texto] of textoDeB) {
      for (const marcador of marcadoresDeA) {
        expect(
          texto,
          `resíduo da sessão anterior (organização A) na superfície "${superficie}" de B: ${marcador}`,
        ).not.toContain(marcador);
      }
    }
  });

  test('Plano & Faturamento não é um destino da navegação apresentada', async ({ page }) => {
    const owner = persona(manifest, 'owner-a');
    const dashboard = await entrarComo(page, owner.email, owner.password);

    // O destino sai do rail e **só** dele: assinatura, Stripe e entitlement
    // continuam de pé (ver `DESTINOS_NAO_APRESENTADOS` em `Rail.tsx`). O que
    // esta asserção protege é a apresentação — um ícone que ninguém vai abrir
    // gasta a única ênfase da tela.
    await expect(page.getByRole('button', { name: 'Plano & Faturamento' })).toHaveCount(0);
    await dashboard.expectAuthenticated();
  });
});
