import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { BlingPort } from '@/services/blingPort';
import type { Disponivel, PortasDeEdicao, ProdutoDoCatalogo } from '@/services/assistenteAdministrativo/editarProdutos';
import { ranquearProdutos } from '@/services/assistenteAdministrativo/rankingDeProdutos';
import {
  conteudoEdicao, propostaEdicao, resultadoEdicao, type PedidoEdicao,
} from '@/services/assistenteAdministrativo/edicaoDeProdutosContract';

const produtos = z.array(z.object({
  id: z.string().uuid(), bling_id: z.string(), nome: z.string(), codigo: z.string().nullable(),
  categoria_id: z.string().uuid().nullable(),
}));
// A tabela categorias guarda o nome em `descricao` (não existe coluna `nome`).
const categorias = z.array(z.object({ id: z.string().uuid(), descricao: z.string().nullable() }));
const reivindicacao = z.discriminatedUnion('estado', [
  z.object({ estado: z.literal('negada') }).strict(),
  z.object({ estado: z.enum(['ocupada', 'concluida']), resultados: z.array(resultadoEdicao) }).strict(),
  z.object({ estado: z.literal('executar'), proposta: propostaEdicao }).strict(),
]);

function normalizar(texto: string) {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').replace(/s\b/gu, '');
}

