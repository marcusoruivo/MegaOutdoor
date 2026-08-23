const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');

// Check for notification API endpoints
const patterns = [
  '/api/colecionaveis/notificacoes',
  '/api/notificacoes',
  'notificacoes/read',
  'notificacoes/read-all',
  'carregarNotificacoes'
];

for (const pattern of patterns) {
  const idx = content.indexOf(pattern);
  if (idx >= 0) {
    console.log('Found pattern:', pattern, 'at:', idx);
    console.log(content.substring(Math.max(0, idx-50), idx + 300));
    console.log('---');
  }
}