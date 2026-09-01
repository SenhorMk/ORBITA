// @vitest-environment jsdom
/**
 * Ticket 22, fatia C — a autoridade de papel na interface.
 *
 * A tela decidia quem era dono por `app_metadata.role`, pela substring `dono` no
 * e-mail, por um e-mail fixo e por `localStorage`. A limpeza dos metadados
 * históricos tornou o defeito visível: a conta do proprietário, com vínculo
 * `owner` em `pth`, virava `colaborador` na tela por não casar com nenhuma
 * heurística. E o inverso também valia — e-mail com `dono` ganhava aparência de
 * proprietário.
 *
 * Nenhuma sonda direta às APIs pega isso: o servidor sempre autorizou certo. O
 * defeito era só da tela, e é a tela que estes testes exercitam.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { usePapelNaOrganizacaoAtiva } from './usePapelNaOrganizacaoAtiva';

function respostaCom(corpo: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 403,
    json: async () => corpo,
  } as Response;
}

/** O que `GET /api/organizacoes` responde para quem tem vínculo. */
function comVinculo(papel: 'owner' | 'admin' | 'member') {
  return vi.fn().mockResolvedValue(
    respostaCom({
      organizacoes: [{ id: 'org-1', nome: 'Portal do Haux', slug: 'pth' }],
      activeOrg: { organizacao: { id: 'org-1', nome: 'Portal do Haux', slug: 'pth' }, papel },
      selectionVersion: 1,
    }),
  );
}

/** E para quem não tem: lista vazia, sem organização ativa. */
function semVinculo() {
  return vi.fn().mockResolvedValue(
    respostaCom({ organizacoes: [], activeOrg: null, selectionVersion: null }),
  );
}

describe('usePapelNaOrganizacaoAtiva', () => {
  // O caso que a limpeza dos metadados expôs: sem `app_metadata.role`, e ainda
  // assim proprietário — porque o vínculo é que decide.
  it('dá interface de gestão a quem tem vínculo `owner`, sem depender de metadado', async () => {
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(comVinculo('owner'), 'dono@empresa.com'));

    await waitFor(() => expect(result.current.papel).toBe('owner'));
    expect(result.current.podeGerir).toBe(true);
  });

  it('dá interface de gestão ao `admin`, como a tabela de capacidades do servidor', async () => {
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(comVinculo('admin'), 'dono@empresa.com'));

    await waitFor(() => expect(result.current.papel).toBe('admin'));
    expect(result.current.podeGerir).toBe(true);
  });

  it('não dá controles de gestão ao membro', async () => {
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(comVinculo('member'), 'dono@empresa.com'));

    await waitFor(() => expect(result.current.papel).toBe('member'));
    expect(result.current.podeGerir).toBe(false);
  });

  // O inverso do defeito: aparência de proprietário para quem não é.
  it('não dá controles a quem não tem vínculo, qualquer que seja o e-mail', async () => {
    const buscar = semVinculo();
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(buscar, 'dono@empresa.com'));

    await waitFor(() => expect(result.current.carregando).toBe(false));
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
    // O e-mail nunca entrou na conta: o hook não o recebe.
    expect(buscar).toHaveBeenCalledWith('/api/organizacoes');
  });

  it('falha fechada quando o servidor nega', async () => {
    const { result } = renderHook(() =>
      usePapelNaOrganizacaoAtiva(vi.fn().mockResolvedValue(respostaCom({ error: 'Não autorizado' }, false)), 'dono@empresa.com'),
    );

    await waitFor(() => expect(result.current.carregando).toBe(false));
    expect(result.current.podeGerir).toBe(false);
  });

  it('falha fechada quando a resposta não dá para ler', async () => {
    const { result } = renderHook(() =>
      usePapelNaOrganizacaoAtiva(vi.fn().mockRejectedValue(new Error('rede caiu')), 'dono@empresa.com'),
    );

    await waitFor(() => expect(result.current.carregando).toBe(false));
    expect(result.current.podeGerir).toBe(false);
  });

  it('recusa um papel que não é um dos três conhecidos', async () => {
    const { result } = renderHook(() =>
      usePapelNaOrganizacaoAtiva(
        vi.fn().mockResolvedValue(respostaCom({ activeOrg: { papel: 'dono' } })),
        'dono@empresa.com',
      ),
    );

    await waitFor(() => expect(result.current.carregando).toBe(false));
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
  });

  // Sair da sessão apaga o papel: ele não sobrevive à troca de usuário, que era
  // exatamente o que o `localStorage` fazia.
  it('não consulta nem concede nada sem sessão', async () => {
    const buscar = comVinculo('owner');
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(buscar, null));

    await waitFor(() => expect(result.current.papel).toBeNull());
    expect(result.current.podeGerir).toBe(false);
    expect(buscar).not.toHaveBeenCalled();
  });

  // O coração do defeito que o `localStorage` criava: o papel de um usuário
  // aparecendo para outro. Aqui a troca é direta, sem passar por logout.
  it('não mostra a outro usuário o papel do usuário anterior', async () => {
    const buscar = vi.fn()
      .mockResolvedValueOnce(respostaCom({ activeOrg: { papel: 'owner' } }))
      .mockImplementationOnce(() => new Promise(() => {})); // resposta que não chega

    const { result, rerender } = renderHook(
      ({ chave }: { chave: string | null }) => usePapelNaOrganizacaoAtiva(buscar, chave),
      { initialProps: { chave: 'dono@empresa.com' as string | null } },
    );
    await waitFor(() => expect(result.current.podeGerir).toBe(true));

    rerender({ chave: 'outro@empresa.com' });

    // Sem esperar coisa alguma: o papel do anterior não vale para esta sessão.
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
    expect(result.current.carregando).toBe(true);
  });

  it('recalcula o papel quando a sessão muda', async () => {
    const buscar = comVinculo('owner');
    const { result, rerender } = renderHook(
      ({ chave }: { chave: string | null }) => usePapelNaOrganizacaoAtiva(buscar, chave),
      { initialProps: { chave: 'dono@empresa.com' as string | null } },
    );
    await waitFor(() => expect(result.current.podeGerir).toBe(true));

    rerender({ chave: null });

    await waitFor(() => expect(result.current.papel).toBeNull());
    expect(result.current.podeGerir).toBe(false);
  });
});
