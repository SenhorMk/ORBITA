import { describe, expect, it } from 'vitest';

import { estadoDoBling, estadoDoChatwoot, type ConexaoObservada } from './estadoDaIntegracao';

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

  it('declara conectado apenas com verificação real bem-sucedida', () => {
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      health_status: 'healthy',
      last_health_check_at: '2026-09-10T12:00:00Z',
    }));
    expect(estado.nome).toBe('conectado');
  });

  it('mostra o erro real da última verificação', () => {
    const estado = estadoDoBling(conexao({
      credenciais_configuradas: true,
      status: 'conectado',
      health_status: 'error',
      last_health_check_at: '2026-09-10T12:00:00Z',
      last_health_error: 'token expirado',
    }));
    expect(estado.nome).toBe('erro');
    expect(estado.detalhe).toBe('token expirado');
  });
});

describe('estado do Chatwoot', () => {
  it('sem linha, não está configurado', () => {
    expect(estadoDoChatwoot(undefined).nome).toBe('nao-configurado');
  });

  it('credenciais salvas sem verificação aparecem como não verificado, não como conectado', () => {
    expect(estadoDoChatwoot(conexao({ status: 'conectado', health_status: 'healthy' })).nome).toBe('nao-verificado');
  });

  it('só uma verificação real produz conectado', () => {
    const estado = estadoDoChatwoot(conexao({ health_status: 'healthy', last_health_check_at: '2026-09-10T12:00:00Z' }));
    expect(estado.nome).toBe('conectado');
  });
});
