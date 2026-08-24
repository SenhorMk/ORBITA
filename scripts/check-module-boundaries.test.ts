import { describe, it, expect } from 'vitest';
import { checkModuleBoundaries } from './check-module-boundaries.mjs';

describe('checkModuleBoundaries script', () => {
  it('valida a estrutura atual do codebase sem violar limites de domínio ou inversão de camada', () => {
    const result = checkModuleBoundaries();
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
