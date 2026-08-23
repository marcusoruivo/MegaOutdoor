const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/colecionaveis.js', 'utf8');

const routes = [
    { name: 'offers', line: 3512 },
    { name: 'offers/accept', line: 3586 },
    { name: 'offers/decline', line: 3667 },
    { name: 'offers/cancel', line: 3702 },
    { name: 'offers/counter', line: 3768 },
    { name: 'listings', line: 2992 },
    { name: 'trades', line: 3991 },
    { name: 'auctions', line: 2781 },
];

for (const route of routes) {
    // Get ~100 lines after the route definition
    const lines = content.split('\n');
    const start = route.line - 1;
    const end = Math.min(start + 80, lines.length);
    const snippet = lines.slice(start, end).join('\n');
    
    const hasElegivel = snippet.includes('verificarElegibilidade') || snippet.includes('usuarioElegivel') || snippet.includes('motivoBloqueio') || snippet.includes('usuarioPodeNegociar');
    console.log(route.name + ': ' + (hasElegivel ? 'HAS CHECK' : 'NO CHECK'));
}