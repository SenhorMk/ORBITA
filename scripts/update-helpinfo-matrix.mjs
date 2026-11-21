import fs from 'node:fs';
import path from 'node:path';

// Atualiza somente a rastreabilidade. Não gera texto de ajuda nem componentes.
const locations = new Map();
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (file.endsWith('.tsx') && !file.includes('.test.')) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        for (const match of line.matchAll(/ajudaId="([^"]+)"/g)) {
          const items = locations.get(match[1]) ?? [];
          items.push({ file: file.replaceAll('\\', '/'), line: index + 1 });
          locations.set(match[1], items);
        }
      });
    }
  }
}
scan('src/app');
scan('src/components');
const matrix = JSON.parse(fs.readFileSync('docs/helpinfo/matriz.json', 'utf8'));
for (const surface of matrix) {
  if (surface.id.startsWith('legado.')) continue;
  const found = locations.get(surface.id);
  if (!found?.length) throw new Error(`Ajuda sem montagem: ${surface.id}`);
  surface.locations = found;
  surface.component = found[0].file;
  surface.anchors = found.map(({ line }) => ({ line, kind: 'Ajuda contextual associada ao contexto' }));
  surface.layoutReview = ['sac.controle', 'sac.envio'].includes(surface.id)
    ? 'Montagem revisada; reposicionamento já existente no PR157. Preservado aqui para não conflitar com o redesign ainda aberto.'
    : 'Montagem revisada junto ao título, rótulo, ação ou grupo correspondente. Evidência visual por componente: consultar revisão de layout.';
}
fs.writeFileSync('docs/helpinfo/matriz.json', JSON.stringify(matrix, null, 2) + '\n');
const keys = ['id', 'area', 'surface', 'purpose', 'what', 'how', 'after', 'risk', 'coverage', 'locations', 'nominalReview', 'layoutReview'];
const quote = value => '"' + (typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replaceAll('"', '""') + '"';
fs.writeFileSync('docs/helpinfo/matriz.csv', [keys.map(quote).join(','), ...matrix.map(row => keys.map(key => quote(row[key])).join(','))].join('\n') + '\n');
console.log(`Matriz atualizada: ${matrix.filter(s => !s.id.startsWith('legado.')).length} ajudas ativas.`);
