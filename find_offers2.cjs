const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/colecionaveis.js', 'utf8');
const idx = content.indexOf('router.post("/offers"');
console.log(content.substring(idx, idx + 3000));