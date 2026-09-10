import { describe, expect, it } from 'vitest';

import { estadoDoBling, estadoDoChatwoot, instanteDaVerificacao, type ConexaoObservada } from './estadoDaIntegracao';

function conexao(overrides: Partial<ConexaoObservada> = {}): ConexaoObservada {
  return {
    status: 'pendente',
    health_status: 'healthy',
    last_health_check_at: null,
    last_health_error: null,
    credenciais_configuradas: false,
    ...overrides,
  };
}

describe('estado do Bling', () => {
  it('não trata a ausência de linha como configuração', () => {
    expect(estadoDoBling(undefined).nome).toBe('nao-configurado');
  });

  it('não trata a linha existente sem client_id gravado como configuração', () => {
    expect(estadoDoBling(conexao({ credenciais_configuradas: false })).nome).toBe('nao-configurado');
  });

  it('salvar credenciais é "configurado", nunca "conectado"', () => {
    const estado = estadoDoBling(conexao({ credenciais_configuradas: true, status: 'pendente' }));
    expect(estado.nome).toBe('configurado');
  });

  it('não usa o default healthy=true da coluna como prova de saúde', () => {
    // A linha diz `conectado` e `healthy`, mas nunca foi verificada: o
    // `healthy` aqui é apenas o default da migração 31.
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      health_status: 'healthy',
      last_health_check_at: null,
    }));
    expect(estado.nome).toBe('nao-verificado');
    expect(estado.rotulo).not.toMatch(/conectado/i);
  });

  it('uma verificação bem-sucedida vira evidência datada, nunca "Conectado"', () => {
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      health_status: 'healthy',
      last_health_check_at: '2026-09-10T12:00:00Z',
    }));
    expect(estado.nome).toBe('verificado');
    expect(estado.rotulo).toBe('Verificado');
    expect(estado.detalhe).toContain('Última verificação OK em 10/09/2026 12:00 UTC');
  });

  it('uma verificação ANTIGA não é apresentada como saúde atual', () => {
    // Um ano atrás. Sem cadência de verificação no produto, isto é a última
    // notícia — e a tela não pode transformá-la em "está conectado agora".
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      health_status: 'healthy',
      last_health_check_at: '2025-01-04T08:30:00Z',
    }));
    expect(estado.nome).toBe('verificado');
    expect(estado.rotulo).not.toMatch(/conectado/i);
    // A data velha aparece, para quem olha julgar sozinho o quanto ela vale.
    expect(estado.detalhe).toContain('04/01/2025 08:30 UTC');
    expect(estado.detalhe).toMatch(/não é o estado de agora|não há verificação contínua/i);
  });

  it('o instante é o mesmo em qualquer fuso, porque é evidência', () => {
    // `toLocaleString` mudaria entre o navegador do lojista e o do suporte.
    expect(instanteDaVerificacao('2026-09-10T12:00:00Z')).toBe('10/09/2026 12:00 UTC');
    expect(instanteDaVerificacao('2026-09-10T12:00:00+03:00')).toBe('10/09/2026 09:00 UTC');
    expect(instanteDaVerificacao('nao-e-data')).toBeNull();
  });

  it('a autorização recém-concluída aparece como não verificada, dizendo que o OAuth passou', () => {
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      last_health_check_at: null,
    }));
    expect(estado.nome).toBe('nao-verificado');
    expect(estado.detalhe).toMatch(/autorização concluída/i);
  });

  it('mostra o erro real da última verificação, datado como o histórico que é', () => {
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      health_status: 'error',
      last_health_check_at: '2026-09-10T12:00:00Z',
      last_health_error: 'token expirado',
    }));
    expect(estado.nome).toBe('erro');
    expect(estado.detalhe).toContain('token expirado');
    expect(estado.detalhe).toContain('10/09/2026 12:00 UTC');
  });
});

describe('estado do Chatwoot', () => {
  it('sem linha, não está configurado', () => {
    expect(estadoDoChatwoot(undefined).nome).toBe('nao-configurado');
  });

  it('credenciais salvas sem verificação aparecem como não verificado, não como conectado', () => {
    expect(estadoDoChatwoot(conexao({ status: 'conectado', health_status: 'healthy' })).nome).toBe('nao-verificado');
  });

  it('só uma verificação real produz evidência, e ela vem datada', () => {
    const estado = estadoDoChatwoot(conexao({ health_status: 'healthy', last_health_check_at: '2026-09-10T12:00:00Z' }));
    expect(estado.nome).toBe('verificado');
    expect(estado.detalhe).toContain('10/09/2026 12:00 UTC');
  });

  it('verificação antiga do Chatwoot também não vira saúde atual', () => {
    const estado = estadoDoChatwoot(conexao({ health_status: 'healthy', last_health_check_at: '2024-03-02T23:05:00Z' }));
    expect(estado.rotulo).not.toMatch(/conectado/i);
    expect(estado.detalhe).toContain('02/03/2024 23:05 UTC');
  });
});
