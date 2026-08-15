/* Valida os filtros e estatísticas do Acervo (repetidas/novas/todas). */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3290";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colacervo-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const ordenador = { seq: 1 };
const ordersCriadas = new Map();
const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) return fetchOriginal(url, options);
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    if (u.endsWith("/v1/orders") && method === "POST") {
        const id = String(900000 + ordenador.seq++);
        const order = {
            id, status: "open", external_reference: body.external_reference,
            transactions: { payments: [{ id: "pay-" + id, status: "pending",
                status_detail: "pending_waiting_transfer",
                payment_method: { id: "pix", type: "bank_transfer",
                    qr_code_base64: "bW9jaw==", qr_code: "000201mock",
                    ticket_url: "https://mock.local/ticket/" + id } }] }
        };
        ordersCriadas.set(id, order);
        return { ok: true, status: 201, json: async () => order };
    }
    const m = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (m && method === "GET") {
        const id = m[1];
        const order = ordersCriadas.get(id);
        if (!order) {
            return { ok: false, status: 404, json: async () => ({ message: "Order not found", status: 404, error: "not_found" }) };
        }
        return { ok: true, status: 200, json: async () => order };
    }
    return { ok: false, status: 404, json: async () => ({ message: "Rota MP não encontrada " + u }) };
};

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:3290";
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
const json = (method, token, payload) => ({
    method,
    headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { "Authorization": "Bearer " + token } : {}
    ),
    body: payload === undefined ? undefined : JSON.stringify(payload)
});

async function comprarPacote(userTok, packId) {
    const ck = await reqJson(BASE + "/api/colecionaveis/packs/" + packId + "/checkout",
        json("POST", userTok, { paymentMethod: "pix", cpfCnpj: "12345678909" }));
    const ext = ck.body.externalReference;
    const mpId = String(ck.body.orderId);
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + ext, json("POST", userTok));
    const ordem = ordersCriadas.get(mpId);
    if (ordem) {
        ordem.status = "paid";
        ordem.total_amount = String(ck.body.valor || 2);
        ordem.transactions.payments[0].status = "paid";
        ordem.transactions.payments[0].status_detail = "accredited";
    }
    const pago = await reqJson(BASE + "/api/colecionaveis/pagamento/" + ext, json("GET", userTok));
    if (pago.body.pacote && pago.body.pacote.purchaseId) {
        await reqJson(BASE + "/api/colecionaveis/packs/purchases/" + pago.body.pacote.purchaseId + "/open", json("POST", userTok, {}));
    }
    return ck;
}

async function main() {
    await sleep(4500);

    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    const adminTok = login.body.token || "";
    t("login admin ok", login.r.status === 200 && !!adminTok);

    const email = "acervo-test-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Acervo Test", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário", !!userTok);

    const info = await reqJson(BASE + "/api/colecionaveis/info", json("GET", userTok));
    const packs = info.body.packs || [];
    const bronze = packs.find(p => p.slug === "bronze") || packs[0];
    t("pacote disponível", !!bronze && bronze.id);

    /* Primeira compra: 3 figurinhas novas, 0 repetidas */
    await comprarPacote(userTok, bronze.id);
    const a1 = await reqJson(BASE + "/api/colecionaveis/acervo", json("GET", userTok));
    const cards1 = a1.body.cards || [];
    const stats1 = a1.body.stats || {};
    t("acervo após 1 pacote: 3 cartas, 0 repetidas",
        cards1.length === 3 && stats1.total === 3 && stats1.diferentes === 3 && stats1.repetidas === 0,
        "cards=" + cards1.length + " total=" + stats1.total + " rep=" + stats1.repetidas);

    /* Compra vários pacotes até forçar ao menos uma repetida
       (probabilística; com até 30 pacotes a chance de falha é desprezível). */
    let a2, cards2, stats2;
    let tentativas = 0;
    do {
        await comprarPacote(userTok, bronze.id);
        a2 = await reqJson(BASE + "/api/colecionaveis/acervo", json("GET", userTok));
        cards2 = a2.body.cards || [];
        stats2 = a2.body.stats || {};
        tentativas++;
    } while (stats2.repetidas === 0 && tentativas < 30);
    t("acervo forçou ao menos 1 repetida",
        stats2.repetidas > 0,
        "total=" + stats2.total + " diferentes=" + stats2.diferentes + " repetidas=" + stats2.repetidas + " tentativas=" + tentativas);

    /* Filtros */
    const novas = await reqJson(BASE + "/api/colecionaveis/acervo?repetidas=novas", json("GET", userTok));
    const todasNovasOk = (novas.body.cards || []).every(c => Number(c.quantidade) === 1);
    t("filtro repetidas=novas retorna apenas quantidade=1",
        novas.r.status === 200 && todasNovasOk,
        "n=" + (novas.body.cards || []).length);

    const repetidas = await reqJson(BASE + "/api/colecionaveis/acervo?repetidas=repetidas", json("GET", userTok));
    const todasRepOk = (repetidas.body.cards || []).every(c => Number(c.quantidade) > 1);
    t("filtro repetidas=repetidas retorna apenas quantidade>1",
        repetidas.r.status === 200 && todasRepOk,
        "n=" + (repetidas.body.cards || []).length);

    const todas = await reqJson(BASE + "/api/colecionaveis/acervo?repetidas=todas", json("GET", userTok));
    const totalTodas = (todas.body.cards || []).reduce((s, c) => s + Number(c.quantidade || 0), 0);
    t("filtro repetidas=todas equivale a lista completa",
        totalTodas === stats2.total,
        "totalTodas=" + totalTodas);

    /* Campos essenciais no acervo */
    const alguma = cards2[0];
    t("acervo expõe image_url/rarity/number/name",
        !!alguma && typeof alguma.image_url === "string" && typeof alguma.rarity === "string" &&
        typeof alguma.number === "number" && typeof alguma.name === "string");

    console.log("\n=== RESULTADO test-col-acervo ===");
    let pass = 0, fail = 0;
    for (const linha of log) {
        console.log(linha);
        if (linha.startsWith("PASS")) pass++; else fail++;
    }
    console.log("\nTotal: " + log.length + " | Passou: " + pass + " | Falhou: " + fail);
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error("ERRO DE TESTE:", err); process.exit(1); });
