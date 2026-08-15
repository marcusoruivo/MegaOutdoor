/* Verifica configuração e idempotência da recompensa mensal. */
const fs = require("fs");
const source = fs.readFileSync("colecionaveis.js", "utf8");
const checks = [
    ["período mensal configurável", /MONTHLY_ALBUM_START/.test(source) && /MONTHLY_ALBUM_END/.test(source)],
    ["recompensa centralizada", /MONTHLY_ALBUM_REWARD/.test(source)],
    ["tabela mensal existe", /sticker_monthly_rewards/.test(source)],
    ["recompensa exige álbum completo", /diferentes < 100/.test(source)],
    ["recompensa idempotente", /ON CONFLICT \(usuario_id, period_key\) DO NOTHING/.test(source)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
