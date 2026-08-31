import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { chaveSensivel, redactSensitiveData, redactSensitiveText } from './dadosSensiveis';
import { descreverErro } from './erroLegivel';

/**
 * Política de redação — os ramos que passavam em claro.
 *
 * Havia duas implementações divergentes: a do cofre de credenciais usava lista
 * exata de chaves, a de `observability/logger` usava expressão regular e cobria
 * bem mais. `descreverErro` chamava a fraca, e não redigia texto livre nenhum.
 *
 * Todos os valores abaixo são sintéticos. Nenhum deles saiu de log ou de
 * ambiente real — são a forma do segredo, não um segredo.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

describe('chaves sensíveis', () => {
  it.each([
    'cookie',
    'Cookie',
    'set-cookie',
    'Set-Cookie',
    'webhookSecret',
    'webhook_secret',
    'client_secret',
    'clientSecret',
    'accessToken',
    'access_token',
    'blingRefreshToken',
    'Authorization',
    'apiKey',
    'password',
    'senha',
    'dados_cifrados',
  ])('reconhece %s', (chave) => {
    expect(chaveSensivel(chave)).toBe(true);
  });

  it.each(['message', 'details', 'hint', 'status', 'organizacao_id', 'pedidoId'])(
    'não redige %s, que é diagnóstico',
    (chave) => {
      expect(chaveSensivel(chave)).toBe(false);
    },
  );

  it('o campo code é redigido como estrutura, e ainda assim o código SQL aparece', () => {
    // No padrão, `code` ancorado é o *authorization code* do OAuth, que não pode
    // vazar. Não é o mesmo `code` do PostgREST — e os dois convivem porque
    // `descreverErro` lê o código do erro pelo caminho de texto, que remove
    // segredo por forma, não por nome de campo.
    expect(chaveSensivel('code')).toBe(true);
    expect(redactSensitiveData({ code: 'oauth-code-sintetico' })).toEqual({ code: '[REDACTED]' });
    expect(descreverErro({ code: '42P10', message: 'violação de ON CONFLICT' })).toContain('42P10');
  });

  it('camelCase era o buraco da lista antiga', () => {
    // A lista exata tinha `webhook_secret`; a normalização removia o traço
    // baixo e produzia `webhooksecret`, que não estava na lista. `webhookSecret`
    // passava em claro.
    const redigido = redactSensitiveData({ webhookSecret: 'wh-sec-sintetico-123' });
    expect(JSON.stringify(redigido)).not.toContain('wh-sec-sintetico-123');
    expect(redigido).toEqual({ webhookSecret: '[REDACTED]' });
  });
});

describe('segredo embutido em texto livre', () => {
  it.each([
    ['Bearer solto', 'falhou com Bearer abcdefghijklmnop1234567890', 'abcdefghijklmnop1234567890'],
    ['header Authorization', 'Authorization: Bearer tok-sintetico-abcdefgh', 'tok-sintetico-abcdefgh'],
    ['Set-Cookie', 'Set-Cookie: sb-access-token=valor-sintetico; Path=/', 'valor-sintetico'],
    ['Cookie', 'Cookie: sessao=valor-sintetico', 'valor-sintetico'],
    ['par chave=valor', 'requisição com client_secret=segredo-sintetico falhou', 'segredo-sintetico'],
    ['webhookSecret inline', 'webhookSecret: wh-sintetico-999', 'wh-sintetico-999'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.assinatura-sintetica', 'assinatura-sintetica'],
  ])('redige %s', (_nome, texto, segredo) => {
    const redigido = redactSensitiveText(texto);
    expect(redigido).not.toContain(segredo);
    expect(redigido).toContain('[REDACTED]');
  });

  it('preserva o diagnóstico que não é segredo', () => {
    const sql = '[42P10] there is no unique or exclusion constraint matching the ON CONFLICT specification';
    expect(redactSensitiveText(sql)).toBe(sql);
  });

  it('não estraga mensagens que só parecem sensíveis', () => {
    // "token" aqui é vocabulário de parser, não credencial: sem dois-pontos nem
    // sinal de igual depois, nada é redigido.
    const msg = 'unexpected token in JSON at position 4';
    expect(redactSensitiveText(msg)).toBe(msg);
  });
});

describe('descreverErro não vaza pelos campos de texto', () => {
  it('redige segredo embutido em message, details e hint do PostgREST', () => {
    const erro = {
      code: '42501',
      message: 'permission denied — Authorization: Bearer tok-sintetico-abcdefgh',
      details: 'Set-Cookie: sb-refresh-token=valor-sintetico',
      hint: 'confira client_secret=segredo-sintetico',
    };

    const descrito = descreverErro(erro);

    expect(descrito).not.toContain('tok-sintetico-abcdefgh');
    expect(descrito).not.toContain('valor-sintetico');
    expect(descrito).not.toContain('segredo-sintetico');
    // E o que serve para diagnosticar continua lá.
    expect(descrito).toContain('42501');
    expect(descrito).toContain('permission denied');
  });

  it('redige segredo embutido na mensagem de um Error', () => {
    const erro = new Error('POST /oauth/token falhou — Cookie: sessao=valor-sintetico');

    const descrito = descreverErro(erro);

    expect(descrito).not.toContain('valor-sintetico');
    expect(descrito).toContain('/oauth/token');
  });

  it('redige no último recurso, chave e texto', () => {
    const erro = {
      status: 500,
      webhookSecret: 'wh-sintetico-999',
      contexto: { nota: 'Authorization: Bearer tok-sintetico-abcdefgh' },
    };

    const descrito = descreverErro(erro);

    expect(descrito).not.toContain('wh-sintetico-999');
    expect(descrito).not.toContain('tok-sintetico-abcdefgh');
    expect(descrito).toContain('[REDACTED]');
    expect(descrito).toContain('500');
  });

  it('o código SQL sobrevive à redação — é ele que diz onde está o defeito', () => {
    const descrito = descreverErro({
      code: '42P10',
      message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
    });

    expect(descrito).toContain('42P10');
    expect(descrito).toContain('ON CONFLICT');
  });
});

describe('a política é uma só', () => {
  it('nenhum outro módulo declara a própria lista de chaves sensíveis', () => {
    // Duas políticas para o mesmo risco foi o defeito original: quem chamasse a
    // do cofre ficava sem `cookie` e sem camelCase. Se alguém declarar outra,
    // esta guarda reprova antes de a divergência voltar.
    const declarantes = [
      'src/lib/observability/logger.ts',
      'src/lib/integrations/credentialsVault.ts',
    ].filter((arquivo) => {
      const fonte = readFileSync(path.join(RAIZ, arquivo), 'utf8');
      return /const\s+SENSITIVE_KEYS?\b|const\s+SENSITIVE_KEY_PATTERN\b|const\s+INLINE_SECRET_PATTERNS\b/u.test(fonte);
    });

    expect(declarantes, 'A política de redação vive só em src/lib/dadosSensiveis.ts.').toEqual([]);
  });
});

describe('os dois caminhos que contornavam a redação', () => {
  it('erro recebido como string crua é sanitizado', () => {
    // `descreverErro` devolvia a string intacta: quem lançasse texto em vez de
    // Error passava por fora de toda a política.
    const descrito = descreverErro(
      'falha no refresh — Authorization: Bearer tok-sintetico-abcdefgh',
    );

    expect(descrito).not.toContain('tok-sintetico-abcdefgh');
    expect(descrito).toContain('[REDACTED]');
    expect(descrito).toContain('falha no refresh');
  });

  it('code arbitrário não é impresso — só código com identificação técnica confiável', () => {
    // O `code` ia para dentro de `[...]` sem qualquer validação de forma. Um
    // authorization code do OAuth chega exatamente assim, num objeto lançado.
    const descrito = descreverErro({
      code: '4/0AX4XfWh-oauth-code-sintetico',
      message: 'troca de código falhou',
    });

    expect(descrito).not.toContain('4/0AX4XfWh-oauth-code-sintetico');
    expect(descrito).toContain('troca de código falhou');
  });

  it.each([
    ['SQLSTATE', '42P10'],
    ['SQLSTATE de privilégio', '42501'],
    ['PostgREST', 'PGRST201'],
    ['errno do Node', 'ECONNREFUSED'],
  ])('preserva código técnico reconhecível: %s', (_nome, codigo) => {
    expect(descreverErro({ code: codigo, message: 'mensagem qualquer' })).toContain(codigo);
  });

  it('Error com code arbitrário também não imprime o code', () => {
    const erro = new Error('falhou');
    (erro as Error & { code: string }).code = 'ya29.token-sintetico-abcdefgh';

    const descrito = descreverErro(erro);

    expect(descrito).not.toContain('ya29.token-sintetico-abcdefgh');
    expect(descrito).toContain('falhou');
  });
});
