const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');
const patterns = [
  'app.get("/api/notificacoes"',
  'app.post("/api/notificacoes',
  'app.put("/api/notificacoes',
  'app.delete("/api/notificacoes',
  'marcarNotificacaoLida',
  'listarNotificacoes',
  'contarNotificacoesNaoLidas'
];
for (const pattern of patterns) {
  const idx = content.indexOf(pattern);
  if (idx >= 0) {
    console.log('Found:', pattern, 'at:', idx);
  } else {
    console.log('NOT FOUND:', pattern);
  }
}