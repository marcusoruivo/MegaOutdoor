/* =========================================================
   TESTE — UI VISUAL DA COLEÇÃO ANIMAIS DO MUNDO
   Não toca em servidor; testa o módulo compartilhado
   public/js/colecao-ui.js (acabamentos, cards, filtros, resumo).
========================================================= */

const assert = require("assert");
const path = require("path");
const UI = require(path.join(__dirname, "public", "js", "colecao-ui.js"));

const log = [];
function t(nome, cond, extra) {
    const ok = !!cond;
    log.push((ok ? "PASS" : "FAIL") + " | " + nome + (extra ? " | " + extra : ""));
    return ok;
}

/* Monta um catálogo de 100 cartas a partir do dicionário de emojis,
   respeitando a distribuição 60/25/9/4/1/1. */
const nomes = Object.keys(UI.EMOJI_ANIMAIS);
const raridades = [
    ...Array(60).fill("COMUM"),
    ...Array(25).fill("INCOMUM"),
    ...Array(9).fill("RARA"),
    ...Array(4).fill("EPICA"),
    "LENDARIA",
    "MITICA"
];
const catalogo = nomes.map((name, i) => ({
    id: 1000 + i,
    number: i + 1,
    name,
    rarity: raridades[i],
    scientific_name: "Scientific " + name,
    habitat: i % 3 === 0 ? "Savanas" : i % 3 === 1 ? "Florestas tropicais" : "Oceanos",
    peso: (i + 1) + " kg"
}));

function qtdPorRaridade(cards) {
    const m = {};
    for (const c of cards) m[c.rarity] = (m[c.rarity] || 0) + 1;
    return m;
}

function qtdPorFinish(cards) {
    const m = { ouro: 0, cromada: 0, normal: 0 };
    for (const c of cards) m[UI.finishDeCard(c)]++;
    return m;
}

/* ===== 1) Catálogo de 100 espécies reais ===== */
t("1) EMOJI_ANIMAIS possui 100 espécies", nomes.length === 100, "n=" + nomes.length);
t("2) catalogo montado com 100 cartas", catalogo.length === 100);
const contRar = qtdPorRaridade(catalogo);
t("3) distribuição 60/25/9/4/1/1",
    contRar.COMUM === 60 && contRar.INCOMUM === 25 && contRar.RARA === 9 &&
    contRar.EPICA === 4 && contRar.LENDARIA === 1 && contRar.MITICA === 1,
    JSON.stringify(contRar));

/* ===== 4) Cada espécie tem emoji ===== */
t("4) todas as espécies possuem emoji",
    catalogo.every(c => UI.emojiAnimal(c).length > 0),
    "sem-emoji=" + catalogo.filter(c => !UI.emojiAnimal(c)).length);

/* ===== 5) Acabamento OURO/CROMADA ===== */
t("5) MITICA é sempre cromada",
    catalogo.filter(c => c.rarity === "MITICA").every(c => UI.finishDeCard(c) === "cromada"));

const lendarias = catalogo.filter(c => c.rarity === "LENDARIA");
t("6) LENDARIA tem acabamento especial",
    lendarias.every(c => UI.finishDeCard(c) === "ouro" || UI.finishDeCard(c) === "cromada"),
    JSON.stringify(qtdPorFinish(lendarias)));

const epicas = catalogo.filter(c => c.rarity === "EPICA");
const finEpicas = qtdPorFinish(epicas);
t("7) EPICAS podem ser ouro, cromada ou normal", finEpicas.ouro + finEpicas.cromada + finEpicas.normal === 4, JSON.stringify(finEpicas));

const raras = catalogo.filter(c => c.rarity === "RARA");
const finRaras = qtdPorFinish(raras);
t("8) RARAS podem ter acabamento especial", finRaras.ouro + finRaras.cromada + finRaras.normal === 9, JSON.stringify(finRaras));

const comuns = catalogo.filter(c => c.rarity === "COMUM" || c.rarity === "INCOMUM");
t("9) COMUM/INCOMUM nunca têm acabamento especial",
    comuns.every(c => UI.finishDeCard(c) === "normal"),
    "especiais=" + comuns.filter(c => UI.finishDeCard(c) !== "normal").length);

t("10) acabamento é determinístico (mesmo id = mesmo finish)",
    UI.finishDeCard(catalogo[0]) === UI.finishDeCard(catalogo[0]));

/* ===== 11) Filtros e pesquisa ===== */
t("11) filtrar por raridade RARA", UI.filtrarCards(catalogo, { filtro: "RARA" }).length === 9);
t("12) filtrar por acabamento OURO", UI.filtrarCards(catalogo, { filtro: "ouro" }).every(c => UI.finishDeCard(c) === "ouro"));
t("13) filtrar por acabamento CROMADA", UI.filtrarCards(catalogo, { filtro: "cromada" }).every(c => UI.finishDeCard(c) === "cromada"));
t("14) pesquisa por nome funciona", UI.filtrarCards(catalogo, { busca: "leão" }).length > 0);

