/* Teste isolado das concessões administrativas. Usa pg-mem e DATA_DIR temporário. */
process.env.DATABASE_URL = "postgres://memoria-concessoes";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3310";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "admin-concessoes-" + Date.now());
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

(async () => {
    await sleep(3500);
    const user = await json(BASE + "/api/auth/registrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome: "Concessão Teste", email: "concessao-" + Date.now() + "@teste.com", senha: "senha-teste-123" }) });
    const userId = user.body.usuario.id;
    const userHeaders = { Authorization: "Bearer " + user.body.token };
    const admin = await json(BASE + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: "admin", senha: "senha123" }) });
    const adminHeaders = { Authorization: "Bearer " + admin.body.token, "Content-Type": "application/json" };
    test("admin autenticado acessa concessões", admin.response.status === 200);
    const denied = await json(BASE + "/api/admin/concessoes/usuarios?busca=Concessão", { headers: userHeaders });
    test("usuário comum recebe acesso negado", denied.response.status === 401);
    const users = await json(BASE + "/api/admin/concessoes/usuarios?busca=Concessão", { headers: adminHeaders });
    test("busca usuário por nome", users.response.status === 200 && users.body.usuarios.some(u => u.id === userId));
    const cards = await json(BASE + "/api/admin/concessoes/cards?busca=1", { headers: adminHeaders });
    const cardId = cards.body.cards[0].id;
    test("busca figurinha do catálogo", cards.response.status === 200 && Number.isInteger(Number(cardId)), cards.body.error || JSON.stringify(cards.body.cards && cards.body.cards[0]));
    const reason = "Premiação de teste administrativo";
    const grantCards = await json(BASE + "/api/admin/concessoes/figurinhas", { method: "POST", headers: adminHeaders, body: JSON.stringify({ usuarioId: userId, cardIds: [cardId], motivo: reason }) });
    test("concede figurinha sem compra", grantCards.response.status === 200, grantCards.body.error);
    const album = await json(BASE + "/api/colecionaveis/acervo", { headers: userHeaders });
    test("figurinha aparece no acervo", album.response.status === 200 && album.body.cards.some(c => Number(c.id) === Number(cardId) && Number(c.quantidade) === 1), album.body.error);
    const grantSpaces = await json(BASE + "/api/admin/concessoes/espacos", { method: "POST", headers: adminHeaders, body: JSON.stringify({ usuarioId: userId, ids: [1001, 1002], motivo: reason }) });
    test("concede espaços sem transação", grantSpaces.response.status === 200);
    const conta = await json(BASE + "/api/auth/me", { headers: userHeaders });
    test("espaços aparecem na conta", conta.response.status === 200 && conta.body.espacos.length === 2);
    const duplicate = await json(BASE + "/api/admin/concessoes/espacos", { method: "POST", headers: adminHeaders, body: JSON.stringify({ usuarioId: userId, ids: [1001], motivo: reason }) });
    test("espaço ocupado não é sobrescrito", duplicate.response.status === 409);
    const history = await json(BASE + "/api/admin/concessoes/historico", { headers: adminHeaders });
    test("histórico registra as concessões", history.response.status === 200 && history.body.concessoes.length >= 2, history.body.error);
    const missingReason = await json(BASE + "/api/admin/concessoes/figurinhas", { method: "POST", headers: adminHeaders, body: JSON.stringify({ usuarioId: userId, cardIds: [cardId], motivo: "" }) });
    test("motivo é obrigatório", missingReason.response.status === 400);
    console.log("OK | concessões isoladas sem pagamento ou banco real");
    process.exit(process.exitCode || 0);
})().catch(error => { console.error(error); process.exitCode = 1; });
