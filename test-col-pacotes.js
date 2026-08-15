/* Verificações estáticas do ciclo pagamento -> pacote fechado -> abertura. */
const fs = require("fs");
const colecionaveis = fs.readFileSync("colecionaveis.js", "utf8");
const ui = fs.readFileSync("public/colecionaveis.html", "utf8");
const confirmacao = colecionaveis.slice(colecionaveis.indexOf("async function confirmarCompraPacote"), colecionaveis.indexOf('router.post("/packs/purchases/:id/open"'));
const checks = [
    ["estado unopened existe", /open_status\s+VARCHAR/.test(colecionaveis)],
    ["inventário de pacotes de kit existe", /sticker_pack_inventory/.test(colecionaveis)],
    ["endpoint de abertura direta existe", /packs\/purchases\/:id\/open/.test(colecionaveis)],
    ["endpoint de abertura de kit existe", /packs\/inventory\/:id\/open/.test(colecionaveis)],
    ["pacote pago não insere user_stickers na confirmação", !confirmacao.includes("user_stickers")],
    ["UI tem abertura manual", /iniciarModoManual/.test(ui) && /ABRIR UMA POR UMA/.test(ui)],
    ["UI tem abertura total", /iniciarModoAuto/.test(ui) && /ABRIR TODAS/.test(ui)],
    ["pacotes não abertos aparecem", /meus-pacotes/.test(ui) && /PACOTES NÃO ABERTOS/.test(ui)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
