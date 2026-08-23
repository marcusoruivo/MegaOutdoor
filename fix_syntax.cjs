const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');
const bad = '}).replace(/"/g, """);';
const good = '}).replace(/"/g, """);';
if (content.includes(bad)) {
  content = content.replace(bad, good);
  fs.writeFileSync('C:/MegaOutdoor/public/colecionaveis.html', content, 'utf8');
  console.log('Fixed!');
} else {
  console.log('Bad pattern not found');
}