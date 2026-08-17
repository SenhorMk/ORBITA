const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/services/sync.ts');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/async syncAll\(userId\?: string\)/g, 'async syncAll(userId: string)');
content = content.replace(/supabaseServer\.rpc\('try_advisory_lock_sync'\)/g, "supabaseServer.rpc('try_advisory_lock_sync', { p_user_id: userId })");
content = content.replace(/supabaseServer\.rpc\('unlock_sync'\)/g, "supabaseServer.rpc('unlock_sync', { p_user_id: userId })");

content = content.replace(/const payload = \{\n\s*bling_id: String\(cat\.id\),\n\s*descricao: cat\.descricao,\n\s*categoria_pai_id: cat\.categoriaPai\?\.id \? String\(cat\.categoriaPai\.id\) : null,\n\s*\};/g, 
  "const payload = {\n              bling_id: String(cat.id),\n              user_id: userId,\n              descricao: cat.descricao,\n              categoria_pai_id: cat.categoriaPai?.id ? String(cat.categoriaPai.id) : null,\n            };");
content = content.replace(/\{ onConflict: 'bling_id' \}/g, "{ onConflict: 'user_id, bling_id' }");

// Replace all .upsert({ entidade: '...'}) with user_id: userId
content = content.replace(/\.upsert\(\{\s*entidade:\s*('[^']+')/g, ".upsert({ user_id: userId, entidade: $1");
// The onConflict for sync_state should be 'user_id, entidade' instead of 'entidade'
content = content.replace(/\{ onConflict: 'entidade' \}/g, "{ onConflict: 'user_id, entidade' }");

// Also add .eq('user_id', userId) to .from('sync_state').select...
content = content.replace(/\.eq\('entidade',\s*('[^']+')\)\.maybeSingle\(\)/g, ".eq('entidade', $1).eq('user_id', userId).maybeSingle()");

// Repository calls
content = content.replace(/clienteRepository\.upsert\(([^)]+)\)/g, "clienteRepository.upsert(userId, $1)");
content = content.replace(/produtoRepository\.upsert\(([^)]+)\)/g, "produtoRepository.upsert(userId, $1)");
content = content.replace(/pedidoRepository\.upsert\(([^)]+)\)/g, "pedidoRepository.upsert(userId, $1)");
content = content.replace(/pedidoRepository\.addItems\(([^)]+)\)/g, "pedidoRepository.addItems(userId, $1)");
content = content.replace(/pedidoRepository\.upsertNfe\(([^)]+)\)/g, "pedidoRepository.upsertNfe(userId, $1)");
content = content.replace(/pedidoRepository\.getByBlingId\(([^)]+)\)/g, "pedidoRepository.getByBlingId(userId, $1)");

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
