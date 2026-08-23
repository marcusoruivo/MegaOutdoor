const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');
const idx = content.indexOf('<section class="secao ativa" id="secao-album">');
if (idx >= 0) {
  console.log(content.substring(idx, idx + 300));
}