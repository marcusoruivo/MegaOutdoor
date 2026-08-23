const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/colecionaveis.js', 'utf8');

const routes = [
    'router.post("/offers"',
    'router.post("/offers/:id/accept"',
    'router.post("/offers/:id/decline"',
    'router.post("/offers/:id/cancel"',
    'router.post("/offers/:id/counter"',
    'router.post("/listings"',
    'router.post("/trades"',
    'router.post("/auctions"',
];

for (const route of routes) {
    const idx = content.indexOf(route);
    if (idx >= 0) {
        const lineNum = content.substring(0, idx).split('\n').length;
        console.log('Route:', route, 'at line', lineNum);
    }
}