/** Portas com escopo explícito; RPCs são a única autoridade de escrita durável. */
export function edicoesDeProdutosDoAssistente(banco: SupabaseClient, bling: BlingPort): PortasDeEdicao {
  async function rpc<T>(scope: VerifiedOrganizationScope, operacao: string, schema: z.ZodType<T>, chave?: string, dados?: unknown): Promise<Disponivel<T>> {
    try {
      const resposta = await banco.rpc('assistente_edicao_produtos', {
        p_org: scope.organizationId, p_ator: scope.actorId, p_operacao: operacao,
        p_chave: chave ?? null, p_dados: dados ?? null,
      });
      if (resposta.error) return { _tag: 'indisponivel' };
      const parsed = schema.safeParse(resposta.data);
      return parsed.success ? { _tag: 'ok', valor: parsed.data } : { _tag: 'indisponivel' };
    } catch {
      return { _tag: 'indisponivel' };
    }
  }

  type Produto = z.infer<typeof produtos>[number];
  const paraEdicao = (p: Produto) => ({ id: p.id, blingId: p.bling_id, nome: p.nome, codigo: p.codigo });

  /** Produtos ativos e categorias da organização; 1000 ou mais é tratado como indisponível (sem corte silencioso). */
  async function lerCatalogo(scope: VerifiedOrganizationScope): Promise<Disponivel<{ lista: Produto[]; categoria: Map<string, string> }>> {
    try {
      const resposta = await banco.from('produtos').select('id,bling_id,nome,codigo,categoria_id')
        .eq('organizacao_id', scope.organizationId).eq('situacao', 'ativo').order('id').limit(1000);
      const lista = produtos.safeParse(resposta.data);
      if (resposta.error || !lista.success || lista.data.length >= 1000) return { _tag: 'indisponivel' };
      const cats = await banco.from('categorias').select('id,descricao').eq('organizacao_id', scope.organizationId).limit(1000);
      const nomes = categorias.safeParse(cats.data);
      if (cats.error || !nomes.success || nomes.data.length >= 1000) return { _tag: 'indisponivel' };
      return { _tag: 'ok', valor: { lista: lista.data, categoria: new Map(nomes.data.map(c => [c.id, c.descricao ?? ''])) } };
    } catch {
      return { _tag: 'indisponivel' };
    }
  }

  async function buscar(scope: VerifiedOrganizationScope, pedido: PedidoEdicao) {
    try {
      if (pedido.por === 'sku') {
        const resposta = await banco.from('produtos').select('id,bling_id,nome,codigo,categoria_id')
          .eq('organizacao_id', scope.organizationId).eq('situacao', 'ativo').eq('codigo', pedido.referencia).order('id').limit(21);
        const parsed = produtos.safeParse(resposta.data);
        if (resposta.error || !parsed.success) return { _tag: 'indisponivel' as const };
        return { _tag: 'ok' as const, valor: parsed.data.map(paraEdicao) };
      }
      const catalogo = await lerCatalogo(scope);
      if (catalogo._tag !== 'ok') return { _tag: 'indisponivel' as const };
      const { lista, categoria } = catalogo.valor;
      if (pedido.por === 'nome') {
        // Lote por nome: todos os produtos que cobrem a referência inteira no ranking ("todos os rapés de cravo").
        const doCatalogo = lista.map(p => ({ ...p, categoria: p.categoria_id ? categoria.get(p.categoria_id) ?? null : null }));
        return { _tag: 'ok' as const, valor: ranquearProdutos(pedido.referencia, doCatalogo)
          .filter(c => c.pontuacao >= 0.99).map(c => paraEdicao(c.produto)) };
      }
      const referencia = normalizar(pedido.referencia);
      const ids = [...categoria].filter(([, nome]) => normalizar(nome) === referencia).map(([id]) => id);
      if (ids.length > 1) return { _tag: 'indisponivel' as const };
      return { _tag: 'ok' as const, valor: lista.filter(p => p.categoria_id !== null && ids.includes(p.categoria_id)).map(paraEdicao) };
    } catch {
      return { _tag: 'indisponivel' as const };
    }
  }

  async function catalogoParaRanking(scope: VerifiedOrganizationScope): Promise<Disponivel<ProdutoDoCatalogo[]>> {
    const catalogo = await lerCatalogo(scope);
    if (catalogo._tag !== 'ok') return catalogo;
    return { _tag: 'ok', valor: catalogo.valor.lista.map(p => ({
      ...paraEdicao(p), categoria: p.categoria_id ? catalogo.valor.categoria.get(p.categoria_id) ?? null : null })) };
  }

  async function porIds(scope: VerifiedOrganizationScope, ids: readonly string[]) {
    try {
      if (!ids.length || ids.length > 20 || ids.some(id => !z.string().uuid().safeParse(id).success)) return { _tag: 'indisponivel' as const };
      const resposta = await banco.from('produtos').select('id,bling_id,nome,codigo,categoria_id')
        .eq('organizacao_id', scope.organizationId).eq('situacao', 'ativo').in('id', [...ids]).limit(20);
      const parsed = produtos.safeParse(resposta.data);
      if (resposta.error || !parsed.success) return { _tag: 'indisponivel' as const };
      return { _tag: 'ok' as const, valor: parsed.data.map(paraEdicao) };
    } catch {
      return { _tag: 'indisponivel' as const };
    }
  }

  return {
    buscar,
    catalogo: catalogoParaRanking,
    porIds,
    async ler(id, campo) {
      const leitura = await bling.consultarProdutoAdministrativo(id, campo === 'estoque');
      return leitura._tag === 'RemotoPresente' ? { _tag: 'ok', valor: leitura.valor } : { _tag: 'indisponivel' };
    },
    async deposito() {
      const leitura = await bling.consultarDepositoUnico();
      return leitura._tag === 'RemotoPresente' ? { _tag: 'ok', valor: leitura.valor } : { _tag: 'indisponivel' };
    },
    guardar: (scope, conteudo) => rpc(scope, 'criar', propostaEdicao, undefined, conteudoEdicao.parse(conteudo)),
    reivindicar: (scope, chave) => rpc(scope, 'reivindicar', reivindicacao, chave),
    alterar: (item, deposito) => item.campo === 'estoque'
      ? deposito ? bling.definirSaldoNoDeposito(item.blingId, deposito.id, item.valor)
        : Promise.resolve({ _tag: 'RemotoRecusou', status: 400 })
      : bling.atualizarCampoProduto(item.blingId, item.campo, item.valor),
    registrar: (scope, chave, resultado) => rpc(scope, 'registrar', z.null(), chave, resultado),
    concluir: (scope, chave) => rpc(scope, 'concluir', z.null(), chave),
    agora: Date.now,
  };
}
