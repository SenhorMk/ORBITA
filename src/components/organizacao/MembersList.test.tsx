/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MembersList } from './MembersList';
import type { MembroOrganizacao } from './types';

const UUID_DA_DONA = 'fc943538-036f-48f2-92e3-1787179a8e03';
const UUID_SEM_NOME = 'aec41ad2-afd6-4652-9216-f03320cd6e57';

function montar(membros: readonly MembroOrganizacao[], canManage = true) {
  const onRemove = vi.fn(async () => {});
  render(
    <MembersList
      membros={membros}
      carregando={false}
      erroDeLeitura={null}
      erroDeAcao={null}
      canManage={canManage}
      onRemove={onRemove}
      onRecarregar={vi.fn()}
    />,
  );
  return { onRemove };
}

describe('MembersList — como o membro é identificado', () => {
  it('mostra o nome do cadastro como informação principal', () => {
    montar([
      {
        user_id: UUID_DA_DONA,
        papel: 'owner',
        created_at: '2026-07-01T00:00:00Z',
        nome_exibicao: 'Mariana Haux',
        origem_do_nome: 'cadastro',
      },
    ]);

    expect(screen.getByText('Mariana Haux')).toBeTruthy();
  });

  it('não imprime o UUID em lugar nenhum da linha', () => {
    // Este é o defeito que a fatia fecha. Numa lista de autoridade, ao lado de
    // um botão de remover, um UUID não deixa ninguém conferir se está removendo
    // a pessoa certa — e é a primeira coisa que a banca lê nesta tela.
    montar([
      {
        user_id: UUID_DA_DONA,
        papel: 'owner',
        created_at: '2026-07-01T00:00:00Z',
        nome_exibicao: 'Mariana Haux',
        origem_do_nome: 'cadastro',
      },
    ]);

    expect(document.body.textContent).not.toContain(UUID_DA_DONA);
    expect(screen.getByTestId('members-list').innerHTML).not.toContain(UUID_DA_DONA);
  });

  it('diz que não há nome cadastrado, em vez de inventar um', () => {
    montar([
      {
        user_id: UUID_SEM_NOME,
        papel: 'member',
        created_at: '2026-08-02T00:00:00Z',
        nome_exibicao: null,
        origem_do_nome: 'ausente',
      },
    ]);

    expect(screen.getByText('Sem nome cadastrado')).toBeTruthy();
    expect(document.body.textContent).not.toContain(UUID_SEM_NOME);
  });

  it('separa "não tem nome" de "não consegui ler a identidade"', () => {
    // As duas frases parecem intercambiáveis e não são: uma descreve o cadastro
    // da pessoa, a outra descreve uma falha do servidor. Dizer a primeira sobre
    // a segunda é afirmar um fato que ninguém verificou.
    montar([
      {
        user_id: UUID_SEM_NOME,
        papel: 'member',
        created_at: '2026-08-02T00:00:00Z',
        nome_exibicao: null,
        origem_do_nome: 'indisponivel',
      },
    ]);

    expect(screen.getByText('Identidade indisponível')).toBeTruthy();
    expect(screen.queryByText('Sem nome cadastrado')).toBeNull();
  });

  it('continua legível diante de uma resposta antiga, sem os campos de identidade', () => {
    // Entre o deploy da rota e o do cliente — ou num cache — a resposta pode
    // não trazer campo nenhum. `undefined` na tela seria pior que o UUID.
    montar([{ user_id: UUID_SEM_NOME, papel: 'member', created_at: '2026-08-02T00:00:00Z' }]);

    expect(screen.getByText('Sem nome cadastrado')).toBeTruthy();
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('mantém papel e data de entrada ao lado do nome', () => {
    montar([
      {
        user_id: UUID_DA_DONA,
        papel: 'admin',
        created_at: '2026-08-02T00:00:00Z',
        nome_exibicao: 'Quem Administra',
        origem_do_nome: 'cadastro',
      },
    ]);

    // A pílula do Design System imprime o papel em caixa alta.
    expect(screen.getByText('ADMINISTRADOR')).toBeTruthy();
    // A data é formatada no fuso de quem roda o teste — comparar com um literal
    // deixaria o resultado dependendo da máquina, não do componente.
    const esperada = new Date('2026-08-02T00:00:00Z').toLocaleDateString('pt-BR');
    expect(document.body.textContent).toContain(`desde ${esperada}`);
  });

  it('a remoção é oferecida pelo nome e continua agindo sobre o user_id', () => {
    // O rótulo mudou; a chave, não. Quem lê o botão vê a pessoa; quem o aperta
    // envia o identificador que o servidor conhece.
    const { onRemove } = montar([
      {
        user_id: UUID_SEM_NOME,
        papel: 'member',
        created_at: '2026-08-02T00:00:00Z',
        nome_exibicao: 'Colega de Balcão',
        origem_do_nome: 'cadastro',
      },
    ]);

    const botao = screen.getByRole('button', { name: 'Remover Colega de Balcão' });
    botao.click();

    expect(onRemove).toHaveBeenCalledWith(UUID_SEM_NOME);
  });

  it('nunca oferece remover o dono', () => {
    montar([
      {
        user_id: UUID_DA_DONA,
        papel: 'owner',
        created_at: '2026-07-01T00:00:00Z',
        nome_exibicao: 'Mariana Haux',
        origem_do_nome: 'cadastro',
      },
    ]);

    expect(screen.queryByRole('button', { name: /^Remover/ })).toBeNull();
  });
});
