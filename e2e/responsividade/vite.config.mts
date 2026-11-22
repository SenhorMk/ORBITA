import { defineConfig } from 'vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const repo = path.resolve(import.meta.dirname, '../..');
export default defineConfig({
  root: import.meta.dirname, publicDir: path.join(repo, 'public'),
  plugins: [{ name: 'icone-do-shell', configureServer(server) {
    server.middlewares.use('/icon.svg', (_req, res) => {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(readFileSync(path.join(repo, 'src/app/icon.svg')));
    });
  } }],
  resolve: { alias: [
    { find: /.*fetchWithAuth$/, replacement: path.join(import.meta.dirname, 'ports.js') },
    { find: /.*supabaseClient$/, replacement: path.join(repo, 'e2e/helpinfo/ports.js') },
    { find: 'next/image', replacement: path.join(repo, 'e2e/helpinfo/ports.js') },
    { find: '@', replacement: path.join(repo, 'src') },
  ] },
  define: { 'process.env': '{}' }, css: { postcss: repo },
  server: { host: '127.0.0.1', port: 3319, strictPort: true, fs: { allow: [repo] } },
  oxc: { jsx: { runtime: 'automatic' } },
});
