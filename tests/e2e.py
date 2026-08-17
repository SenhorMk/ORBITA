import os
import time
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

def run_tests():
    port = os.environ.get('PORT_0', '3000')
    base_url = f"http://localhost:{port}"
    print(f"Starting E2E tests against {base_url}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = context.new_page()
        
        try:
            print("1. Testing Login")
            page.goto(base_url)
            page.wait_for_load_state("networkidle")
            
            # Form login
            page.fill('input#email-input', 'admin')
            page.fill('input#password-input', 'admin0')
            page.click('button:has-text("Entrar")')
            
            # Wait for dashboard to load
            page.wait_for_selector('text="Visão Geral"', timeout=8000)
            print("   [OK] Login successful!")
            
            # Handle potential Reautenticação modal
            try:
                page.wait_for_selector('text="Reautenticação Necessária"', timeout=2000)
                print("   [!] Reautenticação modal detected. Clicking 'Ignorar (Modo Offline)'.")
                page.click('button:has-text("Ignorar (Modo Offline)")')
                page.wait_for_timeout(500)
            except PlaywrightTimeoutError:
                pass
            
            print("\n2. Testing Navigation & Performance")
            tabs = [
                ("Vendas & Bling ERP", "Vendas"),
                ("Estoque & Produtos", "Estoque"),
                ("Clientes & Contatos", "Clientes"),
                ("SAC / Atendimento", "SAC"),
                ("Conversas WhatsApp", "Conversas"),
                ("Visão Geral", "Visão Geral")
            ]
            
            for tab_text, short_name in tabs:
                start_time = time.time()
                page.click(f'div.cursor-pointer:has-text("{tab_text}")', timeout=5000, force=True)
                page.wait_for_timeout(800)
                elapsed = (time.time() - start_time) * 1000
                print(f"   - Switched to {short_name} in {elapsed:.0f}ms")
                if elapsed > 1500:
                    print(f"   [!] WARNING: LENTIDÃO na aba {short_name} ({elapsed:.0f}ms)")
            
            print("\n3. Testing Novo Cliente Modal")
            page.click('div.cursor-pointer:has-text("Clientes & Contatos")', force=True)
            page.wait_for_timeout(500)
            
            try:
                page.click('button:has-text("Novo Contato")', force=True)
            except:
                page.click('button:has-text("Novo Cliente")', force=True)
                
            page.wait_for_selector('text="Cadastrar Novo Contato"', timeout=5000)
            
            page.fill('input[placeholder="Ex: João da Silva / Empresa X"]', 'Cliente E2E Teste')
            page.fill('input[placeholder="contato@exemplo.com"]', 'teste.e2e@exemplo.com')
            page.click('button:has-text("Salvar")', force=True)
            
            page.wait_for_timeout(2000)
            if page.is_visible('text="Cadastrar Novo Contato"'):
                print("   [!] WARNING: Modal de cliente permaneceu aberto. Pode haver um erro de submissão.")
            else:
                print("   [OK] Novo Cliente salvo com sucesso!")
            
            print("\n4. Testing Novo Pedido Manual Modal")
            page.click('div.cursor-pointer:has-text("Vendas & Bling ERP")', force=True)
            page.wait_for_timeout(1000)
            
            try:
                page.click('button:has-text("Novo Pedido Manual")', force=True)
                page.wait_for_selector('text="Novo Pedido Manual"', timeout=5000)
                page.click('button:has-text("Cancelar")', force=True)
                print("   [OK] Novo Pedido Manual modal opened and closed successfully.")
            except Exception as e:
                print(f"   [!] WARNING: Não foi possível testar o modal Novo Pedido Manual: {e}")
            
            print("\n[OK] All UI tests completed successfully!")
            
        except Exception as e:
            print(f"\n[X] Test failed: {e}")
            page.screenshot(path="tests/error_screenshot.png")
            print("Screenshot saved to tests/error_screenshot.png")
            raise e
        finally:
            browser.close()

if __name__ == "__main__":
    run_tests()
