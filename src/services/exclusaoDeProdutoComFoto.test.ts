import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type { ArmazenamentoDeImagemPort } from './armazenamentoDeImagem';
import { excluirProdutoComFoto } from './exclusaoDeProdutoComFoto';

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const FOTO = `${ORG}/${PRODUTO}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope;

/**
 * Banco e Storage num só diário de eventos: a ordem entre a exclusão da linha
 * e a remoção do objeto é o que está sob teste.
 */
function cenario(opcoes: { fotoDaLinha: string | null; falharExclusao?: boolean; falharRemocao?: boolean }) {
  const diario: string[] = [];
  let linhaExiste = true;
  const objetos = new Set(opcoes.fotoDaLinha ? [opcoes.fotoDaLinha] : []);
  const armazenamento: Pick<ArmazenamentoDeImagemPort, 'remover'> = {
    async remover(caminhos) {
      diario.push(`storage.remove ${caminhos.join(',')} (linha existe: ${linhaExiste})`);
      if (opcoes.falharRemocao) return { _tag: 'Falhou', causa: new Error('storage fora') };
      for (const c of caminhos) objetos.delete(c);
      return { _tag: 'Removido' };
    },
  };
  const excluirLinha = async (escopo: VerifiedOrganizationScope, produtoId: string) => {
    diario.push(`db.delete ${produtoId} org=${escopo.organizationId}`);
    if (opcoes.falharExclusao) throw new Error('23503 violates foreign key');
    linhaExiste = false;
    return opcoes.fotoDaLinha;
  };
  return { diario, objetos, deps: { excluirLinha, armazenamento }, linhaExiste: () => linhaExiste };
}

describe('exclusão de produto com foto do ORBITA', () => {
  it('remove o objeto só DEPOIS da exclusão da linha, pelo caminho que o banco devolveu', async () => {
    const c = cenario({ fotoDaLinha: FOTO });
    expect(await excluirProdutoComFoto(scope, PRODUTO, c.deps)).toBe('concluida');
    expect(c.diario).toEqual([`db.delete ${PRODUTO} org=${ORG}`, `storage.remove ${FOTO} (linha existe: false)`]);
    expect(c.objetos.size).toBe(0);
  });

  it('produto sem foto não toca o Storage', async () => {
    const c = cenario({ fotoDaLinha: null });
    expect(await excluirProdutoComFoto(scope, PRODUTO, c.deps)).toBe('sem_foto');
    expect(c.diario).toEqual([`db.delete ${PRODUTO} org=${ORG}`]);
  });

  it('falha na exclusão local: a exceção sobe e o arquivo é preservado', async () => {
    const c = cenario({ fotoDaLinha: FOTO, falharExclusao: true });
    await expect(excluirProdutoComFoto(scope, PRODUTO, c.deps)).rejects.toThrow('foreign key');
    expect(c.diario.some((e) => e.startsWith('storage.remove'))).toBe(false);
    expect(c.objetos.has(FOTO)).toBe(true);
  });

  it('falha na limpeza depois da exclusão: não relança nem ressuscita a linha', async () => {
    const c = cenario({ fotoDaLinha: FOTO, falharRemocao: true });
    expect(await excluirProdutoComFoto(scope, PRODUTO, c.deps)).toBe('falhou');
    expect(c.linhaExiste()).toBe(false);
  });

  it.each([
    ['de outra organização', `${OUTRA_ORG}/${PRODUTO}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`],
    ['de outro produto', `${ORG}/44444444-4444-4444-8444-444444444444/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`],
    ['com travessia', `${ORG}/${PRODUTO}/../x/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`],
  ])('caminho %s nunca chega ao Storage.remove', async (_caso, alheio) => {
    const c = cenario({ fotoDaLinha: alheio });
    expect(await excluirProdutoComFoto(scope, PRODUTO, c.deps)).toBe('recusada');
    expect(c.diario.some((e) => e.startsWith('storage.remove'))).toBe(false);
  });
});
