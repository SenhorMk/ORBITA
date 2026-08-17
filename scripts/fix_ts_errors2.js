const fs = require('fs');
const path = require('path');

function replaceAllInFile(relativePath, replacements) {
    const filePath = path.join(__dirname, '..', relativePath);
    let content = fs.readFileSync(filePath, 'utf8');
    for (let [search, replace] of replacements) {
        if (typeof search === 'string') {
            content = content.split(search).join(replace);
        } else {
            content = content.replace(search, replace);
        }
    }
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${relativePath}`);
}

// 1. Webhook
replaceAllInFile('src/app/api/bling/webhook/route.ts', [
    [/produtoRepository\.upsert\([^,)]+\)/g, "produtoRepository.upsert(userId as string, produto)"],
    [/pedidoRepository\.upsert\([^,)]+\)/g, "pedidoRepository.upsert(userId as string, pedido)"],
    [/pedidoRepository\.upsertNfe\([^,)]+\)/g, "pedidoRepository.upsertNfe(userId as string, nfe)"]
]);

// 2. nfe route
replaceAllInFile('src/app/api/nfe/route.ts', [
    [/pedidoRepository\.upsertNfe\([^,)]+\)/g, "pedidoRepository.upsertNfe(session.user.id, nfeData)"],
    [/pedidoRepository\.getByBlingId\([^,)]+\)/g, "pedidoRepository.getByBlingId(session.user.id, String(pedidoId))"]
]);

// 3. Null checks for session in other routes
replaceAllInFile('src/app/api/clientes/update/route.ts', [
    ["session.user.id", "session!.user.id"]
]);
replaceAllInFile('src/app/api/produtos/delete/route.ts', [
    ["session.user.id", "session!.user.id"]
]);
replaceAllInFile('src/app/api/produtos/update/route.ts', [
    ["session.user.id", "session!.user.id"]
]);
replaceAllInFile('src/app/api/nfe/route.ts', [
    ["session.user.id", "session!.user.id"]
]);
