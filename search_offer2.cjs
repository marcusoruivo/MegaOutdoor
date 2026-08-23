const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/colecionaveis.js', 'utf8');

let idx = content.indexOf('router.post("/offers/:id/accept"');
console.log(content.substring(idx, idx + 1000));