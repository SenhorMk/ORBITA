import { NextResponse } from 'next/server';
import type { z } from 'zod';

import {
  STATUS_HTTP_DA_IMAGEM,
  VALIDADE_DA_LEITURA_ASSINADA_S,
  caminhoDaImagem,
  caminhoPertenceAoProduto,
  confirmacaoDeUploadSchema,
  pedidoDeUploadSchema,
  problemaDoArquivo,
  remocaoDeImagemSchema,
  tipoDeImagemPermitido,
  tipoDoCaminho,
  type RespostaDeImagem,
} from '@/lib/config/produtoImagemContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ProdutoComFoto } from '@/repositories/produtoImagemRepository';
import type { ArmazenamentoDeImagemPort } from '@/services/armazenamentoDeImagem';

/**
 * As três rotas da foto do produto.
 *
 * ## Quem decide o quê
 *
 * O navegador manda o `produtoId` e, conforme a etapa, o tipo e o tamanho
 * declarados, o caminho que recebeu e o caminho que viu como atual. **Nada
 * disso é autoridade:** a organização vem do escopo verificado; o produto é
 * relido por `id` + organização; o caminho é gerado aqui e todo caminho que
 * volta é conferido contra o prefixo `<organização>/<produto>/`; a precondição
 * só vale se for o valor do banco.
 *
 * ## Ordem da troca
 *
 * 1. upload da nova imagem (navegador → Storage, com token deste servidor);
 * 2. confirmação: o objeto existe, com tipo e tamanho permitidos;
 * 3. compare-and-set do caminho no banco;
 * 4. só então a foto anterior é removida do Storage. Falha nessa limpeza não
 *    desfaz o novo estado — vai para o log e para a auditoria.
 *
 * Quem perde a corrida do compare-and-set recebe `Conflito` e o objeto que
 * acabou de enviar é removido, porque ninguém o referencia.
 */

export type EventoDaFoto =
  | {
      readonly acao: 'catalog.product_image_uploaded';
      readonly recurso: 'produto';
      readonly recursoId: string;
      readonly correlationId: string;
      readonly metadata: {
        readonly produto_id: string;
        readonly substituiu_anterior: boolean;
        readonly limpeza_anterior: DesfechoDaLimpeza;
      };
    }
  | {
      readonly acao: 'catalog.product_image_removed';
      readonly recurso: 'produto';
      readonly recursoId: string;
      readonly correlationId: string;
      readonly metadata: { readonly produto_id: string; readonly limpeza_anterior: DesfechoDaLimpeza };
    };

export type DesfechoDaLimpeza = 'concluida' | 'falhou' | 'nao_aplicavel';

export interface FotoDoProdutoStorePort {
  carregar(scope: VerifiedOrganizationScope, produtoId: string): Promise<ProdutoComFoto | null>;
  trocarCaminho(
    scope: VerifiedOrganizationScope,
    produtoId: string,
    anterior: string | null,
    novo: string | null,
  ): Promise<boolean>;
}

export interface FotoDoProdutoDependencies {
  readonly autorizar: (request: Request) => Promise<
    | { readonly _tag: 'Autorizado'; readonly scope: VerifiedOrganizationScope }
    | { readonly _tag: 'Negado'; readonly response: NextResponse }
  >;
  readonly store: FotoDoProdutoStorePort;
  readonly armazenamento: ArmazenamentoDeImagemPort;
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDaFoto) => Promise<void>;
  readonly correlationId: (request: Request) => string;
  /** Id do objeto novo. `crypto.randomUUID` em produção. */
  readonly novoId: () => string;
}

function responder(corpo: RespostaDeImagem): NextResponse {
  return NextResponse.json(corpo, { status: STATUS_HTTP_DA_IMAGEM[corpo.resultado] });
}

type Preparo<T> =
  | { readonly _tag: 'Pronto'; readonly scope: VerifiedOrganizationScope; readonly corpo: T; readonly produto: ProdutoComFoto }
  | { readonly _tag: 'Encerrado'; readonly response: NextResponse };

