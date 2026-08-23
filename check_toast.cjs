const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');
const idx = content.indexOf('id="toastWrap"');
if (idx >= 0) {
  console.log('Found at:', idx);
  console.log(content.substring(Math.max(0, idx-50), idx + 100));
} else {
  console.log('toastWrap NOT FOUND');
}