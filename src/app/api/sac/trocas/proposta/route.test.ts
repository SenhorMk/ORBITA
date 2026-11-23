import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const { resolver, rpc } = vi.hoisted(() => ({ resolver: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/requestOrganizationContext', () => ({ resolveVerifiedOrganizationScope: resolver }));
vi.mock('@/lib/supabaseServer', () => ({ supabaseServer: { rpc } }));

const id = (n: number) => 'eed00000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = { organizationId: id(1), actorId: id(2), role: 'owner' };
const conversaId = id(3);
const pedidoId = id(4);
const itemId = id(5);
const decisao = { acao: 'aprovar', conversaId, versao: 2, digest: 'a'.repeat(64), operacaoId: id(6) };
const url = 'https://orbita.test/api/sac/trocas/proposta';
const post = (body: unknown) => POST(new Request(url, { method: 'POST', body: JSON.stringify(body) }));

describe('API da proposta persistida', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolver.mockResolvedValue({ _tag: 'RequestScopeResolved', scope });
  });

  it('usa ator e organização da sessão e exige CAS para aprovar', async () => {
    rpc.mockResolvedValue({ data: { estado: 'ok', casoId: id(7), versao: 2, digest: decisao.digest, situacao: 'aprovada' } });
    expect((await post({ ...decisao, organizationId: id(99) })).status).toBe(400);
    expect((await post({ ...decisao, digest: 'inventado' })).status).toBe(400);
    expect((await post(decisao)).status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('sac_proposta_resolucao', expect.objectContaining({
      p_ator: scope.actorId, p_org: scope.organizationId, p_acao: 'aprovar', p_versao: 2, p_digest: decisao.digest, p_entrada: null,
    }));
  });

  it('impede decisão de membro e qualquer uso sem sessão', async () => {
    resolver.mockResolvedValueOnce({ _tag: 'RequestScopeResolved', scope: { ...scope, role: 'member' } });
    expect((await post(decisao)).status).toBe(403);
    resolver.mockResolvedValueOnce({ _tag: 'RequestScopeDenied', response: new Response(null, { status: 401 }) });
    expect((await GET(new Request(url + '?conversaId=' + conversaId))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retorna o bloqueio persistido sem converter falha da RPC em sucesso', async () => {
    rpc.mockResolvedValueOnce({ data: { estado: 'bloqueada', pendencias: ['politica', 'compatibilidade'] } });
    const negada = await post(decisao);
    expect(negada.status).toBe(409);
    expect(await negada.json()).toEqual({ estado: 'bloqueada', pendencias: ['politica', 'compatibilidade'] });
    rpc.mockResolvedValueOnce({ error: new Error('detalhe não público') });
    expect(await (await post(decisao)).json()).toEqual({ estado: 'indisponivel' });
  });

  it('passa a fonte autorizada pelo ranking do #167 e filtra candidatos não elegíveis', async () => {
    const atual = new Date(Date.now() - 1_000).toISOString();
    const velha = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const perfil = { familia: 'camiseta', variante: 'M', versao: '15' };
    const candidato = { organizacaoId: scope.organizationId, nome: 'Substituto sintético', situacao: 'ativo',
      disponivel: 2, precoCentavos: 2999, moeda: 'BRL', precoSincronizadoEm: atual, estoqueSincronizadoEm: atual,
      compatibilidade: perfil };
    rpc.mockResolvedValue({ data: {
      organizacaoId: scope.organizationId, conversaId, pedidoId, itemId,
      provaValidaAte: new Date(Date.now() + 60_000).toISOString(),
      original: { produtoId: id(9), quantidade: 3, precoCentavos: 1999, moeda: 'BRL', pedidoSincronizadoEm: atual, compatibilidade: perfil },
      candidatos: [
        { ...candidato, produtoId: id(10) },
        { ...candidato, produtoId: id(11), organizacaoId: id(99) },
        { ...candidato, produtoId: id(12), disponivel: 0 },
        { ...candidato, produtoId: id(13), compatibilidade: null },
        { ...candidato, produtoId: id(14), estoqueSincronizadoEm: velha },
        { ...candidato, produtoId: id(15), compatibilidade: { ...perfil, variante: 'P' } },
      ],
    } });
    const query = new URLSearchParams({ conversaId, pedidoId, itemId, quantidade: '2' });
    const resposta = await GET(new Request(url + '?' + query));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ alternativas: [{ produtoId: id(10), deltaTotalCentavos: 2000 }] });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('sac_fatos_ranking', {
      p_org: scope.organizationId, p_ator: scope.actorId, p_conversa: conversaId, p_pedido: pedidoId, p_item: itemId,
    });
  });
});
