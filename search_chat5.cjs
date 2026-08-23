const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');

let idx = content.indexOf('"/api/chat');
while (idx >= 0) {
  console.log('Found at', idx, ':', content.substring(idx, idx + 200));
  console.log('---');
  idx = content.indexOf('"/api/chat', idx + 10);
}