/** Autoriza, lê o corpo pelo schema e relê o produto dentro da organização. */
async function preparar<S extends z.ZodType<{ produtoId: string }>>(
  deps: FotoDoProdutoDependencies,
  request: Request,
  schema: S,
): Promise<Preparo<z.infer<S>>> {
  const autorizacao = await deps.autorizar(request);
  if (autorizacao._tag === 'Negado') return { _tag: 'Encerrado', response: autorizacao.response };
  const { scope } = autorizacao;

  let bruto: unknown;
  try {
    bruto = await request.json();
  } catch {
    return { _tag: 'Encerrado', response: responder({ resultado: 'RequisicaoInvalida' }) };
  }
  const lido = schema.safeParse(bruto);
  if (!lido.success) return { _tag: 'Encerrado', response: responder({ resultado: 'RequisicaoInvalida' }) };

  const produto = await deps.store.carregar(scope, lido.data.produtoId);
  if (!produto) return { _tag: 'Encerrado', response: responder({ resultado: 'ProdutoNaoEncontrado' }) };

  return { _tag: 'Pronto', scope, corpo: lido.data, produto };
}

/** Remove objetos que ninguém referencia. Nunca decide o resultado da requisição. */
async function limpar(
  deps: FotoDoProdutoDependencies,
  scope: VerifiedOrganizationScope,
  caminho: string,
  operacao: string,
): Promise<Exclude<DesfechoDaLimpeza, 'nao_aplicavel'>> {
  const remocao = await deps.armazenamento.remover([caminho]);
  if (remocao._tag === 'Removido') return 'concluida';
  registrarFalhaInterna(operacao, remocao.causa, { organizacaoId: scope.organizationId, atorId: scope.actorId });
  return 'falhou';
}

