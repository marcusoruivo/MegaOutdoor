const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');

// The bug: three literal double quotes """ should be the HTML entity "
const bad = '"""';  // three literal double quotes
const good = '"';  // HTML entity for double quote

if (content.includes(bad)) {
  content = content.split(bad).join(good);
  fs.writeFileSync('C:/MegaOutdoor/public/colecionaveis.html', content, 'utf8');
  console.log('Fixed!');
} else {
  console.log('Pattern not found');
}