/* ===== 15) Resumo da coleção ===== */
const vazio = UI.resumoColecao([], 100);
t("15) coleção vazia tem 0/100", vazio.diferentes === 0 && vazio.total === 100 && vazio.completo === false);

const parcial = UI.resumoColecao(catalogo.slice(0, 10).map(c => ({ ...c, quantidade: 1 })), 100);
t("16) coleção parcial calcula progresso", parcial.diferentes === 10 && parcial.progresso === 10);

const completa = UI.resumoColecao(catalogo.map(c => ({ ...c, quantidade: 1 })), 100);
t("17) coleção completa", completa.diferentes === 100 && completa.completo === true);

const comRepetidas = UI.resumoColecao(catalogo.slice(0, 5).map((c, i) => ({ ...c, quantidade: i + 2 })), 100);
t("18) repetidas contadas corretamente", comRepetidas.repetidas === (2 + 3 + 4 + 5 + 6 - 5), "rep=" + comRepetidas.repetidas);

/* ===== 19) Nova / Repetida na abertura ===== */
const pacote = [catalogo[0], catalogo[0], catalogo[1]];
const posse = { [catalogo[0].id]: 3, [catalogo[1].id]: 1 };
const marcacoes = UI.marcarNovidades(posse, pacote);
t("19) marcarNovidades identifica repetida",
    marcacoes[0].repetida && !marcacoes[0].nova &&
    marcacoes[1].repetida && !marcacoes[1].nova &&
    marcacoes[2].nova && !marcacoes[2].repetida);

const resumoPacote = UI.packResumo(marcacoes);
t("20) packResumo conta 1 nova e 2 repetidas", resumoPacote.novas === 1 && resumoPacote.repetidas === 2);

/* ===== 21) Melhor do pacote ===== */
const pacote2 = [catalogo[60], catalogo[85], catalogo[98], catalogo[99]]; // INCOMUM, EPICA, LENDARIA, MITICA
const melhor = UI.melhorDoPacote(pacote2);
t("21) melhorDoPacote escolhe a MÍTICA", melhor && melhor.rarity === "MITICA");

/* ===== 22) Construtores de HTML ===== */
const htmlBloq = UI.cardColecaoHtml({ ...catalogo[0], quantidade: 0 });
t("22) card bloqueado esconde nome", htmlBloq.includes("???") && htmlBloq.includes("cc-bloqueada"));

const htmlPoss = UI.cardColecaoHtml({ ...catalogo[0], quantidade: 2 });
t("23) card possuído mostra nome e quantidade", htmlPoss.includes(catalogo[0].name) && htmlPoss.includes("Possui: <b>2x</b>"));

const htmlGrande = UI.cardGrandeHtml(catalogo[99]);
t("24) card grande tem identidade Milhão Door", htmlGrande.includes("🐾") && htmlGrande.includes("#100"));
t("25) card grande marca acabamento", htmlGrande.includes("fin-cromada") || htmlGrande.includes("fin-ouro") || htmlGrande.includes("cc-fin-"));

const htmlRev = UI.cardRevelacaoHtml(catalogo[0], 0, { nova: true, repetida: false });
t("26) revelação mostra flag NOVA", htmlRev.includes("NOVA FIGURINHA!"));

/* ===== 27) Imagens reais das 100 espécies ===== */
t("27) todas as 100 espécies possuem imagem fallback",
    catalogo.every(c => !!UI.imagemAnimal(c)),
    "sem-imagem=" + catalogo.filter(c => !UI.imagemAnimal(c)).length);
t("28) card possuído renderiza <img> real",
    htmlPoss.includes("<img") && htmlPoss.includes("cc-img"));
t("29) todas as 100 espécies possuem região",
    catalogo.every(c => !!UI.regiaoAnimal(c)),
    "sem-regiao=" + catalogo.filter(c => !UI.regiaoAnimal(c)).length);
t("30) card possuído mostra região", htmlPoss.includes("🌎"));
t("31) verso da carta contém curiosidade", UI.cardVersoHtml(catalogo[0]).includes("Curiosidade"));
t("32) card bloqueado NÃO revela imagem real", !htmlBloq.includes("<img") && htmlBloq.includes("cc-paw-marca"));

/* ===== resultado ===== */
const falhas = log.filter(l => l.startsWith("FAIL"));
console.log("\n=== RESULTADO test-col-visual ===");
for (const l of log) console.log(l);
console.log("\nTotal: " + log.length + " | Passou: " + (log.length - falhas.length) + " | Falhou: " + falhas.length);
if (falhas.length) {
    console.log("FALHAS:\n" + falhas.join("\n"));
    process.exit(1);
}
console.log("OK");
process.exit(0);
