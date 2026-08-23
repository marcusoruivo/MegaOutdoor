const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html', 'utf8');
const patch = fs.readFileSync('C:/MegaOutdoor/public/colecionaveis.html.patched', 'utf8');

const startMarker = 'function listingHtml(l){';
const endMarker = 'function verInteressados(listingId){';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx >= 0 && endIdx > startIdx) {
    const newContent = content.substring(0, startIdx) + patch + '\n' + content.substring(endIdx);
    fs.writeFileSync('C:/MegaOutdoor/public/colecionaveis.html', newContent, 'utf8');
    console.log('OK - replaced from', startIdx, 'to', endIdx);
} else {
    console.log('NOT FOUND - startIdx:', startIdx, 'endIdx:', endIdx);
}