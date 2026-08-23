const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');

let idx = content.indexOf('chat-negociacao');
while (idx >= 0) {
  console.log('Found at', idx, ':', content.substring(idx, idx + 200));
  idx = content.indexOf('chat-negociacao', idx + 10);
}