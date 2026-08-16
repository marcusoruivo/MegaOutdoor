/* Verifica que os números dos espaços do mapa só aparecem em hover/seleção. */
const fs = require("fs");
const src = fs.readFileSync("public/index.html", "utf8");
const checks = [
    ["variável hoveredSpaceId declarada", /let hoveredSpaceId = null;/.test(src)],
    ["número do espaço condicionado a hover/seleção", /hoveredSpaceId === id \|\|\s+sel\.has\(id\)/.test(src) && /searchTarget === id/.test(src) && /storyHighlightIds\.has\(id\)/.test(src)],
    ["fillText do número fora de desenho incondicional", (() => { const m = src.indexOf('"#" + id'); const snippet = src.slice(src.lastIndexOf("if(", m - 400), m); return !/fillText\(\s*"#"\s*\+\s*id/.test(src.slice(0, src.indexOf('hoveredSpaceId === id'))) || /if\(/.test(snippet) && /hoveredSpaceId === id/.test(snippet); })().valueOf()],
    ["pointermove atualiza hoveredSpaceId", /hoveredSpaceId = hid;/.test(src) && /hrow\*C\+hcol\+1/.test(src)],
    ["pointerleave limpa hoveredSpaceId", /area\.onpointerleave/.test(src) && /hoveredSpaceId = null;/.test(src)],
    ["sem camada HTML duplicada de números", !/<div[^>]*#\$\{|class="[^"]*numero[^"]*"/.test(src)],
    ["hint permanece position:relative", /\.hint\s*{[^}]*position:\s*relative/.test(src)],
    ["canvas permanece display:block 100%", /canvas#canvas[^}]*display:\s*block[^}]*width:\s*100%[^}]*height:\s*100%/.test(src)],
    ["clique alterna seleção existente", /if\(sel\.has\(id\)\)\s*\{[\s\S]*?sel\.delete\(id\);[\s\S]*?sel\.add\(id\);/.test(src)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);