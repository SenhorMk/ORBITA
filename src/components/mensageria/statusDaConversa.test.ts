import { describe, expect, it } from 'vitest';
import { estaResolvida, passaNoFiltro, proximoStatus, rotuloDoStatus } from './statusDaConversa';

describe('status da conversa no cockpit', () => {
  it('pending (conversa com a automação) não é resolvida', () => {
    expect(estaResolvida('pending')).toBe(false);
    expect(rotuloDoStatus('pending')).toBe('Pendente');
  });

  it('rótulos de open e resolved continuam os mesmos', () => {
    expect(rotuloDoStatus('open')).toBe('Aberta');
    expect(rotuloDoStatus('resolved')).toBe('Resolvida');
  });

  it('status desconhecido ou ausente não esconde a conversa nem a chama de resolvida', () => {
    expect(rotuloDoStatus(undefined)).toBe('Aberta');
    expect(passaNoFiltro('snoozed', 'open')).toBe(true);
  });

  it('"Abertos" inclui pending; "Resolvidos" só resolved; "Todos" tudo', () => {
    expect(passaNoFiltro('open', 'open')).toBe(true);
    expect(passaNoFiltro('pending', 'open')).toBe(true);
    expect(passaNoFiltro('resolved', 'open')).toBe(false);
    expect(passaNoFiltro('pending', 'resolved')).toBe(false);
    expect(passaNoFiltro('resolved', 'resolved')).toBe(true);
    expect(passaNoFiltro('pending', 'all')).toBe(true);
  });

  it('a ação do cabeçalho resolve open e pending, e reabre resolved', () => {
    expect(proximoStatus('open')).toBe('resolved');
    expect(proximoStatus('pending')).toBe('resolved');
    expect(proximoStatus('resolved')).toBe('open');
  });
});
