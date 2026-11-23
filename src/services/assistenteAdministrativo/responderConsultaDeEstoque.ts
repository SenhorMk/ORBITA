type Produto = { nome: string; codigo: string | null; estoque: number | null; estoque_reservado: number | null };
type Intencao = { acao: 'consultar' | 'alterar' | 'esclarecer'; produto: string };

export async function responderConsultaDeEstoque(
  intencao: Intencao,
  pergunta: string,
  ler: (referencia: string) => Promise<Produto[]>,
) {
  if (intencao.acao === 'alterar') {
    return { estado: 'escrita_indisponivel', mensagem: 'A baixa pelo assistente ainda está indisponível. Seu estoque não mudou.' } as const;
  }
  const colar = (texto: string) => texto.normalize('NFC').toLocaleLowerCase('pt-BR');
  if (intencao.acao !== 'consultar' || intencao.produto.length < 2 || !colar(pergunta).includes(colar(intencao.produto))) {
    return { estado: 'esclarecer', mensagem: 'Informe o nome ou o SKU do produto que quer consultar.' } as const;
  }
  const produtos = await ler(intencao.produto);
  if (!produtos.length) return { estado: 'sem_produto', mensagem: 'Não encontrei um produto ativo com esse nome ou SKU.' } as const;
  if (produtos.length !== 1) {
    return { estado: 'ambiguo', mensagem: 'Encontrei mais de um produto. Consulte usando o SKU.',
      candidatos: produtos.slice(0, 5).map(({ nome, codigo }) => ({ nome, codigo })) } as const;
  }
  const [{ nome, codigo, estoque, estoque_reservado }] = produtos;
  if (estoque === null || estoque_reservado === null) {
    return { estado: 'saldo_desconhecido', mensagem: 'O produto foi encontrado, mas o saldo disponível ainda não pôde ser confirmado.' } as const;
  }
  const disponivel = Math.max(0, estoque - estoque_reservado);
  return { estado: 'ok', produto: { nome, codigo, fisico: estoque, reservado: estoque_reservado, disponivel },
    mensagem: 'Saldo disponível no ORBITA: ' + disponivel + (disponivel === 1 ? ' unidade.' : ' unidades.') } as const;
}
