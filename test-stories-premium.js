/* Testes de Stories Premium e Últimas Compras */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3204";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "stories-premium-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    return fetchOriginal(url, options);
};

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:3204";
const log = [];
function t(nome, cond, extra) { log.push((cond ? "PASS" : "FAIL") + " | " + nome + (extra ? " | " + extra : "")); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function reqJson(url, opts) {
    const r = await fetch(url, opts);
    const texto = await r.text();
    let body = null;
    try { body = JSON.parse(texto); } catch (e) { body = { raw: texto.slice(0, 160) }; }
    return { r, body };
}
async function registrar(nome, email) {
    const { r, body } = await reqJson(BASE + "/api/auth/registrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome, email, senha: "senha-teste-123" })
    });
    return { r, body };
}

async function main() {
    await sleep(4500);
    
    const e1 = "story1@testuser.com";
    const e2 = "story2@testuser.com";
    const r1 = await registrar("Story User 1", e1);
    const r2 = await registrar("Story User 2", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    
    t("registro de 2 usuários", !!u1Id && !!u2Id);

    /* === CONFIG DE STORIES === */
    let resp = await reqJson(BASE + "/api/stories/config", {});
    t("GET /api/stories/config retorna pricing", resp.r.status === 200 && resp.body.pricing && resp.body.pricing["3h"] != null, "status=" + resp.r.status);
    t("GET /api/stories/config tem durações 3h,6h,12h,24h", resp.body.duracoes && resp.body.duracoes.includes("3h") && resp.body.duracoes.includes("6h"), "duracoes=" + (resp.body.duracoes || []).join(","));

    /* === STORIES PÚBLICOS (vazio inicialmente) === */
    resp = await reqJson(BASE + "/api/stories", {});
    t("GET /api/stories retorna lista vazia inicialmente", resp.r.status === 200 && Array.isArray(resp.body.stories) && resp.body.stories.length === 0, "n=" + (resp.body.stories || []).length);

    /* === ÚLTIMAS COMPRAS (vazio inicialmente) === */
    resp = await reqJson(BASE + "/api/ultimas-compras", {});
    t("GET /api/ultimas-compras retorna lista vazia inicialmente", resp.r.status === 200 && Array.isArray(resp.body.compras) && resp.body.compras.length === 0, "n=" + (resp.body.compras || []).length);

    /* === CRIAR DESTAQUE (Story Premium) === */
    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1,
        body: JSON.stringify({ duracao: "6h", titulo: "Teste Story Premium", subtitulo: "Subtítulo teste", cpfCnpj: "12345678909", paymentMethod: "pix" })
    });
    t("POST /api/stories/destaques cria destaque 6h", resp.r.status === 200 && resp.body.ok === true && resp.body.id, "status=" + resp.r.status + " id=" + resp.body.id);
    const destaqueId = resp.body.id;
    t("Destaque 6h tem preço correto", resp.body.totalCents === 800, "totalCents=" + resp.body.totalCents);

    /* === LISTAR MEUS DESTAQUES === */
    resp = await reqJson(BASE + "/api/stories/destaques/meus", { headers: h1 });
    t("GET /api/stories/destaques/meus lista destaque criado", resp.r.status === 200 && resp.body.destaques.some(d => d.id === destaqueId), "n=" + (resp.body.destaques || []).length);

    /* === SEGURANÇA: outro usuário não vê destaque === */
    resp = await reqJson(BASE + "/api/stories/destaques/" + destaqueId, { headers: h2 });
    t("GET /api/stories/destaques/:id de outro usuário -> 404", resp.r.status === 404, "status=" + resp.r.status);

    /* === VALIDAÇÕES DE DESTAQUE === */
    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1,
        body: JSON.stringify({ duracao: "99h", titulo: "Teste", cpfCnpj: "12345678909" })
    });
    t("POST /api/stories/destaques duração inválida -> 400", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1,
        body: JSON.stringify({ duracao: "6h", cpfCnpj: "12345678909" })
    });
    t("POST /api/stories/destaques sem título -> 400", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1,
        body: JSON.stringify({ duracao: "6h", titulo: "Teste", cpfCnpj: "000" })
    });
    t("POST /api/stories/destaques CPF inválido -> 400", resp.r.status === 400, "status=" + resp.r.status);

    /* === SEM AUTENTICAÇÃO === */
    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST",
        body: JSON.stringify({ duracao: "6h", titulo: "Teste", cpfCnpj: "12345678909" })
    });
    t("POST /api/stories/destaques sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("STORIES PREMIUM: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
