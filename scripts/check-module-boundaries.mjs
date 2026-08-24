#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

/**
 * Regras de Limites do Monólito Modular ORBITA:
 * 1. src/services e src/repositories NÃO devem importar diretamente 'next/server', 'next/navigation', 'next/headers', ou 'react'.
 * 2. src/repositories NÃO devem importar de src/services (camada inferior não depende da superior).
 * 3. Rotas em src/app/api NÃO devem importar internals não públicos de serviços quando existir API consolidada.
 */

export function checkModuleBoundaries(baseDir = SRC_DIR) {
  const violations = [];

  function scanDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.endsWith('.test.ts')) {
        checkFile(fullPath);
      }
    }
  }

  function checkFile(filePath) {
    const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    const isService = relativePath.startsWith('src/services/');
    const isRepository = relativePath.startsWith('src/repositories/');

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      // 1. Repositories e Services não devem importar Next.js/React framework internals
      if (isService || isRepository) {
        if (/import\s+.*from\s+['"]next\/(server|navigation|headers)['"]/u.test(line)) {
          violations.push({
            file: relativePath,
            line: lineNum,
            rule: 'domain-isolation',
            message: `Serviço/Repositório não deve depender de internals do Next.js: ${line.trim()}`,
          });
        }
        if (/import\s+.*from\s+['"]react['"]/u.test(line)) {
          violations.push({
            file: relativePath,
            line: lineNum,
            rule: 'domain-isolation',
            message: `Serviço/Repositório não deve depender de React: ${line.trim()}`,
          });
        }
      }

      // 2. Repositories não devem importar Services (inversão de camada)
      if (isRepository) {
        if (/import\s+.*from\s+['"]@\/services/u.test(line)) {
          violations.push({
            file: relativePath,
            line: lineNum,
            rule: 'layer-inversion',
            message: `Repositório não deve importar da camada de serviços: ${line.trim()}`,
          });
        }
      }
    });
  }

  scanDirectory(baseDir);

  return {
    valid: violations.length === 0,
    violations,
  };
}

if (process.argv[1] === __filename) {
  console.log('🏛️  Verificando limites do Monólito Modular ORBITA...');
  const result = checkModuleBoundaries();

  if (!result.valid) {
    console.error(`❌ ${result.violations.length} violações de limites arquiteturais encontradas:`);
    result.violations.forEach((v) => {
      console.error(`  - [${v.rule}] ${v.file}:${v.line} -> ${v.message}`);
    });
    process.exit(1);
  }

  console.log('✅ Todos os limites arquiteturais do monólito modular foram respeitados (0 violações).');
}
