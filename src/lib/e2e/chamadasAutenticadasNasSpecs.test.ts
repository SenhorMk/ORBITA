/**
 * Ticket 24 — a suíte tem **um** caminho autenticado, e ele deve ser o único.
 *
 * Duas chamadas de `e2e/specs/organization.spec.ts` iam direto a
 * `memberPage.request.get('/api/organizacoes')`, sem passar por
 * `cabecalhosAutenticados`. A autenticação deste aplicativo é por **bearer**:
 * `readBearerToken` lê o token exclusivamente do header `Authorization` e não
 * olha cookie nenhum. `page.request` compartilha os cookies da página, e
 * cookie aqui não vale nada — então a rota respondia **401**, que é a resposta
 * certa para uma requisição sem credencial.
 *
 * A spec quebrava antes da revogação que ela existe para testar, e a asserção
 * pós-revogação lia o corpo de um 401 e concluía que a organização tinha sumido
 * da lista. Ela passaria por um motivo que não é o que mede.
 *
 * Esta guarda existe para o erro não voltar: quem escrever uma chamada crua
 * numa spec encontra este teste vermelho, com o arquivo e a linha.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIRETORIO_DAS_SPECS = path.resolve(__dirname, '../../../e2e/specs');

/** Uma chamada de rede numa spec, com o arquivo e a linha onde ela está. */
interface ChamadaDeRede {
  readonly arquivo: string;
  readonly linha: number;
  readonly texto: string;
}

/**
 * Chamadas que não levam credencial, nas specs.
 *
 * A regra é de **linha**, e é conservadora de propósito: qualquer
 * `<algo>.request.<método>(` numa spec precisa nomear `cabecalhosAutenticados`
 * na mesma linha, ou ser uma chamada de página de objeto — que é onde o header
 * é montado.
 *
 * Specs não falam com a rede por conta própria. Quando falam, é por esquecimento
 * — e o esquecimento responde 401 e passa despercebido, porque 401 é uma
 * resposta plausível.
 */
export function chamadasSemCredencial(conteudo: string, arquivo: string): ChamadaDeRede[] {
  return conteudo
    .split('\n')
    .map((texto, i) => ({ arquivo, linha: i + 1, texto }))
    .filter(({ texto }) => /\.request\.(get|post|put|patch|delete|fetch|head)\s*\(/u.test(texto))
    .filter(({ texto }) => !texto.includes('cabecalhosAutenticados'));
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

describe('as specs só falam com a API pelo caminho autenticado', () => {
  it('nenhuma spec faz chamada de rede sem credencial', () => {
    const encontradas = specs().flatMap(({ arquivo, conteudo }) => chamadasSemCredencial(conteudo, arquivo));

    // A mensagem carrega arquivo e linha: quem quebrar isto sabe onde mexer,
    // sem precisar procurar.
    expect(
      encontradas.map(({ arquivo, linha, texto }) => `${arquivo}:${linha} → ${texto.trim()}`),
    ).toEqual([]);
  });

  // A guarda precisa ser exercitada contra uma linha que viola — uma regra que
  // nunca disparou não é prova de que dispararia.
  it('acusa uma chamada crua, com arquivo e linha', () => {
    const conteudo = [
      'const antes = await memberPage.request.get(\'/api/organizacoes\');',
      'expect(antes.ok()).toBe(true);',
    ].join('\n');

    const encontradas = chamadasSemCredencial(conteudo, 'e2e/specs/exemplo.spec.ts');

    expect(encontradas).toHaveLength(1);
    expect(encontradas[0]!.linha).toBe(1);
  });

  it('não acusa a chamada que leva o cabeçalho autenticado', () => {
    const linha = "await page.request.get('/api/organizacoes', { headers: await cabecalhosAutenticados(page) });";

    expect(chamadasSemCredencial(linha, 'e2e/specs/exemplo.spec.ts')).toEqual([]);
  });

  it('não acusa uma linha que não fala com a rede', () => {
    const linha = 'const orgApi = new OrganizationApi(memberPage);';

    expect(chamadasSemCredencial(linha, 'e2e/specs/exemplo.spec.ts')).toEqual([]);
  });
});
