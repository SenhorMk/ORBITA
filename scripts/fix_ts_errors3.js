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
    [/clienteRepository\.getByBlingId\(([^,)]+)\)/g, "clienteRepository.getByBlingId(userId as string, $1)"],
    [/produtoRepository\.getByBlingId\(([^,)]+)\)/g, "produtoRepository.getByBlingId(userId as string, $1)"]
]);

// 2. nfe route
replaceAllInFile('src/app/api/nfe/route.ts', [
    [/pedidoRepository\.upsertNfe\(\{/g, "pedidoRepository.upsertNfe(session!.user.id, {"],
    [/pedidoRepository\.upsert\(\{/g, "pedidoRepository.upsert(session!.user.id, {"]
]);

console.log('All replacements done!');
