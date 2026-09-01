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

import { usePapelNaOrganizacaoAtiva, type SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';
import type { AuthenticatedFetch } from './useOrganizationPanel';

function respostaCom(corpo: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 403,
    json: async () => corpo,
  } as Response;
}

/**
 * Busca que guarda as próprias promessas, para o teste poder esperar por elas.
 *
 * Os casos de falha fechada afirmam uma **ausência**, e ausência medida antes
 * da resposta chegar não prova nada: o papel ainda não teve chance de aparecer.
 * Esperar no escuro também não serve — o teste passaria por chegar cedo demais.
 * Aqui o teste aguarda **a mesma promessa** que o hook aguardou.
 */
function buscaObservavel(responder: () => Promise<Response>) {
  const emVoo: Promise<Response>[] = [];
  const fn = vi.fn(() => {
    const promessa = responder();
    emVoo.push(promessa);
    return promessa;
  });
  return {
    fn,
    /** Espera a leitura pendente terminar e o React reagir a ela. */
    async assentar(): Promise<void> {
      await waitFor(() => expect(fn).toHaveBeenCalled());
      await Promise.allSettled(emVoo);
      await waitFor(() => expect(fn.mock.settledResults.length).toBe(emVoo.length));
    },
  };
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
    const busca = buscaObservavel(async () =>
      respostaCom({ organizacoes: [], activeOrg: null, selectionVersion: null }),
    );
    const buscar = busca.fn;
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(buscar, 'dono@empresa.com'));

    await busca.assentar();
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
    // O e-mail nunca entrou na conta: o hook não o recebe.
    expect(buscar).toHaveBeenCalledWith('/api/organizacoes');
  });

  it('falha fechada quando o servidor nega', async () => {
    const busca = buscaObservavel(async () => respostaCom({ error: 'Não autorizado' }, false));
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(busca.fn, 'dono@empresa.com'));

    await busca.assentar();
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
  });

  it('falha fechada quando a resposta não dá para ler', async () => {
    const busca = buscaObservavel(async () => {
      throw new Error('rede caiu');
    });
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(busca.fn, 'dono@empresa.com'));

    await busca.assentar();
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
  });

  it('recusa um papel que não é um dos três conhecidos', async () => {
    const busca = buscaObservavel(async () => respostaCom({ activeOrg: { papel: 'dono' } }));
    const { result } = renderHook(() => usePapelNaOrganizacaoAtiva(busca.fn, 'dono@empresa.com'));

    await busca.assentar();
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

/**
 * Revisão do #66 — o papel é do par (sessão, organização), não da sessão.
 *
 * Chavear só pela sessão bastava para a troca de **usuário**, e era o que a
 * primeira versão fazia. Não bastava para a troca de **organização**: o mesmo
 * usuário é `owner` em A e `member` em B, e a tela continuava mostrando o papel
 * de A até a resposta de B chegar. O servidor negava as operações, então não
 * havia elevação — a tela é que mentia, que é o defeito que este seam existe
 * para não ter.
 */
describe('usePapelNaOrganizacaoAtiva — troca de organização', () => {
  const SESSAO = 'mesmo.usuario@empresa.com';
  const ORG_A: SelecaoDeOrganizacao = { id: 'org-a', versao: 1 };
  const ORG_B: SelecaoDeOrganizacao = { id: 'org-b', versao: 2 };

  /** O que `GET /api/organizacoes` responde com uma organização ativa. */
  function organizacaoAtiva(id: string, papel: 'owner' | 'admin' | 'member', versao: number) {
    return respostaCom({
      organizacoes: [{ id, nome: id, slug: id }],
      activeOrg: { organizacao: { id, nome: id, slug: id }, papel },
      selectionVersion: versao,
    });
  }

  function renderizar(buscar: AuthenticatedFetch, inicial: SelecaoDeOrganizacao) {
    return renderHook(
      ({ selecao }: { selecao: SelecaoDeOrganizacao }) =>
        usePapelNaOrganizacaoAtiva(buscar, SESSAO, selecao),
      { initialProps: { selecao: inicial } },
    );
  }

  // O caso central: quem administra A e só participa de B não pode continuar
  // vendo controles de gestão em B — nem por um quadro.
  it('owner em A → member em B: os controles somem na hora, antes da resposta de B', async () => {
    const buscar = vi.fn()
      .mockResolvedValueOnce(organizacaoAtiva('org-a', 'owner', 1))
      .mockImplementationOnce(() => new Promise<Response>(() => {})); // B ainda não respondeu

    const { result, rerender } = renderizar(buscar, ORG_A);
    await waitFor(() => expect(result.current.podeGerir).toBe(true));

    rerender({ selecao: ORG_B });

    // Sem esperar coisa alguma: o papel de A não vale para B.
    expect(result.current.papel).toBeNull();
    expect(result.current.podeGerir).toBe(false);
    // E a organização confirmada some junto, que é o que impede o startup de B
    // de rodar com o papel de A.
    expect(result.current.organizacaoId).toBeNull();
  });

  // O inverso, e ele importa tanto quanto: quem é `member` em A e `admin` em B
  // ficava sem os controles que tem.
  it('member em A → admin em B: os controles aparecem quando B responde', async () => {
    const buscar = vi.fn()
      .mockResolvedValueOnce(organizacaoAtiva('org-a', 'member', 1))
      .mockResolvedValueOnce(organizacaoAtiva('org-b', 'admin', 2));

    const { result, rerender } = renderizar(buscar, ORG_A);
    await waitFor(() => expect(result.current.papel).toBe('member'));

    rerender({ selecao: ORG_B });
    expect(result.current.podeGerir).toBe(false);

    await waitFor(() => expect(result.current.podeGerir).toBe(true));
    expect(result.current.papel).toBe('admin');
    expect(result.current.organizacaoId).toBe('org-b');
  });

  // A resposta atrasada é a mesma classe de erro do `localStorage`, num eixo a
  // mais: um papel de outro contexto voltando a valer.
  it('resposta atrasada de A não altera o papel já resolvido de B', async () => {
    let responderA: (resposta: Response) => void = () => {};
    const buscar = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolver) => { responderA = resolver; }))
      .mockResolvedValueOnce(organizacaoAtiva('org-b', 'member', 2));

    const { result, rerender } = renderizar(buscar, ORG_A);
    rerender({ selecao: ORG_B });
    await waitFor(() => expect(result.current.papel).toBe('member'));

    // A de A chega agora, dizendo `owner` — e não pode ser aplicada.
    responderA(organizacaoAtiva('org-a', 'owner', 1));
    await waitFor(() => expect(buscar).toHaveBeenCalledTimes(2));

    expect(result.current.papel).toBe('member');
    expect(result.current.podeGerir).toBe(false);
    expect(result.current.organizacaoId).toBe('org-b');
  });

  it('trocar de organização, sem trocar de sessão, provoca leitura nova', async () => {
    const buscar = vi.fn()
      .mockResolvedValueOnce(organizacaoAtiva('org-a', 'owner', 1))
      .mockResolvedValueOnce(organizacaoAtiva('org-b', 'owner', 2));

    const { result, rerender } = renderizar(buscar, ORG_A);
    await waitFor(() => expect(buscar).toHaveBeenCalledTimes(1));

    rerender({ selecao: ORG_B });

    await waitFor(() => expect(buscar).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.organizacaoId).toBe('org-b'));
  });

  // Sair de A para B e voltar para A é uma seleção nova, e o servidor pode ter
  // mudado o papel no meio. Só o id não distingue as duas — a versão distingue.
  it('voltar para a mesma organização, com versão nova, também relê', async () => {
    const buscar = vi.fn()
      .mockResolvedValueOnce(organizacaoAtiva('org-a', 'owner', 1))
      .mockResolvedValueOnce(organizacaoAtiva('org-a', 'member', 3));

    const { result, rerender } = renderizar(buscar, ORG_A);
    await waitFor(() => expect(result.current.podeGerir).toBe(true));

    rerender({ selecao: { id: 'org-a', versao: 3 } });
    expect(result.current.podeGerir).toBe(false);

    await waitFor(() => expect(result.current.papel).toBe('member'));
    expect(buscar).toHaveBeenCalledTimes(2);
  });
});
