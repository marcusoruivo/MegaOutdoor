/* Auditoria de configuração das imagens das 100 espécies. */
const { IMAGENS_ANIMAIS, REGIOES_ANIMAIS } = require("./public/js/imagens-animais.js");
const nomes = Object.keys(IMAGENS_ANIMAIS);
const failures = [];
if (nomes.length !== 100) failures.push("catálogo de imagens não possui 100 espécies");
for (const nome of nomes) {
    const url = IMAGENS_ANIMAIS[nome];
    if (!/^https:\/\//.test(url)) failures.push(nome + ": URL não HTTPS");
    if (/placehold|example\.com|emoji|placeholder/i.test(url)) failures.push(nome + ": URL parece placeholder");
    if (!REGIOES_ANIMAIS[nome]) failures.push(nome + ": região ausente");
}
console.log(failures.length ? "FAIL | " + failures.join("; ") : "PASS | 100 espécies possuem imagem HTTPS e região configuradas");
console.log(`Total: 100 | Passou: ${failures.length ? 0 : 100} | Falhou: ${failures.length}`);
process.exit(failures.length ? 1 : 0);
