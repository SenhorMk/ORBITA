import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Os oito destinos da jornada da banca, na ordem em que ela os percorre.
 *
 * A chave é a mesma `TabType` de `src/components/shell/Rail.tsx`; `rail` é o
 * `aria-label` **literal** do botão de lá; `ancora` é o que precisa ficar
 * visível para a superfície contar como aberta.
 *
 * As âncoras são cabeçalhos, e vários deles quebram a linha no meio do nome
 * (`Visão<br />Geral`). O nome acessível sai sem o espaço que o `<br>` desenha,
 * então o padrão aceita "com ou sem espaço" — e continua sendo nome acessível,
 * não árvore visual.
 */
export const DESTINOS_DA_JORNADA = [
  { chave: 'dashboard', rail: 'Visão Geral', ancora: /^Visão\s*Geral$/ },
  { chave: 'sales', rail: 'Vendas & Pedidos', ancora: /^Vendas\s*&\s*Pedidos$/ },
  { chave: 'inventory', rail: 'Estoque & Produtos', ancora: /^Estoque\s*&\s*Produtos$/ },
  { chave: 'contacts', rail: 'Clientes & Contatos', ancora: /^Clientes\s*&\s*Contatos$/ },
  { chave: 'finance', rail: 'Controle Financeiro', ancora: /^Controle\s*Financeiro$/ },
  { chave: 'organization', rail: 'Organização & Membros', ancora: /^Organização\s*&\s*Membros$/ },
  { chave: 'integrations', rail: 'Integrações (Bling / Chatwoot)', ancora: /^Integrações$/ },
  { chave: 'sac', rail: 'SAC / Atendimento', ancora: /^Atendimento$/ },
] as const;

export type DestinoDaJornada = (typeof DESTINOS_DA_JORNADA)[number]['chave'];

/**
 * Page Object for the authenticated ORBITA shell (`src/app/page.tsx`). The
 * whole app is one client component with tab state (no client-side
 * routing), so "navigating" here means clicking a rail button and asserting
 * its panel becomes visible, not a URL change.
 *
 * **Os nomes vêm do rail, não da memória.** Este arquivo dizia "Sair da
 * sessão" e "SAC Omnichannel"; a interface diz "Sair da conta" e
 * "SAC / Atendimento" desde o Ticket 01. Um Page Object que guarda o rótulo de
 * ontem falha por um motivo que não é o que a spec mede — e foi assim que a
 * suíte inteira parou de conseguir sequer confirmar um login (Ticket 09).
 */
