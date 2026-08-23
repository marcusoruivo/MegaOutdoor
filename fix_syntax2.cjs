const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');

// The bug: }).replace(/"/g, """);  should be: }).replace(/"/g, """);
const bad = '}).replace(/"/g, """);';
const good = '}).replace(/"/g, """);';

if (content.includes(bad)) {
  content = content.replace(bad, good);
  fs.writeFileSync('C:/MegaOutdoor/public/colecionaveis.html', content, 'utf8');
  console.log('Fixed!');
} else {
  console.log('Bad pattern not found');
  console.log('Searching for similar patterns...');
  // Try to find similar patterns
  const idx = content.indexOf('"""');
  if (idx >= 0) {
    console.log('Found """ at:', idx, 'context:', content.substring(idx - 20, idx + 30));
  }
}