/** Auditoria sem mudar a resposta: o efeito já está confirmado no banco. */
async function auditarSemInterromper(
  deps: FotoDoProdutoDependencies,
  scope: VerifiedOrganizationScope,
  evento: EventoDaFoto,
): Promise<void> {
  try {
    await deps.auditar(scope, evento);
  } catch (erro: unknown) {
    registrarFalhaInterna(`produtos.imagem.auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId });
  }
}

async function urlDeLeitura(deps: FotoDoProdutoDependencies, caminho: string): Promise<string | null> {
  const assinadas = await deps.armazenamento.assinarLeituras([caminho], VALIDADE_DA_LEITURA_ASSINADA_S);
  return assinadas._tag === 'Assinadas' ? assinadas.urls.get(caminho) ?? null : null;
}

/** `POST /api/produtos/imagem/upload` — etapa A. */
export function createAutorizarUploadHandler(deps: FotoDoProdutoDependencies) {
  return async function autorizarUpload(request: Request): Promise<NextResponse> {
    const preparo = await preparar(deps, request, pedidoDeUploadSchema);
    if (preparo._tag === 'Encerrado') return preparo.response;
    const { scope, corpo, produto } = preparo;

    const problema = problemaDoArquivo(corpo.tipo, corpo.tamanho);
    if (problema !== null || !tipoDeImagemPermitido(corpo.tipo)) {
      return responder({ resultado: problema ?? 'TipoNaoPermitido' });
    }

    // Organização do escopo, id relido do banco, uuid e extensão daqui. O
    // navegador não participa da escolha do caminho.
    const caminho = caminhoDaImagem(scope.organizationId, produto.id, deps.novoId(), corpo.tipo);
    const autorizacao = await deps.armazenamento.autorizarUpload(caminho);
    if (autorizacao._tag === 'Indisponivel') {
      registrarFalhaInterna('produtos.imagem.autorizar_upload', autorizacao.causa, { organizacaoId: scope.organizationId });
      return responder({ resultado: 'ArmazenamentoIndisponivel' });
    }
    return responder({ resultado: 'UploadAutorizado', caminho, token: autorizacao.token });
  };
}

/**
 * O objeto enviado é o que foi autorizado? Existe, e com tipo e tamanho
 * permitidos. Um objeto fora da regra é removido: ninguém o referencia ainda.
 */
async function conferirObjeto(
  deps: FotoDoProdutoDependencies,
  scope: VerifiedOrganizationScope,
  caminho: string,
): Promise<RespostaDeImagem | null> {
  const objeto = await deps.armazenamento.inspecionar(caminho);
  if (objeto._tag === 'Ausente') return { resultado: 'UploadAusente' };
  if (objeto._tag === 'Indisponivel') {
    registrarFalhaInterna('produtos.imagem.inspecionar', objeto.causa, { organizacaoId: scope.organizationId });
    return { resultado: 'ArmazenamentoIndisponivel' };
  }

  const tipoEsperado = tipoDoCaminho(caminho);
  const problema = objeto.tipo !== tipoEsperado
    ? 'TipoNaoPermitido'
    : problemaDoArquivo(objeto.tipo ?? '', objeto.tamanho ?? Number.POSITIVE_INFINITY);
  if (problema === null) return null;

  await limpar(deps, scope, caminho, 'produtos.imagem.limpeza_objeto_recusado');
  return { resultado: problema };
}

/** `POST /api/produtos/imagem/confirmar` — etapa C. */
export function createConfirmarUploadHandler(deps: FotoDoProdutoDependencies) {
  return async function confirmarUpload(request: Request): Promise<NextResponse> {
    const preparo = await preparar(deps, request, confirmacaoDeUploadSchema);
    if (preparo._tag === 'Encerrado') return preparo.response;
    const { scope, corpo, produto } = preparo;
    const { caminho, anterior } = corpo;

    const dentroDoProduto = (valor: string) => caminhoPertenceAoProduto(valor, scope.organizationId, produto.id);
    // `anterior` igual ao novo faria a limpeza pós-troca apagar a foto recém-gravada.
    if (!dentroDoProduto(caminho) || (anterior !== null && (!dentroDoProduto(anterior) || anterior === caminho))) {
      return responder({ resultado: 'CaminhoInvalido' });
    }

    // Repetição de uma confirmação que já valeu (queda de rede, duplo envio):
    // nada a trocar, e nada a apagar — o objeto É a foto atual.
    if (produto.imagemStoragePath === caminho) {
      return responder({ resultado: 'ImagemConfirmada', caminho, url: await urlDeLeitura(deps, caminho) });
    }

    const recusa = await conferirObjeto(deps, scope, caminho);
    if (recusa !== null) return responder(recusa);

    const trocou = await deps.store.trocarCaminho(scope, produto.id, anterior, caminho);
    if (!trocou) {
      const atual = await deps.store.carregar(scope, produto.id);
      if (atual?.imagemStoragePath === caminho) {
        return responder({ resultado: 'ImagemConfirmada', caminho, url: await urlDeLeitura(deps, caminho) });
      }
      // Perdeu a corrida: o banco guarda outra foto. O objeto desta tentativa
      // não é referenciado por ninguém e sai; a foto vencedora fica intacta.
      await limpar(deps, scope, caminho, 'produtos.imagem.limpeza_perdedor_da_corrida');
      return responder({ resultado: 'Conflito' });
    }

    const limpeza = anterior === null
      ? 'nao_aplicavel'
      : await limpar(deps, scope, anterior, 'produtos.imagem.limpeza_foto_substituida');

    await auditarSemInterromper(deps, scope, {
      acao: 'catalog.product_image_uploaded',
      recurso: 'produto',
      recursoId: produto.id,
      correlationId: deps.correlationId(request),
      metadata: { produto_id: produto.id, substituiu_anterior: anterior !== null, limpeza_anterior: limpeza },
    });
    return responder({ resultado: 'ImagemConfirmada', caminho, url: await urlDeLeitura(deps, caminho) });
  };
}

/** `POST /api/produtos/imagem/remover` — tira a foto do ORBITA; a do Bling volta a valer. */
export function createRemoverImagemHandler(deps: FotoDoProdutoDependencies) {
  return async function removerImagem(request: Request): Promise<NextResponse> {
    const preparo = await preparar(deps, request, remocaoDeImagemSchema);
    if (preparo._tag === 'Encerrado') return preparo.response;
    const { scope, corpo, produto } = preparo;

    if (!caminhoPertenceAoProduto(corpo.anterior, scope.organizationId, produto.id)) {
      return responder({ resultado: 'CaminhoInvalido' });
    }

    const trocou = await deps.store.trocarCaminho(scope, produto.id, corpo.anterior, null);
    if (!trocou) {
      const atual = await deps.store.carregar(scope, produto.id);
      // Já sem foto: outra requisição removeu antes. O estado pedido é o atual.
      if (atual && atual.imagemStoragePath === null) {
        return responder({ resultado: 'ImagemRemovida', url: atual.imagemDoBling });
      }
      return responder({ resultado: 'Conflito' });
    }

    // O banco já não referencia o objeto: agora, e só agora, ele pode sair.
    const limpeza = await limpar(deps, scope, corpo.anterior, 'produtos.imagem.limpeza_foto_removida');
    await auditarSemInterromper(deps, scope, {
      acao: 'catalog.product_image_removed',
      recurso: 'produto',
      recursoId: produto.id,
      correlationId: deps.correlationId(request),
      metadata: { produto_id: produto.id, limpeza_anterior: limpeza },
    });
    return responder({ resultado: 'ImagemRemovida', url: produto.imagemDoBling });
  };
}
