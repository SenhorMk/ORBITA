import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the ORBITA login screen (`src/app/page.tsx`, unauthenticated
 * state). There is no dedicated `/login` route with its own form — `/login`
 * only redirects to `/`, and `/` renders this form directly when there is no
 * active Supabase session. Selectors below are tied to the real DOM ids used
 * in `src/app/page.tsx` (`#email-input`, `#password-input`,
 * `#btn-login-submit`).
 */
export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly authError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.locator('#email-input');
    this.passwordInput = page.locator('#password-input');
    this.submitButton = page.locator('#btn-login-submit');
    this.authError = page.getByText(/E-mail ou senha inválidos|Falha na autenticação/i);
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await expect(this.emailInput).toBeVisible();
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  /**
   * Login and wait for the authenticated dashboard shell to render.
   *
   * O sinal de "entrou" é o botão de sair do rail, e o nome dele é
   * **"Sair da conta"** (`src/components/shell/Rail.tsx`). Estava escrito
   * "Sair da sessão" aqui — um rótulo que a interface não tem desde o Ticket
   * 01 —, então todo login desta suíte esperava quinze segundos por um
   * elemento inexistente e falhava depois do login ter dado certo. Ticket 09.
   */
  async loginAndWaitForDashboard(email: string, password: string): Promise<void> {
    await this.login(email, password);
    await expect(this.page.getByRole('button', { name: 'Sair da conta' })).toBeVisible({ timeout: 15_000 });
  }

  async expectLoginRejected(): Promise<void> {
    await expect(this.authError).toBeVisible();
    await expect(this.emailInput).toBeVisible();
  }

  /** Full keyboard-only walk from an empty page to a submitted login form, for the accessibility spec. */
  async loginViaKeyboardOnly(email: string, password: string): Promise<void> {
    await this.emailInput.focus();
    await expect(this.emailInput).toBeFocused();
    await this.page.keyboard.type(email);
    await this.page.keyboard.press('Tab');
    await expect(this.passwordInput).toBeFocused();
    await this.page.keyboard.type(password);
    await this.page.keyboard.press('Tab');
    await expect(this.submitButton).toBeFocused();
    await this.page.keyboard.press('Enter');
  }
}
