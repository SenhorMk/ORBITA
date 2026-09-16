import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

/**
 * Status desta rota a partir do status que o Bling deu.
 *
 * `502` para tudo seria largo demais: um alerta que classifica 5xx como
 * indisponibilidade do provedor acusaria o Bling fora do ar em casos onde ele
 * respondeu 200 a tudo — módulo de vendas não identificado, situações em
 * formato inesperado. Nesses, o problema é da conta ou nosso.
 *
 * - o Bling recusou de verdade (status `>= 400`) → **502**, é gateway mesmo;
 * - qualquer outra falha da leitura → **500**, o problema é deste lado.
 */
function statusDaFalha(statusDoBling: number): number {
  return statusDoBling >= 400 ? 502 : 500;
}

export async function GET(request: Request) {
  try {
    // O escopo de organização resolve identidade e vínculo, e distingue 401
    // (sem sessão), 403 (sem vínculo) e 503 (indisponível).
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const blingClient = bling.forVerifiedOrganization(scope);

    // Ids de módulo são por conta: o módulo de pedidos de venda é descoberto
    // pelo nome, e as situações são lidas dele.
    const situacoes = await blingClient.obterSituacoesDePedidoDeVenda();

    if (situacoes._tag === 'BlingFailed') {
      // A mensagem é **nossa**, montada a partir do status — o corpo do Bling
      // não sai daqui, nem é lido. Repassar texto do provedor abriria um
      // vazamento de conteúdo de terceiro na resposta pública.
      //
      // O contrato da rota é preservado: lista no sucesso, `{ error }` na falha.
      return NextResponse.json(
        { error: situacoes.failure.message },
        { status: statusDaFalha(situacoes.failure.status) },
      );
    }

    return NextResponse.json(situacoes.value);
  } catch (error: unknown) {
    // A mensagem do erro não vai ao cliente (CWE-209), e o erro cru também não
    // vai para `console.error`: num erro do Postgres, `message`, `details` e
    // `hint` carregam valor de linha, e só `registrarFalhaInterna` aplica a
    // redação.
    registrarFalhaInterna('bling.situacoes.listar', error);
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
