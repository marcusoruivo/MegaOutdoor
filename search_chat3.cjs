const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');

let idx = content.indexOf('"/api/chat-negociacao');
while (idx >= 0) {
  console.log('Found at', idx, ':', content.substring(idx, idx + 300));
  idx = content.indexOf('"/api/chat-negociacao', idx + 10);
}