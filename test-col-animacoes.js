/* Verifica os estados obrigatórios da animação de abertura. */
const fs = require("fs");
const ui = fs.readFileSync("public/colecionaveis.html", "utf8");
const checks = [
    ["pacote fechado", /renderPackFechado/.test(ui)],
    ["pacote rasgando", /rasgarPacote/.test(ui) && /rasgando/.test(ui)],
    ["luz de abertura", /renderPackLuz/.test(ui)],
    ["verso da carta", /renderSlotBack/.test(ui)],
    ["revelação de carta", /revelarSlot/.test(ui)],
    ["modo manual", /iniciarModoManual/.test(ui)],
    ["modo automático", /iniciarModoAuto/.test(ui)],
    ["nova/repetida", /marcarNovidades/.test(ui) && /NOVA/.test(ui)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
