import { describe, expect, it, vi } from 'vitest';
import { criarWorkerAiFirstPorInbox } from './workerAiFirstPorInbox';
import type { BancoDoWorkerAiFirst, CanalDeProjecaoAiFirst } from './workerAiFirst';

const escopo = { p_org: 'org', p_conexao: 'conn', p_executor: 'actor' };
function canal(pronto = true): CanalDeProjecaoAiFirst {
  return { pronto: vi.fn(async () => pronto), ler: vi.fn(), alterarSemAtribuir: vi.fn() };
}
describe('worker AI-first por inbox', () => {
  it('mantém Shopify pronto quando WhatsApp falha, sem renovar o WhatsApp como pronto', async () => {
    const shopify = canal(), whatsapp = canal();
    vi.mocked(whatsapp.pronto).mockRejectedValue(new Error('Canal indisponível'));
    const rpc = vi.fn<BancoDoWorkerAiFirst['rpc']>(async () => ({ data: true, error: null }));
    const worker = criarWorkerAiFirstPorInbox({ escopo, banco: { rpc }, canais: new Map([[1, shopify], [2, whatsapp]]) });
    expect(await worker.canal.pronto(escopo)).toBe(true);
    await worker.banco.rpc('renovar_worker_ai_first', { ...escopo, p_pronto: true });
    expect(rpc).toHaveBeenCalledWith('renovar_worker_ai_first_inbox', { ...escopo, p_inbox: 1, p_pronto: true });
    expect(rpc).toHaveBeenCalledWith('renovar_worker_ai_first_inbox', { ...escopo, p_inbox: 2, p_pronto: false });
    expect(() => worker.canal.ler(escopo, { inbox_id: 2, id_externo: '10', account_id: '2' })).toThrow();
    expect(whatsapp.ler).not.toHaveBeenCalled();
  });
  it('direciona uma projeção apenas ao canal da própria inbox', async () => {
    const shopify = canal(), whatsapp = canal();
    const worker = criarWorkerAiFirstPorInbox({ escopo, banco: { rpc: vi.fn() }, canais: new Map([[1, shopify], [2, whatsapp]]) });
    await worker.canal.pronto(escopo);
    const item = { inbox_id: 2, id_externo: '11', account_id: '2' };
    await worker.canal.alterarSemAtribuir(escopo, item, 'pending');
    expect(whatsapp.alterarSemAtribuir).toHaveBeenCalledWith(escopo, item, 'pending');
    expect(shopify.alterarSemAtribuir).not.toHaveBeenCalled();
  });
  it('interrompe renovação em ambas as inboxes e recusa RPC de outro escopo', async () => {
    const rpc = vi.fn<BancoDoWorkerAiFirst['rpc']>(async () => ({ data: true, error: null }));
    const worker = criarWorkerAiFirstPorInbox({ escopo, banco: { rpc }, canais: new Map([[1, canal()], [2, canal()]]) });
    await worker.canal.pronto(escopo);
    await worker.banco.rpc('renovar_worker_ai_first', { ...escopo, p_pronto: false });
    expect(rpc.mock.calls.map(call => call[1].p_pronto)).toEqual([false, false]);
    rpc.mockClear();
    const result = await worker.banco.rpc('reivindicar_geracao_ai_first', { ...escopo, p_org: 'outro' });
    expect(result.error).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});
