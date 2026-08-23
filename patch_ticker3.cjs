const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/index.html', 'utf8');

// Find the exact function by markers
const startMarker = 'function renderizarUltimasCompras(){';
const endMarker = 'function alternarPausaTicker(){';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx >= 0 && endIdx > startIdx) {
    // Build the new function as a string
    const newFunction = 'function renderizarUltimasCompras(){\n' +
        '    const shell = document.getElementById("ultimasComprasShell");\n' +
        '    const ticker = document.getElementById("ultimasComprasTicker");\n' +
        '    if(!shell || !ticker) return;\n' +
        '    shell.style.display = ultimasComprasState.length ? "block" : "none";\n' +
        '    if(!ultimasComprasState.length){\n' +
        '        if(comprasTickerTimer) clearInterval(comprasTickerTimer);\n' +
        '        return;\n' +
        '    }\n' +
        '    const itemHtml = ultimasComprasState.map(compra => {\n' +
        '        const descricao = String(compra.descricao || `${compra.quantidade || 0} espaços`).replace(/^comprou\\s*/, "");\n' +
        '        const textoCurto = descricao.length > 50 ? descricao.substring(0, 47) + \'...\' : descricao;\n' +
        '        return \'<span class="compra-item" title="\' + escHtml(descricao) + \'">\' +\n' +
        '            \'<span class="compra-avatar">\' + (compra.apelido ? escHtml(compra.apelido.charAt(0).toUpperCase()) : \'?\') + \'</span>\' +\n' +
        '            \'<div class="compra-info">\' +\n' +
        '                \'<span class="compra-texto">\' + escHtml(compra.apelido || "Alguém") + \' comprou <b>\' + escHtml(textoCurto) + \'</b></span>\' +\n' +
        '                \'<span class="compra-tempo">\' + formatarTempoAtras(Math.floor((Date.now() - (compra.criadoEm ? new Date(compra.criadoEm).getTime() : Date.now())) / 1000)) + \'</span>\' +\n' +
        '            \'</div>\' +\n' +
        '            \'<span class="compra-valor">\' + formatarReais(compra.valorCents) + \'</span>\' +\n' +
        '        \'</span>\';\n' +
        '    }).join("");\n' +
        '    const vezes = Math.max(3, Math.ceil(10 / Math.max(1, ultimasComprasState.length)));\n' +
        '    ticker.innerHTML = itemHtml.repeat(vezes);\n' +
        '    if(comprasTickerTimer) clearInterval(comprasTickerTimer);\n' +
        '    comprasTickerTimer = setInterval(carregarUltimasCompras, 5000);\n' +
        '}';
    
    const newContent = content.substring(0, startIdx) + newFunction + '\n' + content.substring(endIdx);
    fs.writeFileSync('C:/MegaOutdoor/public/index.html', newContent, 'utf8');
    console.log('OK - replaced');
} else {
    console.log('NOT FOUND - startIdx:', startIdx, 'endIdx:', endIdx);
}