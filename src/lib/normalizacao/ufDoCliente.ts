/**
 * A UF do contato, como o banco a aceita.
 *
 * ## O defeito
 *
 * `chk_cliente_uf` é `uf IS NULL OR length(uf) = 2` — e está certa. O que
 * chegava errado era o valor: o formulário de contato manda `''` quando ninguém
 * escolhe estado, o contrato aceita `''` explicitamente
 * (`.optional().or(z.literal(''))`), e o `''` atravessava handler e repositório
 * até o Postgres. Resultado reproduzido: **o contato era criado no Bling** e a
 * gravação local morria na constraint. Dois sistemas discordando sobre quem
 * existe, por causa de uma string vazia.
 *
 * Não se corrige afrouxando a constraint. "Sem estado" é `NULL`, não `''` — a
 * ausência de um dado e um dado de tamanho zero são coisas diferentes, e o
 * banco está pedindo exatamente essa distinção.
 *
 * ## Por que `null` explícito, e não `undefined`
 *
 * Num upsert do `supabase-js`, chave com `undefined` desaparece na
 * serialização: no insert a coluna nasce nula por padrão, mas no **update** ela
 * fica como estava. Ou seja, apagar a UF de um contato que já tinha uma não
 * apagaria nada — o campo voltaria na próxima leitura, e quem editou acharia
 * que o sistema ignorou a edição. Devolver `null` explícito é o que faz a
 * remoção acontecer.
 *
 * ## Onde isto é chamado
 *
 * Na fronteira de persistência (`ClienteRepository.upsert`), e não no
 * formulário. Três caminhos gravam contato — a tela, o webhook do Bling e a
 * sincronização —, e um deles normalizar não impede os outros dois de
 * reintroduzir o `''`. A validação de formato continua onde estava: UF com
 * tamanho diferente de 2 é recusada pelo contrato, antes de chegar aqui.
 */

/**
 * `null` para ausência; a sigla em maiúsculas para o que tem dois caracteres.
 *
 * Qualquer outra coisa — texto de outro tamanho, número, objeto — também vira
 * `null`: aqui é a fronteira do banco, e o que ela não reconhece não pode ser
 * gravado como se fosse uma UF. O formato já foi recusado antes, pelo contrato;
 * esta função é a rede embaixo, e uma rede não adivinha.
 */
export function normalizarUf(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim().toUpperCase();
  return limpo.length === 2 ? limpo : null;
}
