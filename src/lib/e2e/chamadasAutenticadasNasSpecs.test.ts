/**
 * Ticket 24 — a suíte tem **um** caminho autenticado, e ele deve ser o único.
 *
 * Duas chamadas de `e2e/specs/organization.spec.ts` iam direto a
 * `memberPage.request.get('/api/organizacoes')`, sem passar por
 * `cabecalhosAutenticados`. A autenticação deste aplicativo é por **bearer**:
 * `readBearerToken` lê o token exclusivamente do header `Authorization` e não
 * olha cookie nenhum. `page.request` compartilha os cookies da página, e cookie
 * aqui não vale nada — então a rota respondia **401**, que é a resposta certa
 * para uma requisição sem credencial.
 *
 * A spec quebrava antes da revogação que ela existe para testar, e a asserção
 * pós-revogação lia o corpo de um 401 e concluía que a organização tinha sumido
 * da lista. Ela passaria por um motivo que não é o que mede.
 *
 * **A regra é sobre o lugar, não sobre o cabeçalho.** Uma primeira versão desta
 * guarda perdoava a chamada crua quando `cabecalhosAutenticados` aparecia na
 * mesma linha — e isso contradizia o critério que ela existe para sustentar: se
 * montar cabeçalho na spec é aceitável, então há dois caminhos autenticados, e
 * o próximo esquecimento volta a passar. Os cabeçalhos se montam nos page
 * objects, que ficam **fora** de `e2e/specs/`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIRETORIO_DAS_SPECS = path.resolve(__dirname, '../../../e2e/specs');

/** Uma chamada de rede numa spec, com o arquivo e a linha onde ela começa. */
interface ChamadaDeRede {
  readonly arquivo: string;
  readonly linha: number;
  readonly trecho: string;
}

/**
 * Chamada feita pelo contexto de requisição de uma página, dentro de uma spec.
 *
 * A expressão casa `<algo>.request.<método>(` **atravessando quebras de linha**:
 * sem isso, quebrar a chamada em duas linhas contornaria a guarda sem ninguém
 * perceber — e o formatador faz isso sozinho quando a linha cresce.
 *
 * O ponto antes de `request` é essencial e é o que separa dois casos:
 *
 * - `page.request.get(…)` / `memberPage.request.post(…)` — o contexto de uma
 *   página, que carrega cookie e **não** carrega o bearer. É o que se proíbe;
 * - `request.post(…)` — a *fixture* `request` do Playwright, um identificador
 *   solto. Ela não tem sessão nenhuma para carregar, e é o caminho certo para
 *   rota **pública**: `identity.spec.ts` a usa para `/api/auth/register`, que
 *   é aberta de propósito. Proibi-la seria proibir o teste de uma rota pública.
 */
const CHAMADA_PELO_CONTEXTO_DA_PAGINA = /\.\s*request\s*\.\s*(?:get|post|put|patch|delete|fetch|head)\s*\(/gu;

/** Chamadas de rede que uma spec faz por conta própria, em vez de por page object. */
export function chamadasCruas(conteudo: string, arquivo: string): ChamadaDeRede[] {
  const encontradas: ChamadaDeRede[] = [];
  for (const achado of conteudo.matchAll(CHAMADA_PELO_CONTEXTO_DA_PAGINA)) {
    const antes = conteudo.slice(0, achado.index);
    encontradas.push({
      arquivo,
      linha: antes.split('\n').length,
      // O trecho é a linha onde a chamada começa, para a mensagem ser
      // acionável. O espaço em branco é colapsado porque a chamada pode estar
      // quebrada em várias linhas, e a mensagem precisa caber numa.
      trecho: (antes.slice(antes.lastIndexOf('\n') + 1) + achado[0]).replace(/\s+/gu, ' ').trim(),
    });
  }
  return encontradas;
}

function specs(): { arquivo: string; conteudo: string }[] {
  return fs
    .readdirSync(DIRETORIO_DAS_SPECS)
    .filter((nome) => nome.endsWith('.spec.ts'))
    .map((nome) => ({
      arquivo: `e2e/specs/${nome}`,
      conteudo: fs.readFileSync(path.join(DIRETORIO_DAS_SPECS, nome), 'utf8'),
    }));
}

describe('as specs só falam com a API pelos page objects', () => {
  it('nenhuma spec chama uma rota pelo contexto de requisição de uma página', () => {
    const encontradas = specs().flatMap(({ arquivo, conteudo }) => chamadasCruas(conteudo, arquivo));

    // A mensagem carrega arquivo e linha: quem quebrar isto sabe onde mexer,
    // sem precisar procurar.
    expect(
      encontradas.map(({ arquivo, linha, trecho }) => `${arquivo}:${linha} → ${trecho}`),
    ).toEqual([]);
  });

  // A guarda precisa ser exercitada contra linhas que violam — uma regra que
  // nunca disparou não é prova de que dispararia.
  it('acusa a chamada crua, com arquivo e linha', () => {
    const conteudo = [
      '',
      "const antes = await memberPage.request.get('/api/organizacoes');",
    ].join('\n');

    const encontradas = chamadasCruas(conteudo, 'e2e/specs/exemplo.spec.ts');

    expect(encontradas).toHaveLength(1);
    expect(encontradas[0]!.linha).toBe(2);
  });

  // O ajuste que a revisão do PR #67 cobrou: montar o cabeçalho na spec **não**
  // absolve. Se absolvesse, existiriam dois caminhos autenticados, e o critério
  // do ticket 24 é que exista um só.
  it('acusa também a chamada que monta o cabeçalho na própria spec', () => {
    const linha = "await page.request.get('/api/organizacoes', { headers: await cabecalhosAutenticados(page) });";

    expect(chamadasCruas(linha, 'e2e/specs/exemplo.spec.ts')).toHaveLength(1);
  });

  // Formatação não pode contornar a regra: o formatador quebra a linha sozinho
  // quando ela cresce.
  it('acusa a chamada quebrada em várias linhas', () => {
    const conteudo = ['await memberPage', '  .request', '  .get(', "    '/api/organizacoes',", '  );'].join('\n');

    const encontradas = chamadasCruas(conteudo, 'e2e/specs/exemplo.spec.ts');

    expect(encontradas).toHaveLength(1);
    // A linha apontada é a do `.request`, e não a do começo da expressão: é
    // onde está o que precisa mudar.
    expect(encontradas[0]!.linha).toBe(2);
  });

  // A fixture `request` do Playwright não tem sessão para carregar, e é o
  // caminho certo para rota pública. `identity.spec.ts` a usa em
  // `/api/auth/register`, e essa chamada não pode ser afetada.
  it('não acusa a fixture `request` usada em rota pública', () => {
    const conteudo = ["const response = await request.post('/api/auth/register', {", '  data: { email },', '});'].join('\n');

    expect(chamadasCruas(conteudo, 'e2e/specs/identity.spec.ts')).toEqual([]);
  });

  it('não acusa a chamada feita por um page object', () => {
    const linha = 'const antes = await memberOrgApi.listOrganizations();';

    expect(chamadasCruas(linha, 'e2e/specs/exemplo.spec.ts')).toEqual([]);
  });
});