export class DashboardPage {
  readonly page: Page;
  readonly logoutButton: Locator;
  readonly salesTab: Locator;
  readonly inventoryTab: Locator;
  readonly contactsTab: Locator;
  readonly financeTab: Locator;
  readonly sacTab: Locator;
  readonly organizationTab: Locator;
  readonly integrationsTab: Locator;
  readonly dashboardTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logoutButton = page.getByRole('button', { name: 'Sair da conta' });
    this.dashboardTab = this.railButton('dashboard');
    this.salesTab = this.railButton('sales');
    this.inventoryTab = this.railButton('inventory');
    this.contactsTab = this.railButton('contacts');
    this.financeTab = this.railButton('finance');
    this.sacTab = this.railButton('sac');
    this.organizationTab = this.railButton('organization');
    this.integrationsTab = this.railButton('integrations');
  }

  /** O botão do rail de um destino, pelo nome acessível que o rail publica. */
  railButton(chave: DestinoDaJornada): Locator {
    const destino = DESTINOS_DA_JORNADA.find((d) => d.chave === chave);
    if (!destino) throw new Error(`Destino desconhecido: ${chave}`);
    return this.page.getByRole('button', { name: destino.rail, exact: true });
  }

  /** A âncora que prova que a superfície do destino está aberta. */
  ancoraDo(chave: DestinoDaJornada): Locator {
    const destino = DESTINOS_DA_JORNADA.find((d) => d.chave === chave);
    if (!destino) throw new Error(`Destino desconhecido: ${chave}`);
    return this.page.getByRole('heading', { name: destino.ancora });
  }

  /** Clica no destino e só volta quando a superfície dele está visível. */
  async abrir(chave: DestinoDaJornada): Promise<void> {
    await this.railButton(chave).click();
    await expect(this.ancoraDo(chave)).toBeVisible({ timeout: 20_000 });
  }

  async expectAuthenticated(): Promise<void> {
    await expect(this.logoutButton).toBeVisible();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
  }

  async openSalesTab(): Promise<void> {
    await this.abrir('sales');
  }

  async openInventoryTab(): Promise<void> {
    await this.abrir('inventory');
  }

  async openContactsTab(): Promise<void> {
    await this.abrir('contacts');
  }

  /**
   * O indicador de organização ativa da barra de ações.
   *
   * `OrganizacaoAtiva.tsx` tem **duas formas**, e as duas contam:
   *
   * - com uma organização só, um `<span>` inerte cujo nome acessível vem do
   *   `title`: "Organização ativa: <nome>";
   * - com mais de uma, um `<button>` com `aria-label`
   *   "Organização ativa: <nome>. Trocar de organização".
   *
   * Procurar só pelo botão passaria a jornada inteira num tenant não
   * verificado sempre que a pessoa tivesse uma organização apenas — que é o
   * caso mais comum e o da própria demonstração. Este seletor aceita as duas
   * e lê o nome de onde ele estiver.
   */
  get seletorDeOrganizacao(): Locator {
    return this.page.locator(
      '[title^="Organização ativa: "], [aria-label^="Organização ativa: "]',
    );
  }

  async nomeDaOrganizacaoAtiva(): Promise<string> {
    const alvo = this.seletorDeOrganizacao.first();
    await expect(alvo).toBeVisible({ timeout: 20_000 });
    const rotulo = (await alvo.getAttribute('aria-label')) ?? (await alvo.getAttribute('title'));
    const nome = rotulo?.match(/^Organização ativa: (.*?)(?:\. Trocar de organização)?$/)?.[1];
    if (!nome) {
      throw new Error(`O seletor de organização não publicou um nome legível: ${rotulo ?? '(sem rótulo)'}`);
    }
    return nome;
  }

  /**
   * Espera o carregador de inicialização sair da frente.
   *
   * `StartupLoader` é um `fixed inset-0 z-50`: enquanto ele estiver na tela,
   * **nenhum** clique chega ao rail. Ele abre sempre que quem entra administra
   * uma organização já confirmada pelo servidor (`useStartupPorOrganizacao`),
   * e sai por um de dois caminhos: a inicialização conclui e ele se fecha, ou
   * ela falha — numa organização sem conexão com o ERP, por exemplo — e a
   * saída oferecida é entrar em modo offline. Os dois são desfechos do
   * produto; nenhum é contorno de teste.
   *
   * A espera é por estado observável, sem `sleep`: enquanto o cabeçalho do
   * carregador estiver visível, ou se oferece a decisão e ela é tomada, ou se
   * dá a ele o tempo de concluir sozinho.
   */
  async dispensarCarregadorDeInicializacao(): Promise<void> {
    const cabecalho = this.page.getByRole('heading', {
      name: /^(Inicializando Órbita|Sincronizando ERP|Tudo Pronto|Reautenticação Necessária|Erro na Inicialização)$/,
    });
    const modoOffline = this.page.getByRole('button', { name: 'Ignorar (Modo Offline)' });

    // Esperar por ele **antes** de checar se saiu é o que evita a corrida:
    // sem isto, a checagem passava no instante em que o carregador ainda nem
    // tinha decidido aparecer, e o clique seguinte no rail batia no overlay.
    await expect(cabecalho).toBeVisible({ timeout: 30_000 });

    await expect(async () => {
      if (await modoOffline.isVisible()) await modoOffline.click();
      await expect(cabecalho).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
  }

  /**
   * Todo o texto **renderizado** da janela, e só ele.
   *
   * `innerText` ignora o que está com `display:none` — e vários painéis do
   * shell ficam montados e escondidos o tempo todo. Ler o DOM inteiro faria a
   * checagem de resíduo acusar como "vazado" um painel que ninguém vê; ler o
   * texto renderizado mede o que a banca mede: o que está na tela.
   */
  async textoVisivel(): Promise<string> {
    return this.page.locator('body').innerText();
  }

  /** Finds an order row by its human-visible order number in "Vendas & Pedidos". */
  orderRowByNumber(numero: string): Locator {
    return this.page.getByText(numero, { exact: false }).first();
  }
}
