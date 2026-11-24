import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { BlingPort } from '@/services/blingPort';
import type { Disponivel, PortasDeEdicao } from '@/services/assistenteAdministrativo/editarProdutos';
import {
  conteudoEdicao, propostaEdicao, resultadoEdicao, type PedidoEdicao,
} from '@/services/assistenteAdministrativo/edicaoDeProdutosContract';

const produtos = z.array(z.object({
  id: z.string().uuid(), bling_id: z.string(), nome: z.string(), codigo: z.string().nullable(),
  categoria_id: z.string().uuid().nullable(),
}));
const categorias = z.array(z.object({ id: z.string().uuid(), nome: z.string() }));
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

  async function buscar(scope: VerifiedOrganizationScope, pedido: PedidoEdicao) {
    try {
      const base = banco.from('produtos').select('id,bling_id,nome,codigo,categoria_id')
        .eq('organizacao_id', scope.organizationId).eq('situacao', 'ativo').order('id');
      const consulta = pedido.por === 'sku' ? base.eq('codigo', pedido.referencia).limit(21) : base.limit(1000);
      const resposta = await consulta;
      const parsed = produtos.safeParse(resposta.data);
      if (resposta.error || !parsed.success || parsed.data.length >= 1000) return { _tag: 'indisponivel' as const };
      let selecionados = parsed.data;
      const referencia = normalizar(pedido.referencia);
      if (pedido.por === 'nome') selecionados = selecionados.filter(p => normalizar(p.nome).includes(referencia));
      if (pedido.por === 'categoria') {
        const resultado = await banco.from('categorias').select('id,nome').eq('organizacao_id', scope.organizationId).limit(1000);
        const lista = categorias.safeParse(resultado.data);
        if (resultado.error || !lista.success || lista.data.length >= 1000) return { _tag: 'indisponivel' as const };
        const ids = lista.data.filter(c => normalizar(c.nome) === referencia).map(c => c.id);
        if (ids.length > 1) return { _tag: 'indisponivel' as const };
        selecionados = selecionados.filter(p => p.categoria_id !== null && ids.includes(p.categoria_id));
      }
      return { _tag: 'ok' as const, valor: selecionados.map(p => ({ id: p.id, blingId: p.bling_id, nome: p.nome, codigo: p.codigo })) };
    } catch {
      return { _tag: 'indisponivel' as const };
    }
  }

  return {
    buscar,
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
