/* Verificação estática do chat privado vinculado ao anúncio. */
const fs = require("fs");
const backend = fs.readFileSync("colecionaveis.js", "utf8");
const frontend = fs.readFileSync("public/colecionaveis.html", "utf8");
const checks = [
    ["tabela de mensagens por anúncio", /sticker_listing_messages/.test(backend)],
    ["GET de conversa por anúncio", /listings\/:id\/chat/.test(backend)],
    ["POST de conversa por anúncio", (backend.match(/listings\/:id\/chat/g) || []).length >= 2],
    ["limite de 500 caracteres", /text\.length > 500/.test(backend)],
    ["botão negociar no card", /abrirChatAnuncio\(' \+ l\.id/.test(frontend)],
    ["botão ver perfil no card", /verPerfilColecionador\(' \+ l\.seller_id/.test(frontend)],
    ["chat envia mensagem vinculada", /enviarChatAnuncio/.test(frontend)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
