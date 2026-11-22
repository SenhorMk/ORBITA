import { defineConfig } from 'vite';
import path from 'node:path';
const repo = path.resolve(import.meta.dirname, '../..');
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [
    { find: /.*fetchWithAuth$/, replacement: path.join(import.meta.dirname, 'ports.js') },
    { find: /.*supabaseClient$/, replacement: path.join(import.meta.dirname, 'ports.js') },
    { find: 'next/image', replacement: path.join(import.meta.dirname, 'ports.js') },
    { find: '@', replacement: path.join(repo, 'src') },
  ] },
  define: { 'process.env': '{}' }, css: { postcss: repo },
  server: { host: '127.0.0.1', port: 3318, strictPort: true, fs: { allow: [repo] } },
  oxc: { jsx: { runtime: 'automatic' } },
});
