const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');
const idx = content.indexOf('window.addEventListener("load"');
if (idx >= 0) {
  console.log(content.substring(idx, idx + 500));
}