const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/server.js', 'utf8');

let idx = content.indexOf('/api/chat/negotiation');
console.log(content.substring(idx, idx + 1500));