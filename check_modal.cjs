const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');

const patterns = ['id="modalOverlay"', 'id="modalBody"', 'class="modal"', 'class="hidden"'];
for (const pattern of patterns) {
  const idx = content.indexOf(pattern);
  if (idx >= 0) {
    console.log('Found:', pattern, 'at:', idx);
    console.log(content.substring(Math.max(0, idx-50), idx + 100));
    console.log('---');
  } else {
    console.log('NOT FOUND:', pattern);
  }
}