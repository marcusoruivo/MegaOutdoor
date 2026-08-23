const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/colecionaveis.js', 'utf8');
const idx = content.indexOf('router.post("/trades"');
if (idx >= 0) {
  console.log(content.substring(idx, idx + 2000));
}