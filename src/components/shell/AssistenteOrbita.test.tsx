// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistenteOrbita } from './AssistenteOrbita';

const org = '11111111-1111-4111-8111-111111111111';
const chave = '22222222-2222-4222-8222-222222222222';
const produtoId = '33333333-3333-4333-8333-333333333333';
const proposta = {
  chave, expiraEm: '2026-11-24T10:00:00+00:00', deposito: { id: 7, nome: 'Geral' },
  itens: [{ produtoId, blingId: '123', nome: 'Rapé A', codigo: 'RAP-1', campo: 'estoque', anterior: 12, valor: 5 }],
};
const final = { mensagem: 'Processamento concluído.', resultados: [{ produtoId, nome: 'Rapé A', estado: 'aplicado' }] };
afterEach(cleanup);

async function perguntar(fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>) {
  const usuario = userEvent.setup();
  render(<AssistenteOrbita organizacaoId={org} fetchWithAuth={fetchWithAuth} />);
  await usuario.click(screen.getByRole('button', { name: 'Assistente ORBITA' }));
  await usuario.type(screen.getByRole('textbox'), 'Deixe RAP-1 com estoque de 5');
  await usuario.click(screen.getByRole('button', { name: 'Enviar pergunta' }));
  await screen.findByRole('button', { name: 'Confirmar alterações' });
  return usuario;
}

describe('painel: prévia e confirmação de produtos', () => {
  it('mostra antes/depois e só envia confirmação após o clique explícito', async () => {
    const chamadas: { url: string; corpo: unknown }[] = [];
    const usuario = await perguntar(async (url, options) => {
      chamadas.push({ url, corpo: JSON.parse(String(options?.body)) });
      return Response.json(chamadas.length === 1 ? { mensagem: 'Confira a prévia.', proposta } : final);
    });
    expect(screen.getByText('Antes: 12')).toBeTruthy();
    expect(screen.getByText('Depois: 5')).toBeTruthy();
    expect(chamadas).toHaveLength(1);
    await usuario.click(screen.getByRole('button', { name: 'Confirmar alterações' }));
    await screen.findByText('Processamento concluído.');
    expect(chamadas[1]).toEqual({ url: '/api/assistente/orbita/confirmar', corpo: { chave, organizacaoEsperada: org } });
    expect(screen.getByText(/Alteração aceita no Bling/)).toBeTruthy();
  });

  it('cancelar a prévia não envia comando de escrita', async () => {
    const chamadas: string[] = [];
    const usuario = await perguntar(async url => { chamadas.push(url); return Response.json({ mensagem: 'Confira.', proposta }); });
    await usuario.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(chamadas).toEqual(['/api/assistente/orbita']);
    expect(screen.getByText(/Proposta descartada/)).toBeTruthy();
  });

  it('após resposta perdida, consulta a mesma chave até obter os recibos finais', async () => {
    const chaves: string[] = [];
    const usuario = await perguntar(async (url, options) => {
      if (!url.endsWith('/confirmar')) return Response.json({ mensagem: 'Confira.', proposta });
      chaves.push(JSON.parse(String(options?.body)).chave);
      if (chaves.length === 1) throw new Error('Conexão encerrada.');
      return Response.json(chaves.length === 2 ? { mensagem: 'Ainda em andamento.', emAndamento: true, resultados: [] } : final);
    });
    await usuario.click(screen.getByRole('button', { name: 'Confirmar alterações' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Cancelar' }).hasAttribute('disabled')).toBe(true);
    await usuario.click(screen.getByRole('button', { name: 'Conferir confirmação' }));
    await screen.findByText('Ainda em andamento.');
    await usuario.click(screen.getByRole('button', { name: 'Conferir confirmação' }));
    await screen.findByText('Processamento concluído.');
    expect(chaves).toEqual([chave, chave, chave]);
  });

  it("digitar \"confirmo\" confirma a prévia pendente como o botão", async () => {
    const urls: string[] = [];
    const usuario = await perguntar(async url => {
      urls.push(url);
      return Response.json(url.endsWith("/confirmar") ? final : { mensagem: "Confira a prévia.", proposta });
    });
    await usuario.type(screen.getByRole("textbox"), "confirmo{Enter}");
    await screen.findByText("Processamento concluído.");
    expect(urls).toEqual(["/api/assistente/orbita", "/api/assistente/orbita/confirmar"]);
  });

  it("com prévia pendente, outro texto não é enviado", async () => {
    const urls: string[] = [];
    const usuario = await perguntar(async url => { urls.push(url); return Response.json({ mensagem: "Confira.", proposta }); });
    await usuario.type(screen.getByRole("textbox"), "quanto vendemos hoje?{Enter}");
    expect(urls).toEqual(["/api/assistente/orbita"]);
    expect(screen.getByRole("button", { name: "Enviar pergunta" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("painel: escolha entre produtos parecidos", () => {
  const outroId = "44444444-4444-4444-8444-444444444444";
  const pedido = { acao: "editar_produtos", selecao: "um", por: "nome", referencia: "rape de cravo", campo: "estoque", valor: 5 };
  const escolha = { pedido, total: 2, candidatos: [
    { produtoId, nome: "Rapé 15ml Nome:Cravo", codigo: "HX-RAP-15-CRAVO" },
    { produtoId: outroId, nome: "Rapé 20ml Nome:Cravo", codigo: "HX-RAP-20-CRAVO" },
  ] };

  it("marca um ou vários, envia só os escolhidos e mostra a prévia", async () => {
    const chamadas: { url: string; corpo: unknown }[] = [];
    const usuario = userEvent.setup();
    render(<AssistenteOrbita organizacaoId={org} fetchWithAuth={async (url, options) => {
      chamadas.push({ url, corpo: JSON.parse(String(options?.body)) });
      return Response.json(url.endsWith("/escolher") ? { mensagem: "Confira a prévia.", proposta } : { mensagem: "Encontrei 2 produtos parecidos.", escolha });
    }} />);
    await usuario.click(screen.getByRole("button", { name: "Assistente ORBITA" }));
    await usuario.type(screen.getByRole("textbox"), "defina o estoque do rape de cravo para 5{Enter}");
    const preparar = await screen.findByRole("button", { name: /Preparar prévia/ });
    expect(preparar.hasAttribute("disabled")).toBe(true);
    await usuario.click(screen.getByRole("checkbox", { name: /20ml/ }));
    await usuario.click(screen.getByRole("checkbox", { name: /15ml/ }));
    await usuario.click(screen.getByRole("button", { name: "Preparar prévia (2)" }));
    await screen.findByRole("button", { name: "Confirmar alterações" });
    expect(chamadas[1]).toEqual({ url: "/api/assistente/orbita/escolher", corpo: { organizacaoEsperada: org, pedido, produtoIds: [outroId, produtoId] } });
  });

  it("cancelar a escolha não chama a prévia", async () => {
    const urls: string[] = [];
    const usuario = userEvent.setup();
    render(<AssistenteOrbita organizacaoId={org} fetchWithAuth={async url => { urls.push(url); return Response.json({ mensagem: "Encontrei 2.", escolha }); }} />);
    await usuario.click(screen.getByRole("button", { name: "Assistente ORBITA" }));
    await usuario.type(screen.getByRole("textbox"), "defina o estoque do rape de cravo para 5{Enter}");
    await usuario.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(screen.getByText(/Escolha descartada/)).toBeTruthy();
    expect(urls).toEqual(["/api/assistente/orbita"]);
  });
});
