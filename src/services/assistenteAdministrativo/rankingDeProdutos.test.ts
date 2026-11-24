import { describe, expect, it } from 'vitest';
import { decidirProduto, distancia, palavras, ranquearProdutos, type ProdutoRanqueavel } from './rankingDeProdutos';

let seq = 0;
const p = (nome: string, codigo: string | null, categoria: string | null = null): ProdutoRanqueavel => ({ id: `p${++seq}`, nome, codigo, categoria });

const sabores = ['Cacau', 'Cravo', 'Tsunu', 'Paricá', 'Ayahuasca', 'Canela de Velho', 'Artemísia'];
const catalogo: ProdutoRanqueavel[] = [
  p('Rapé 15ml - Sabores Variados', 'HX-RAP-15', 'Rapé'),
  p('Rapé 20ml - Sabores Variados', 'HX-RAP-20'),
  ...sabores.map((s) => p(`Rapé 15ml - Sabores Variados Nome:${s}`, `HX-RAP-15-${s.toUpperCase()}`)),
  ...sabores.map((s) => p(`Rapé 20ml - Sabores Variados Nome:${s}`, `HX-RAP-20-${s.toUpperCase()}`)),
  ...['Harmonia', 'Luz', 'Purificação'].flatMap((s) => [
    p(`Defumador Líquido - Portal da ${s}`, `HX-DEF-${s.slice(0, 3).toUpperCase()}`, 'Defumador'),
    p(`Kumbaiá - Portal da ${s}`, `HX-KUM-${s.slice(0, 3).toUpperCase()}`),
    p(`Óleo Essencial Portal da ${s} - 15 ml`, `HX-OLE-${s.slice(0, 3).toUpperCase()}-15`),
  ]),
  p('Kuripes', 'HX-ACE-KUR'),
  p('Tepis', 'HX-ACE-TIP'),
  p('Sta. Maria', 'STA-MAR'),
];

const nomes = (ref: string) => ranquearProdutos(ref, catalogo).map((c) => c.produto.nome);
const decisao = (ref: string) => decidirProduto(ranquearProdutos(ref, catalogo));

describe('palavras e distância', () => {
  it('normaliza acentos, caixa, plurais simples e ignora palavras vazias', () => {
    expect(palavras('Rapés de CRAVO')).toEqual(['rape', 'cravo']);
    expect(palavras('Sabores Variados')).toEqual(['sabor', 'variado']);
    expect(palavras('Óleo Essencial - 15 ml')).toEqual(['oleo', 'essencial', '15']);
  });
  it('distância com corte', () => {
    expect(distancia('ayahuaska', 'ayahuasca', 2)).toBe(1);
    expect(distancia('cravo', 'defumador', 1)).toBe(2);
  });
});

describe('ranking de produtos', () => {
  it('"rapé de cravo" traz só os dois de cravo, sem os outros rapés', () => {
    expect(nomes('rapé de cravo')).toEqual(['Rapé 15ml - Sabores Variados Nome:Cravo', 'Rapé 20ml - Sabores Variados Nome:Cravo']);
  });

  it('a palavra rara pesa mais que a comum', () => {
    const [primeiro] = ranquearProdutos('rapé cacau', catalogo);
    expect(primeiro.produto.nome).toContain('Cacau');
  });

  it('SKU igual, ignorando pontuação e caixa, fica no topo e é exato', () => {
    const [primeiro] = ranquearProdutos('hx rap 15', catalogo);
    expect(primeiro).toMatchObject({ exato: true, produto: { codigo: 'HX-RAP-15' } });
  });

  it('tolera erro de digitação, mas com peso menor', () => {
    const r = ranquearProdutos('rapé de ayahuaska', catalogo);
    expect(r.map((c) => c.produto.nome)).toEqual(expect.arrayContaining(['Rapé 15ml - Sabores Variados Nome:Ayahuasca']));
    expect(r[0].pontuacao).toBeLessThan(0.99);
  });

  it('referência sem nada parecido não traz candidatos', () => {
    expect(ranquearProdutos('bicicleta', catalogo)).toEqual([]);
  });

  it('limite opcional devolve só os primeiros', () => {
    expect(ranquearProdutos('rapé', catalogo, 5)).toHaveLength(5);
  });
});

describe('decisão: seguir com um produto ou perguntar', () => {
  it('um produto inequívoco segue direto', () => {
    for (const ref of ['óleo da luz', 'defumador harmonia', 'kuripe', 'tepi', 'HX-RAP-15', 'rap-15-cravo']) {
      expect(decisao(ref).tipo, ref).toBe('unico');
    }
    const d = decisao('óleo da luz');
    expect(d.tipo === 'unico' && d.candidato.produto.nome).toBe('Óleo Essencial Portal da Luz - 15 ml');
  });

  it('empate pergunta: "rapé de cravo" (15 ml e 20 ml) e "portal da luz" (3 linhas)', () => {
    const cravo = decisao('rapé de cravo');
    expect(cravo.tipo).toBe('escolher');
    const luz = decisao('portal da luz');
    expect(luz.tipo === 'escolher' && luz.candidatos.map((c) => c.produto.codigo).sort())
      .toEqual(['HX-DEF-LUZ', 'HX-KUM-LUZ', 'HX-OLE-LUZ-15']);
  });

  it('referência genérica mostra os 5 mais prováveis e conta o total', () => {
    const d = decisao('rapé');
    expect(d.tipo).toBe('escolher');
    if (d.tipo !== 'escolher') return;
    expect(d.candidatos).toHaveLength(5);
    expect(d.total).toBe(16);
  });

  it('casamento só por erro de digitação nunca é inequívoco', () => {
    expect(decisao('rapé de ayahuaska').tipo).toBe('escolher');
  });

  it('nada parecido', () => {
    expect(decisao('bicicleta')).toEqual({ tipo: 'nenhum' });
  });
});
