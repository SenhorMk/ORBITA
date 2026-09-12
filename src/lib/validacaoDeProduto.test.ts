import { describe, expect, it } from 'vitest';

import { pendenciasLocaisDoProduto, validateProdutoForBling } from './utils';
import { buildProdutoRequest } from './config/produtoContract';

describe('validateProdutoForBling — deriva do contrato compartilhado', () => {
  const formularioValido = {
    nome: 'Kuripe Cobra',
    preco: 120,
    estoque: 3,
    codigo: 'KUR-001',
    tipo: 'P',
    situacao: 'A',
    formato: 'S',
    unidade: 'UN',
  };

  it('aceita o formulário completo', () => {
    expect(validateProdutoForBling(formularioValido).valid).toBe(true);
  });

  it('formato "E" (composição) NÃO é recusado — a tela o oferece e o contrato o aceita', () => {
    // O segundo enum, mantido à parte, só aceitava `S` e `V`: o validador local
    // recusava justamente o valor que o formulário acabara de oferecer.
    const resultado = validateProdutoForBling({ ...formularioValido, formato: 'E' });

    expect(resultado.valid).toBe(true);
    expect(resultado.errors).toEqual([]);
  });

  it('tipo "N" também é aceito, como no contrato oficial', () => {
    expect(validateProdutoForBling({ ...formularioValido, tipo: 'N' }).valid).toBe(true);
  });

  it('e o mesmo valor atravessa `buildProdutoRequest` sem recusa', () => {
    // A prova de que os dois lados agora derivam do mesmo enum: se divergirem
    // outra vez, um destes dois falha.
    expect(() => buildProdutoRequest({
      ...formularioValido,
      situacao: 'A',
      formato: 'E',
      tipo: 'N',
    })).not.toThrow();
  });

  it('continua recusando valor fora do contrato', () => {
    expect(validateProdutoForBling({ ...formularioValido, formato: 'Z' }).valid).toBe(false);
    expect(validateProdutoForBling({ ...formularioValido, situacao: 'X' }).valid).toBe(false);
  });

  it('continua recusando o nome com caractere que o Bling não aceita', () => {
    const resultado = validateProdutoForBling({ ...formularioValido, nome: 'Kuripe ★ Cobra' });

    expect(resultado.valid).toBe(false);
    expect(resultado.errors.join(' ')).toMatch(/caracteres especiais/i);
  });

  it('não duplica a mensagem do nome', () => {
    const resultado = validateProdutoForBling({ ...formularioValido, nome: 'Kuripe ★ Cobra' });
    const sobreCaracteres = resultado.errors.filter((e) => /caracteres especiais/i.test(e));

    expect(sobreCaracteres).toHaveLength(1);
  });

  it('recusa estoque fracionário e preço negativo', () => {
    expect(validateProdutoForBling({ ...formularioValido, estoque: 1.5 }).valid).toBe(false);
    expect(validateProdutoForBling({ ...formularioValido, preco: -1 }).valid).toBe(false);
  });
});

describe('pendenciasLocaisDoProduto — só o que o registro local guarda', () => {
  /** O `Produto` local: sem `tipo`, `situacao` nem `formato`, por construção. */
  const produtoLocal = { nome: 'Kuripe Cobra', preco: 120, estoque: 3 };

  it('um produto local íntegro não tem pendência nenhuma', () => {
    // Este é o falso positivo que a tabela mostrava: o validador do payload do
    // Bling recebia `undefined` em tipo/situacao/formato — campos que o banco
    // não persiste — e relatava três ausências inventadas.
    expect(pendenciasLocaisDoProduto(produtoLocal)).toEqual([]);
  });

  it('não inventa ausência de tipo, situação ou formato', () => {
    const pendencias = pendenciasLocaisDoProduto(produtoLocal).join(' ');

    expect(pendencias).not.toMatch(/tipo/i);
    expect(pendencias).not.toMatch(/situa[çc][ãa]o/i);
    expect(pendencias).not.toMatch(/formato/i);
  });

  it('não exige unidade, que falta em registro legado', () => {
    // A unidade é opcional no registro local e tem padrão explícito no modal;
    // cobrá-la na tabela acusava como defeito um legado que o produto aceita.
    expect(pendenciasLocaisDoProduto(produtoLocal).join(' ')).not.toMatch(/unidade/i);
  });

  it('relata o que é verdade: nome vazio', () => {
    expect(pendenciasLocaisDoProduto({ ...produtoLocal, nome: '' }).join(' ')).toMatch(/nome/i);
  });

  it('relata o que é verdade: estoque fracionário e preço negativo', () => {
    expect(pendenciasLocaisDoProduto({ ...produtoLocal, estoque: 1.5 }).join(' ')).toMatch(/inteiro/i);
    expect(pendenciasLocaisDoProduto({ ...produtoLocal, preco: -5 }).join(' ')).toMatch(/negativo/i);
  });

  it('relata nome com caractere recusado pelo provedor', () => {
    expect(pendenciasLocaisDoProduto({ ...produtoLocal, nome: 'Kuripe ★' }).join(' ')).toMatch(/caracteres especiais/i);
  });
});
