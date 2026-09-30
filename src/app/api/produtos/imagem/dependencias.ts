import { NextResponse } from 'next/server';

import { auditarCorrecao, autorizarCorrecaoOperacional } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { MENSAGEM_PUBLICA_DE_FALHA, registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { supabaseServer } from '@/lib/supabaseServer';
import { ProdutoImagemRepository } from '@/repositories/produtoImagemRepository';
import { SupabaseArmazenamentoDeImagem } from '@/services/armazenamentoDeImagem';

import type { FotoDoProdutoDependencies } from './handler';

/**
 * A ligação de produção das rotas de foto.
 *
 * `autorizarCorrecaoOperacional` é a mesma porta das correções do catálogo:
 * escopo pelo vínculo persistido e capacidade `organization:manage`.
 */
export const dependenciasDaFoto: FotoDoProdutoDependencies = {
  autorizar: autorizarCorrecaoOperacional,
  store: new ProdutoImagemRepository(supabaseServer),
  armazenamento: new SupabaseArmazenamentoDeImagem(supabaseServer),
  auditar: auditarCorrecao,
  correlationId: getCorrelationId,
  novoId: () => crypto.randomUUID(),
};

/** Falha fora do fluxo previsto (banco caiu na releitura, por exemplo): frase fixa, causa no log. */
export async function semVazarFalha(
  operacao: string,
  executar: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await executar();
  } catch (erro: unknown) {
    registrarFalhaInterna(operacao, erro);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
