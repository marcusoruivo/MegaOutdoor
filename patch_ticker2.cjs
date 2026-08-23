const fs = require('fs');
let content = fs.readFileSync('C:/MegaOutdoor/public/index.html', 'utf8');

const oldRender = `function renderizarUltimasCompras(){
    const shell = document.getElementById("ultimasComprasShell");
    const ticker = document.getElementById("ultimasComprasTicker");
    if(!shell || !ticker) return;
    shell.style.display = ultimasComprasState.length ? "block" : "none";
    if(!ultimasComprasState.length){
        if(comprasTickerTimer) clearInterval(comprasTickerTimer);
        return;
    }
    const itemHtml = ultimasComprasState.map(compra => {
        return '<span class="l-ticker-item">' +
            '<span class="l-ticker-dot"></span>' +
             escHtml(compra.apelido || "Alguém") + ' comprou ' + escHtml(String(compra.descricao || \`${compra.quantidade || 0} espaços\`).replace(/^comprou\\s*/, "")) +
              ' · <span class="l-ticker-value">' + formatarReais(compra.valorCents) + '</span>' +
        '</span>';
    }).join("");
    const vezes = Math.max(3, Math.ceil(10 / Math.max(1, ultimasComprasState.length)));
    ticker.innerHTML = itemHtml.repeat(vezes);
    if(comprasTickerTimer) clearInterval(comprasTickerTimer);
    comprasTickerTimer = setInterval(carregarUltimasCompras, 5000);
}`;

const newRender = `function renderizarUltimasCompras(){
    const shell = document.getElementById("ultimasComprasShell");
    const ticker = document.getElementById("ultimasComprasTicker");
    if(!shell || !ticker) return;
    shell.style.display = ultimasComprasState.length ? "block" : "none";
    if(!ultimasComprasState.length){
        if(comprasTickerTimer) clearInterval(comprasTickerTimer);
        return;
    }
    const itemHtml = ultimasComprasState.map(compra => {
        const descricao = String(compra.descricao || \`${compra.quantidade || 0} espaços\`).replace(/^comprou\\s*/, "");
        const textoCurto = descricao.length > 50 ? descricao.substring(0, 47) + '...' : descricao;
        return '<span class="compra-item" title="' + escHtml(descricao) + '">' +
            '<span class="compra-avatar">' + (compra.apelido ? escHtml(compra.apelido.charAt(0).toUpperCase()) : '?') + '</span>' +
            '<div class="compra-info">' +
                '<span class="compra-texto">' + escHtml(compra.apelido || "Alguém") + ' comprou <b>' + escHtml(textoCurto) + '</b></span>' +
                '<span class="compra-tempo">' + formatarTempoAtras(Math.floor((Date.now() - (compra.criadoEm ? new Date(compra.criadoEm).getTime() : Date.now())) / 1000)) + '</span>' +
            '</div>' +
            '<span class="compra-valor">' + formatarReais(compra.valorCents) + '</span>' +
        '</span>';
    }).join("");
    const vezes = Math.max(3, Math.ceil(10 / Math.max(1, ultimasComprasState.length)));
    ticker.innerHTML = itemHtml.repeat(vezes);
    if(comprasTickerTimer) clearInterval(comprasTickerTimer);
    comprasTickerTimer = setInterval(carregarUltimasCompras, 5000);
}`;

if (content.includes(oldRender)) {
    content = content.replace(oldRender, newRender);
    fs.writeFileSync('C:/MegaOutdoor/public/index.html', content, 'utf8');
    console.log('OK - replaced');
} else {
    console.log('NOT FOUND');
}