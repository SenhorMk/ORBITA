import { escopoTemCapacidade, type VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { EscritaRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import {
  pedidoEdicao, type ItemEdicao, type PedidoEdicao, type PropostaEdicao,
  type RespostaEdicao, type ResultadoEdicao,
} from './edicaoDeProdutosContract';

/** Falhas esperadas das portas são valores; nenhuma mensagem externa chega ao painel. */
export type Disponivel<T> = { readonly _tag: 'ok'; readonly valor: T } | { readonly _tag: 'indisponivel' };
/** Produto encontrado no catálogo escopado; a referência do modelo não é um ID autorizado. */
export type ProdutoParaEdicao = { id: string; blingId: string; nome: string; codigo: string | null };
/** Campo atual lido e parseado no Bling. */
export type DadosProdutoEdicao = { nome: string; descricao: string; estoque: number | null };
type Conteudo = Pick<PropostaEdicao, 'itens' | 'deposito'>;
/** Reivindicação durável: apenas executar permite enviar comandos ao ERP. */
export type ReivindicacaoEdicao =
  | { estado: 'negada' }
  | { estado: 'ocupada' | 'concluida'; resultados: ResultadoEdicao[] }
  | { estado: 'executar'; proposta: PropostaEdicao };

/** Fronteiras externas da operação administrativa, inclusive relógio e persistência. */
export interface PortasDeEdicao {
  buscar(scope: VerifiedOrganizationScope, pedido: PedidoEdicao): Promise<Disponivel<ProdutoParaEdicao[]>>;
  ler(id: string, campo: ItemEdicao['campo']): Promise<Disponivel<DadosProdutoEdicao>>;
  deposito(): Promise<Disponivel<NonNullable<PropostaEdicao['deposito']> | null>>;
  guardar(scope: VerifiedOrganizationScope, conteudo: Conteudo): Promise<Disponivel<PropostaEdicao>>;
  reivindicar(scope: VerifiedOrganizationScope, chave: string): Promise<Disponivel<ReivindicacaoEdicao>>;
  alterar(item: ItemEdicao, deposito: PropostaEdicao['deposito']): Promise<EscritaRemota>;
  registrar(scope: VerifiedOrganizationScope, chave: string, resultado: ResultadoEdicao): Promise<Disponivel<null>>;
  concluir(scope: VerifiedOrganizationScope, chave: string): Promise<Disponivel<null>>;
  agora(): number;
}

function normalizar(texto: string) {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

const indisponivel: RespostaEdicao = { mensagem: 'Não foi possível preparar a alteração. Nenhum comando foi enviado ao Bling.' };
const negada: RespostaEdicao = { mensagem: 'A alteração exige permissão de gestão na organização ativa.' };

class EdicaoDeProdutos {
  constructor(private readonly portas: PortasDeEdicao) {}

    async propor(scope: VerifiedOrganizationScope, entrada: PedidoEdicao, pergunta: string): Promise<RespostaEdicao> {
      const portas = this.portas;
      if (!escopoTemCapacidade(scope, 'organization:manage')) return negada;
      const parsed = pedidoEdicao.safeParse(entrada);
      if (!parsed.success) return indisponivel;
      const pedido = parsed.data;
      const literal = normalizar(pergunta);
      if (pedido.campo === 'estoque' && /\b(?:adicion\w*|acrescent\w*|som\w*|aument\w*|retir\w*|remov\w*|reduz\w*|baix\w*|diminu\w*|mais|menos)\b/u.test(literal)) {
        return { mensagem: 'Esta operação define o saldo final. Diga, por exemplo, “deixe o estoque do SKU X em 5”.' };
      }
      // O modelo não pode expandir o alcance, inventar uma referência ou redigir outro valor.
      if (!literal.includes(normalizar(pedido.referencia))
          || (pedido.selecao === 'todos' && !/\b(?:todos|todas)\b/u.test(literal))
          || (typeof pedido.valor === 'string' && !pergunta.includes(pedido.valor))
          || (typeof pedido.valor === 'number' && !pergunta.match(/-?\d+(?:[.,]\d+)?/gu)?.includes(String(pedido.valor)))) {
        return { mensagem: 'Informe o produto ou categoria e o novo valor literalmente. Para um lote, diga “todos” ou “todas”.' };
      }
      const encontrados = await portas.buscar(scope, pedido);
      if (encontrados._tag !== 'ok') return indisponivel;
      if (!encontrados.valor.length) return { mensagem: 'Não encontrei produtos ativos com essa referência na organização atual.' };
      if (encontrados.valor.length > 20) return { mensagem: 'Encontrei mais de 20 produtos. Restrinja a seleção; nenhum produto foi alterado.' };
      if (pedido.selecao === 'um' && encontrados.valor.length !== 1) return { mensagem: 'Há mais de um produto. Informe o SKU exato ou peça explicitamente todos os produtos da seleção.' };
      if (new Set(encontrados.valor.map(p => p.id)).size !== encontrados.valor.length
          || encontrados.valor.some(p => !/^\d{1,15}$/u.test(p.blingId))) return indisponivel;
      let deposito: PropostaEdicao['deposito'] = null;
      if (pedido.campo === 'estoque') {
        const dep = await portas.deposito();
        if (dep._tag !== 'ok') return indisponivel;
        if (!dep.valor) return { mensagem: 'O ajuste exige um único depósito cadastrado, ativo e considerado no saldo do Bling. Use a gestão de estoque para escolher o depósito.' };
        deposito = dep.valor;
      }
      const itens: ItemEdicao[] = [];
      const limiteDaPrevia = portas.agora() + 230_000;
      for (const produto of encontrados.valor) {
        if (portas.agora() >= limiteDaPrevia) return indisponivel;
        const remoto = await portas.ler(produto.blingId, pedido.campo);
        if (remoto._tag !== 'ok') return indisponivel;
        const base = { produtoId: produto.id, blingId: produto.blingId, nome: remoto.valor.nome, codigo: produto.codigo };
        if (pedido.campo === 'estoque') {
          if (remoto.valor.estoque === null) return indisponivel;
          itens.push({ ...base, campo: 'estoque', anterior: remoto.valor.estoque, valor: pedido.valor });
        } else if (pedido.campo === 'nome') {
          itens.push({ ...base, campo: 'nome', anterior: remoto.valor.nome, valor: pedido.valor });
        } else {
          itens.push({ ...base, campo: 'descricao', anterior: remoto.valor.descricao, valor: pedido.valor });
        }
      }
      const salva = await portas.guardar(scope, { itens, deposito });
      if (salva._tag !== 'ok') return indisponivel;
      return { mensagem: 'Confira os produtos e os valores. O Bling só será alterado após sua confirmação.', proposta: salva.valor };
    }

    async confirmar(scope: VerifiedOrganizationScope, chave: string): Promise<RespostaEdicao> {
      const portas = this.portas;
      if (!escopoTemCapacidade(scope, 'organization:manage')) return negada;
      const claim = await portas.reivindicar(scope, chave);
      if (claim._tag !== 'ok') return { mensagem: 'Não foi possível conferir a confirmação. Tente novamente com a mesma proposta.' };
      const comando = claim.valor;
      if (comando.estado === 'negada') return { mensagem: 'Proposta ausente, expirada ou de outro usuário. Prepare uma nova prévia.' };
      if (comando.estado !== 'executar') return {
        mensagem: comando.estado === 'concluida' ? 'Resultado da confirmação já registrada.'
          : 'Esta confirmação já foi iniciada. Não será reenviada. Confira os resultados registrados e o Bling antes de criar outra proposta.',
        resultados: comando.resultados,
        emAndamento: comando.estado === 'ocupada',
      };
      const resultados: ResultadoEdicao[] = [];
      const fim = portas.agora() + 230_000;
      const depositoAtual = comando.proposta.deposito ? await portas.deposito() : null;
      const depositoConfere = !comando.proposta.deposito || (depositoAtual?._tag === 'ok'
        && depositoAtual.valor?.id === comando.proposta.deposito.id);
      for (const item of comando.proposta.itens) {
        let estado: ResultadoEdicao['estado'] = 'nao_enviado';
        if (portas.agora() < fim && depositoConfere) {
          const atual = await portas.ler(item.blingId, item.campo);
          const anterior = atual._tag === 'ok' ? atual.valor[item.campo] : null;
          if (atual._tag !== 'ok') estado = 'nao_enviado';
          else if (anterior !== item.anterior) estado = 'alterado_apos_previa';
          else if (anterior === item.valor) estado = 'aplicado';
          else {
            const escrita = await portas.alterar(item, comando.proposta.deposito);
            estado = escrita._tag === 'EscritaAceita' ? 'aplicado'
              : escrita._tag === 'RemotoIndeterminado' ? 'indeterminado' : 'recusado';
          }
        }
        const resultado = { produtoId: item.produtoId, nome: item.nome, estado };
        const registro = await portas.registrar(scope, chave, resultado);
        if (registro._tag !== 'ok') return {
          mensagem: 'O resultado do último item precisa de conferência no Bling. A confirmação não será reenviada automaticamente.',
          resultados,
          emAndamento: true,
        };
        resultados.push(resultado);
      }
      const fimRegistrado = await portas.concluir(scope, chave);
      return { mensagem: fimRegistrado._tag === 'ok'
        ? 'Processamento concluído. Confira o resultado de cada produto.'
        : 'Resultados registrados; o encerramento ainda precisa ser conferido. Não repita a operação com uma nova proposta.',
        resultados, emAndamento: fimRegistrado._tag !== 'ok' };
    }
}

/** Coordena prévia e execução sem permitir que o modelo confirme a própria proposta. */
export function criarEdicaoDeProdutos(portas: PortasDeEdicao) {
  return new EdicaoDeProdutos(portas);
}
