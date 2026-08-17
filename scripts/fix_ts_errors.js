const fs = require('fs');
const path = require('path');

function replaceInFile(relativePath, regex, replacement) {
    const filePath = path.join(__dirname, '..', relativePath);
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(regex, replacement);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${relativePath}`);
}

// 1. sync.ts
replaceInFile('src/services/sync.ts', /clienteRepository\.getByBlingId\(([^,)]+)\)/g, "clienteRepository.getByBlingId(userId, $1)");
replaceInFile('src/services/sync.ts', /produtoRepository\.getByBlingId\(([^,)]+)\)/g, "produtoRepository.getByBlingId(userId, $1)");
replaceInFile('src/services/sync.ts', /userId\?: string/, "userId: string"); // ensure it's not optional

// 2. webhook
let webhookRegexStr = [
    [/clienteRepository\.upsert\(([^,)]+)\)/g, "clienteRepository.upsert(userId as string, $1)"],
    [/produtoRepository\.upsert\(([^,)]+)\)/g, "produtoRepository.upsert(userId as string, $1)"],
    [/pedidoRepository\.getByBlingId\(([^,)]+)\)/g, "pedidoRepository.getByBlingId(userId as string, $1)"],
    [/pedidoRepository\.upsert\(([^,)]+)\)/g, "pedidoRepository.upsert(userId as string, $1)"],
    [/pedidoRepository\.addItems\(([^,)]+)\)/g, "pedidoRepository.addItems(userId as string, $1)"],
    [/pedidoRepository\.upsertNfe\(([^,)]+)\)/g, "pedidoRepository.upsertNfe(userId as string, $1)"]
];
for (let [regex, replacement] of webhookRegexStr) {
    replaceInFile('src/app/api/bling/webhook/route.ts', regex, replacement);
}

// 3. clientes/update
replaceInFile('src/app/api/clientes/update/route.ts', /clienteRepository\.upsert\(([^,)]+)\)/g, "clienteRepository.upsert(session.user.id, $1)");

// 4. nfe
replaceInFile('src/app/api/nfe/route.ts', /pedidoRepository\.upsertNfe\(([^,)]+)\)/g, "pedidoRepository.upsertNfe(session.user.id, $1)");
replaceInFile('src/app/api/nfe/route.ts', /pedidoRepository\.getByBlingId\(([^,)]+)\)/g, "pedidoRepository.getByBlingId(session.user.id, $1)");
replaceInFile('src/app/api/nfe/route.ts', /pedidoRepository\.getById\(([^,)]+)\)/g, "pedidoRepository.getById(session.user.id, $1)");

// 5. produtos/delete
replaceInFile('src/app/api/produtos/delete/route.ts', /produtoRepository\.delete\(([^,)]+)\)/g, "produtoRepository.delete(session.user.id, $1)");

// 6. produtos/update
replaceInFile('src/app/api/produtos/update/route.ts', /produtoRepository\.upsert\(([^,)]+)\)/g, "produtoRepository.upsert(session.user.id, $1)");

console.log('All replacements done!');
