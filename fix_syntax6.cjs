const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');

// The bug: single literal double quote " should be the HTML entity "
const bad = '");';  // single double quote followed by );
const good = '"  );';  // HTML entity for double quote

// Need to find the specific pattern: .replace(/"/g, ");
const pattern = '.replace(/"/g, ");';
const replacement = '.replace(/"/g, "");';

if (content.includes(pattern)) {
  content = content.split(pattern).join(replacement);
  fs.writeFileSync('C:/MegaOutdoor/public/colecionaveis.html', content, 'utf8');
  console.log('Fixed!');
} else {
  console.log('Pattern not found');
  // Search for similar
  const idx = content.indexOf('.replace(/"/g, ");');
  console.log('Search result:', idx);
}