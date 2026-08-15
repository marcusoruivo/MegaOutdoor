/* Verifica o contrato de propriedade de espaços vindos de KIT. */
const fs = require("fs");
const combo = fs.readFileSync("combos.js", "utf8");
const index = fs.readFileSync("public/index.html", "utf8");
const checks = [
    ["kit confirma token de proprietário", /orderToken: alocados\.orderToken/.test(combo)],
    ["kit confirma access code", /accessCode: alocados\.accessCode/.test(combo)],
    ["frontend salva token", /salvarTokens\(data\.espacos/.test(index)],
    ["ownership usa token do espaço", /orderTokens\[id\].*s\.orderToken/s.test(index)],
    ["edição não depende de compra individual", !/operationType.*individual.*owner/s.test(index)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
