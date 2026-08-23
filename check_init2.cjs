const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');
const idx = content.indexOf('window.addEventListener("load"');
console.log(content.substring(idx, idx + 1000));