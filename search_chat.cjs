const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');

let idx = content.indexOf('app.get("/api/chat');
if (idx >= 0) {
  console.log('GET chat:', content.substring(idx, idx + 300));
}

idx = content.indexOf('app.post("/api/chat');
if (idx >= 0) {
  console.log('POST chat:', content.substring(idx, idx + 300));
}