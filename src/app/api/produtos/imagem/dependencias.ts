import { NextResponse } from 'next/server';

import { auditarCorrecao, autorizarCorrecaoOperacional } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { MENSAGEM_PUBLICA_DE_FALHA, registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { supabaseServer } from '@/lib/supabaseServer';
import { VALIDADE_DA_IMPORTACAO_NO_BLING_S } from '@/lib/config/produtoImagemContract';
import { ProdutoImagemRepository } from '@/repositories/produtoImagemRepository';
import { SupabaseArmazenamentoDeImagem } from '@/services/armazenamentoDeImagem';
import { bling } from '@/services/bling';
import {
  estadoAposSincronizacao,
  sincronizarFotoComBling,
  type SincronizacaoDaFotoDeps,
} from '@/services/sincronizacaoDaFotoComBling';

import type { FotoDoProdutoDependencies } from './handler';

/**
 * A ligação de produção das rotas de foto.
 *
 * `autorizarCorrecaoOperacional` é a mesma porta das correções do catálogo:
 * escopo pelo vínculo persistido e capacidade `organization:manage`.
 */
const store = new ProdutoImagemRepository(supabaseServer);
const armazenamento = new SupabaseArmazenamentoDeImagem(supabaseServer);

/**
 * A convergência com o Bling. O orçamento cabe na função da rota
 * (`maxDuration = 60`): as duas esperas pelo processamento assíncrono do Bling
 * somam no máximo 40 s, lendo a cada 2 s.
 */
const sincronizacao: SincronizacaoDaFotoDeps = {
  carregar: (scope, id) => store.carregar(scope, id),
  adquirirLease: (scope, id, token) => store.adquirirLease(scope, id, token),
  liberarLease: (scope, id, token) => store.liberarLease(scope, id, token),
  confirmar: (scope, id, desejado, token) => store.confirmarSincronizacao(scope, id, desejado, token),
  novoToken: () => crypto.randomUUID(),
  bling: (scope) => bling.forVerifiedOrganization(scope),
  assinarImportacao: async (caminho) => {
    const assinadas = await armazenamento.assinarLeituras([caminho], VALIDADE_DA_IMPORTACAO_NO_BLING_S);
    if (assinadas._tag === 'Assinadas') return assinadas.urls.get(caminho) ?? null;
    registrarFalhaInterna('produtos.imagem.bling.assinar_importacao', assinadas.causa);
    return null;
  },
  auditar: auditarCorrecao,
  esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  agora: () => Date.now(),
  orcamentoMs: 40_000,
  intervaloMs: 2_000,
};

export const dependenciasDaFoto: FotoDoProdutoDependencies = {
  autorizar: autorizarCorrecaoOperacional,
  store,
  armazenamento,
  auditar: auditarCorrecao,
  correlationId: getCorrelationId,
  novoId: () => crypto.randomUUID(),
  sincronizarBling: async (scope, produtoId, correlationId) =>
    estadoAposSincronizacao(await sincronizarFotoComBling(scope, produtoId, correlationId, sincronizacao)),
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
