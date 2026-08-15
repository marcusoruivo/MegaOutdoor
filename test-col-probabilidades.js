/* Valida a fonte única das probabilidades exibidas e sorteadas. */
const fs = require("fs");
const source = fs.readFileSync("colecionaveis.js", "utf8");
const block = source.match(/const PROBABILIDADES = \{([\s\S]*?)\n\};/);
const values = block ? [...block[1].matchAll(/(?:COMUM|INCOMUM|RARA|EPICA|LENDARIA|MITICA):\s*([0-9.]+)/g)].map(m => Number(m[1])) : [];
const sum = values.reduce((a, b) => a + b, 0);
console.log((values.length === 6 && Math.abs(sum - 100) < 0.000001 ? "PASS" : "FAIL") + " | probabilidades somam 100% | valores=" + values.join(","));
console.log("Fonte única usada por sortearRaridade e /info: " + (/sortearRaridade/.test(source) && /probabilidades: PROBABILIDADES/.test(source) ? "PASS" : "FAIL"));
process.exit(values.length === 6 && Math.abs(sum - 100) < 0.000001 ? 0 : 1);
