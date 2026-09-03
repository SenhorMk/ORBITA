import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { resolveVerifiedOrganizationScope } from '@/lib/requestOrganizationContext';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';

/**
 * Status desta rota a partir do status que o Bling deu.
 *
 * `502` para tudo era largo demais: alerta que classifica 5xx como
 * indisponibilidade do provedor acusaria o Bling fora do ar em casos onde ele
 * respondeu 200 a tudo — módulo de vendas não identificado, situações em
 * formato inesperado. Nesses, o problema é da conta ou nosso, e o `502` mandava
 * quem fosse diagnosticar começar no lugar errado.
 *
 * - o Bling recusou de verdade (status `>= 400`) → **502**, é gateway mesmo;
 * - qualquer outra falha da leitura → **500**, o problema é deste lado.
 */
function statusDaFalha(statusDoBling: number): number {
  return statusDoBling >= 400 ? 502 : 500;
}

export async function GET(request: Request) {
  try {
    // Ticket 22 — o portão de sessão legado saiu daqui. Ele lia o papel de
    // `app_metadata`, que só os usuários históricos têm, e era redundante: o
    // escopo de organização abaixo já resolve identidade e vínculo, e já
    // distingue 401 (sem sessão), 403 (sem vínculo) e 503 (indisponível).
    const scopeResult = await resolveVerifiedOrganizationScope(request);
    if (scopeResult._tag !== 'RequestScopeResolved') return scopeResult.response;
    const scope = scopeResult.scope;

    const blingClient = bling.forVerifiedOrganization(scope);

    // Ticket 31 — antes era `getSituacoesModulo(9)`, que lia a lista de
    // módulos e procurava situações dentro dela. Devolvia `[]` sempre, e o
    // botão de cancelar pedido da listagem concluía que a conta não tinha a
    // situação "Cancelado". O `9` também era inventado: ids de módulo são por
    // conta, e o módulo agora é descoberto pelo nome.
    const situacoes = await blingClient.obterSituacoesDePedidoDeVenda();

    if (situacoes._tag === 'BlingFailed') {
      // A mensagem é **nossa**, montada a partir do status — o corpo do Bling
      // não sai daqui, nem é lido. O comentário anterior dizia que a razão
      // "vem do Bling", e ficou falso quando a redação entrou: quem lesse
      // concluiria que já se repassa detalhe do provedor e poderia repassar
      // mais, reabrindo o vazamento que este ticket fechou.
      //
      // O contrato da rota é preservado: lista no sucesso, `{ error }` na falha.
      return NextResponse.json(
        { error: situacoes.failure.message },
        { status: statusDaFalha(situacoes.failure.status) },
      );
    }

    return NextResponse.json(situacoes.value);
  } catch (error: unknown) {
    // Ticket 22, critério 13 — este `catch` era inerte atrás do 401 legado, e
    // devolvia a mensagem do erro ao cliente (CWE-209).
    //
    // O `console.error` que estava aqui **contornava a política inteira**: ele
    // imprimia o erro cru, com `message`, `details` e `hint` dentro. Num erro do
    // Postgres esses campos carregam valor de linha, e a redação de
    // `registrarFalhaInterna` não alcança o que não passa por ela.
    registrarFalhaInterna('bling.situacoes.listar', error);
    return NextResponse.json({ error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
