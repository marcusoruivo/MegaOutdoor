const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');

// The bug: three literal double quotes """ should be "
const bad = '"""';  // three double quotes
const good = '"""';  // " surrounded by quotes for the replace

if (content.includes(bad)) {
  content = content.replace(bad, good);
  fs.writeFileSync('C:/MegaOutdoor/public/colecionaveis.html', content, 'utf8');
  console.log('Fixed!');
} else {
  console.log('Pattern not found');
}