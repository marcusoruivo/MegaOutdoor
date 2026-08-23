const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');
const idx = content.indexOf('app.post("/api/notificacoes"');
if (idx >= 0) {
  console.log(content.substring(idx, idx + 500));
}