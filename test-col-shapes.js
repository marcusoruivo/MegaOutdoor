/* Valida os shapes das respostas que o frontend colecionaveis.html consome. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3195";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colshape-" + Date.now());
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
                    transaction_data: { qr_code_base64: "bW9jaw==", qr_code: "000201mock",
                        ticket_url: "https://mock.local/ticket/" + id } } }] }
        };
        ordersCriadas.set(id, order);
        return { ok: true, status: 201, json: async () => order };
    }
    const m = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (m && method === "GET") {
        const id = m[1];
        const order = ordersCriadas.get(id) || { id, status: "open", external_reference: "mock", transactions: { payments: [] } };
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

const BASE = "http://localhost:3195";
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

async function main() {
    await sleep(4500);
    const email = "shape-" + Date.now() + "@teste.com";
    const r = await reqJson(BASE + "/api/auth/registrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Shape Test", email, senha: "senha-teste-123" })
    });
    const h = { "Authorization": "Bearer " + r.body.token, "Content-Type": "application/json" };
    t("registro", !!r.body.token && !!r.body.usuario?.id);

    /* compra um pacote para ter figurinhas */
    const ck = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + ck.body.externalReference, { method: "POST", headers: h });

    /* /figurinha/:id shape */
    let f = await reqJson(BASE + "/api/colecionaveis/figurinha/1", { headers: h });
    const fc = f.body.card || {};
    t("figurinha shape", fc.id && fc.number && typeof fc.quantidade === "number" &&
        typeof fc.disponivel === "number" && typeof fc.total_em_circulacao === "number",
        "q=" + fc.quantidade + " disp=" + fc.disponivel + " circ=" + fc.total_em_circulacao);

    /* /perfil shape (novo) */
    let p = await reqJson(BASE + "/api/colecionaveis/perfil", { headers: h });
    const pr = p.body.perfil || {};
    t("perfil shape", pr.stats && typeof pr.stats.diferentes === "number" &&
        typeof pr.stats.repetidas === "number" &&
        typeof pr.album_completo === "boolean" && typeof pr.ranking === "number",
        "stats=" + JSON.stringify(pr.stats) + " rank=" + pr.ranking);
    t("perfil conquistas raiz", Array.isArray(p.body.conquistas) &&
        p.body.conquistas.every(c => "desbloqueada" in c),
        "n=" + (p.body.conquistas || []).length);

    /* /colecionador/:id shape */
    let co = await reqJson(BASE + "/api/colecionaveis/colecionador/" + r.body.usuario.id, { headers: h });
    t("colecionador shape", co.body.perfil && co.body.perfil.nome && typeof co.body.perfil.diferentes === "number",
        "nome=" + (co.body.perfil && co.body.perfil.nome));

    /* /listings/mine shape */
    let lm = await reqJson(BASE + "/api/colecionaveis/listings/mine", { headers: h });
    t("listings/mine shape", Array.isArray(lm.body.listings), "n=" + lm.body.listings.length);

    /* criar anúncio + marketplace shape */
    const album = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h });
    const meuCard = album.body.cards.find(c => c.quantidade > 0);
    let v = await reqJson(BASE + "/api/colecionaveis/listings", {
        method: "POST", headers: h,
        body: JSON.stringify({ cardId: meuCard.id, quantidade: 1, preco: 5 })
    });
    t("cria anúncio", v.r.status === 200 && v.body.ok);
    let mk = await reqJson(BASE + "/api/colecionaveis/marketplace");
    t("marketplace shape", mk.body.listings[0] && mk.body.listings[0].seller_nome !== undefined &&
        mk.body.listings[0].seller_id !== undefined,
        "seller_nome=" + (mk.body.listings[0] && mk.body.listings[0].seller_nome));

    /* /trades/mine shape com items + messages (novo) */
    let tm = await reqJson(BASE + "/api/colecionaveis/trades/mine", { headers: h });
    t("trades/mine shape", Array.isArray(tm.body.trades), "n=" + tm.body.trades.length);

    /* DELETE /listings/:id */
    let lm2 = await reqJson(BASE + "/api/colecionaveis/listings/mine", { headers: h });
    const meuAnuncio = lm2.body.listings[0];
    let del = await reqJson(BASE + "/api/colecionaveis/listings/" + meuAnuncio.id, { method: "DELETE", headers: h });
    t("delete anúncio", del.r.status === 200 && del.body.ok, "status=" + del.r.status + " err=" + (del.body.error || ""));

    console.log(log.join("\n"));
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("-----------------------------");
    console.log("COLECIONAVEIS SHAPES: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error("ERRO GLOBAL:", e); process.exit(1); });