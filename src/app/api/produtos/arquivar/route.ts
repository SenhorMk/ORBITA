import { NextResponse } from 'next/server';

import { autorizarCorrecaoOperacional } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { MENSAGEM_PUBLICA_DE_FALHA, registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { produtoRepository } from '@/repositories/produtoRepository';
import { bling } from '@/services/bling';

import { createArquivamentoDeProdutoHandler } from './handler';

const arquivarProduto = createArquivamentoDeProdutoHandler({
  autorizar: autorizarCorrecaoOperacional,
  carregar: (scope, id) => produtoRepository.carregarParaArquivamento(scope, id),
  bling: (scope) => bling.forVerifiedOrganization(scope),
  arquivarLocal: (scope, id) => produtoRepository.arquivar(scope, id),
  correlationId: getCorrelationId,
});

export async function POST(request: Request) {
  try {
    return await arquivarProduto(request);
  } catch (err: unknown) {
    // Falha antes de qualquer efeito remoto (a carga do produto, por exemplo).
    registrarFalhaInterna('produtos.arquivamento', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
