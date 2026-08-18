/* Teste isolado do fluxo de publicação, edição e extensão de imagens.
   Usa pg-mem e DATA_DIR temporário (ALLOW_TEST_MODE=true). */
process.env.DATABASE_URL = "postgres://memoria-publicacao";
process.env.ALLOW_TEST_MODE = "true";
process.env.PORT = process.env.PORT || "3320";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "publicacao-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}", "utf8");

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();
const pg = require("pg");
pg.Pool = adapter.Pool;
pg.Client = adapter.Client;
if (adapter.types) pg.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:" + process.env.PORT;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    return { response, body };
}
function test(name, ok, detail) { console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : "")); if (!ok) process.exitCode = 1; }

const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

(async () => {
    await sleep(3500);

    const rodada = Date.now().toString(36);

    /* Dono: cria conta e compra 3 espaços consecutivos */
    const dono = await json(BASE + "/api/auth/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Dona Publicação", email: "dona." + rodada + "@teste.com", senha: "senha-teste-123" })
    });
    const donoHeaders = { Authorization: "Bearer " + dono.body.token };
    const donoId = dono.body.usuario.id;

    /* Intruso: outro usuário tenta mexer no espaço alheio */
    const intruso = await json(BASE + "/api/auth/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Intruso", email: "intruso." + rodada + "@teste.com", senha: "senha-teste-123" })
    });
    const intrusoHeaders = { Authorization: "Bearer " + intruso.body.token };

    const s1 = 700001;
    const s2 = s1 + 1;
    const s3 = s1 + 2;
    const sLonge = s1 + 500;

    const compra = await json(BASE + "/api/test/reserve", {
        method: "POST",
        headers: { ...donoHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Empresa Teste", email: "dona." + rodada + "@teste.com", spaces: [s1, s2, s3] })
    });
    const orderToken = compra.body.orderToken;
    test("1. compra sem preencher nada deixa espaços 'paid'", compra.response.status === 200 && !!orderToken, compra.body.error);

    const st0 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    const st0ok = [s1, s2, s3].every(id => st0.body[id] && st0.body[id].status === "paid");
    test("1b. espaços ficam 'paid' (aguardando publicação), sem imagem", st0ok && [s1, s2, s3].every(id => !st0.body[id].image));

    /* 2. Intruso não consegue publicar no espaço alheio */
    const fd2 = new FormData();
    fd2.append("fotos", new Blob([PNG_1x1], { type: "image/png" }), "intruso.png");
    fd2.append("name", "Intruso");
    const pubIntruso = await json(BASE + "/api/upload/" + s1, { method: "POST", headers: intrusoHeaders, body: fd2 });
    test("2. não-dono recebe 403 ao publicar", pubIntruso.response.status === 403, pubIntruso.body.error);

    /* 3. Dono publica individual (1 imagem) */
    const fd3 = new FormData();
    fd3.append("fotos", new Blob([PNG_1x1], { type: "image/png" }), "foto.png");
    fd3.append("name", "Empresa Teste");
    fd3.append("link", "https://empresa.com");
    fd3.append("orderToken", orderToken);
    const pub1 = await json(BASE + "/api/upload/" + s1, { method: "POST", headers: donoHeaders, body: fd3 });
    const st1 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    test("3. dono publica imagem individual", pub1.response.status === 200 && st1.body[s1].status === "published" && !!st1.body[s1].image && st1.body[s1].displayMode === "individual", st1.body[s1] && st1.body[s1].error);

    /* 4. Modo estendido com espaços NÃO consecutivos é rejeitado */
    const fd4 = new FormData();
    fd4.append("fotos", new Blob([PNG_1x1], { type: "image/png" }), "ext.png");
    fd4.append("name", "Extensão");
    fd4.append("mode", "extended");
    fd4.append("ids", JSON.stringify([s1, sLonge]));
    fd4.append("orderToken", orderToken);
    const extRuim = await json(BASE + "/api/upload/" + s1, { method: "POST", headers: donoHeaders, body: fd4 });
    test("4. extensão com espaços não consecutivos dá 400", extRuim.response.status === 400, extRuim.body.error);

    /* 5. Modo estendido com 3 espaços consecutivos publica o bloco */
    const fd5 = new FormData();
    fd5.append("fotos", new Blob([PNG_1x1], { type: "image/png" }), "ext2.png");
    fd5.append("name", "Extensão Teste");
    fd5.append("link", "https://extensao.com");
    fd5.append("mode", "extended");
    fd5.append("ids", JSON.stringify([s1, s2, s3]));
    fd5.append("orderToken", orderToken);
    const extBoa = await json(BASE + "/api/upload/" + s1, { method: "POST", headers: donoHeaders, body: fd5 });
    const st5 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    const extOk = extBoa.response.status === 200 &&
        [s1, s2, s3].every(id => st5.body[id] && st5.body[id].status === "published") &&
        [s1, s2, s3].every(id => st5.body[id].displayMode === "extended") &&
        st5.body[s1].imageGroupSpaces.length === 3;
    test("5. extensão válida publica bloco contíguo inteiro", extOk, st5.body[s1] && JSON.stringify(st5.body[s1].imageGroupSpaces));

    /* 6. Intruso não edita link; dono edita */
    const linkIntruso = await json(BASE + "/api/link", {
        method: "POST",
        headers: { ...intrusoHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [s2], link: "https://intruso.com" })
    });
    test("6a. não-dono recebe 403 ao editar link", linkIntruso.response.status === 403, linkIntruso.body.error);
    const linkOk = await json(BASE + "/api/link", {
        method: "POST",
        headers: { ...donoHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [s2], link: "https://novo-site.com" })
    });
    const st6 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    test("6b. dono edita link sem trocar a foto", linkOk.response.status === 200 && st6.body[s2].link === "https://novo-site.com", st6.body[s2] && st6.body[s2].link);

    /* 7. keepImage: edita apenas o título, imagem é preservada */
    const fd7 = new FormData();
    fd7.append("name", "Novo Nome");
    fd7.append("keepImage", "true");
    fd7.append("mode", "extended");
    fd7.append("ids", JSON.stringify([s1, s2, s3]));
    fd7.append("orderToken", orderToken);
    const keep = await json(BASE + "/api/upload/" + s1, { method: "POST", headers: donoHeaders, body: fd7 });
    const st7 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    test("7. keepImage mantém a imagem ao editar só o nome", keep.response.status === 200 && !!st7.body[s1].image && st7.body[s1].title === "Novo Nome", st7.body[s1] && st7.body[s1].title);

    /* 8. removeImage reverte para 'paid' (aguardando publicação) */
    const fd8 = new FormData();
    fd8.append("removeImage", "true");
    fd8.append("orderToken", orderToken);
    const rem = await json(BASE + "/api/upload/" + s2, { method: "POST", headers: donoHeaders, body: fd8 });
    const st8 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    const remOk = rem.response.status === 200 &&
        !st8.body[s2].image &&
        st8.body[s2].status === "paid" &&
        st8.body[s2].displayMode === "individual" &&
        Array.isArray(st8.body[s2].imageGroupSpaces) &&
        st8.body[s2].imageGroupSpaces.length === 1 &&
        !st8.body[s2].publishedAt;
    test("8. removeImage volta para 'paid' sem imagem", remOk, JSON.stringify(st8.body[s2] || {}));

    /* 9. Publicar sem nome usa o título existente */
    const fd9 = new FormData();
    fd9.append("fotos", new Blob([PNG_1x1], { type: "image/png" }), "foto9.png");
    fd9.append("orderToken", orderToken);
    const semNome = await json(BASE + "/api/upload/" + s3, { method: "POST", headers: donoHeaders, body: fd9 });
    const st9 = await json(BASE + "/api/spaces", { headers: { "x-owner-tokens": orderToken } });
    test("9. publicar sem nome preserva título existente", semNome.response.status === 200 && st9.body[s3].title === st7.body[s3].title && st9.body[s3].title === "Novo Nome", st9.body[s3] && st9.body[s3].title);

    /* 10. Sem imagem, sem keepImage e sem removeImage → 400 */
    const fd10 = new FormData();
    fd10.append("name", "Sem Imagem");
    fd10.append("orderToken", orderToken);
    const semImagem = await json(BASE + "/api/upload/" + s3, { method: "POST", headers: donoHeaders, body: fd10 });
    test("10. upload sem imagem nem keepImage/removeImage dá 400", semImagem.response.status === 400, semImagem.body.error);

    console.log("OK | fluxo de publicação/edição/extensão validado");
    process.exit(process.exitCode || 0);
})().catch(error => { console.error(error); process.exitCode = 1; });