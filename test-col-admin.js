/* Valida os endpoints administrativos de colecionáveis e o catálogo. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3197";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "coladmin-" + Date.now());
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

const BASE = "http://localhost:3197";
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

async function main() {
    await sleep(4500);

    /* ===== Acesso administrativo ===== */
    const semToken = await reqJson(BASE + "/api/colecionaveis/admin/resumo");
    t("admin resumo sem token -> 401", semToken.r.status === 401, "status=" + semToken.r.status);

    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    t("login admin ok", login.r.status === 200 && !!login.body.token);
    const adminTok = login.body.token || "";

    const email = "admin-test-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Admin Test", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário comum", !!userTok);

    const comoUsuario = await reqJson(BASE + "/api/colecionaveis/admin/resumo", json("GET", userTok));
    t("admin resumo com token de usuário -> 401", comoUsuario.r.status === 401, "status=" + comoUsuario.r.status);

    /* ===== Resumo admin ===== */
    const resumo = await reqJson(BASE + "/api/colecionaveis/admin/resumo", json("GET", adminTok));
    const rs = resumo.body;
    t("resumo shape", resumo.r.status === 200 && rs.colecao && rs.colecao.total === 100 &&
        Array.isArray(rs.cardsPorRaridade) && typeof rs.figurinhas_em_circulacao === "number",
        "colecao=" + (rs.colecao && rs.colecao.name) + " cards=" + (rs.colecao && rs.colecao.cards));
    t("resumo trocas/conquistas", typeof rs.trocas?.total === "number" &&
        typeof rs.conquistas?.total === "number" && rs.conquistas.total >= 12,
        "conquistas total=" + (rs.conquistas && rs.conquistas.total));

    /* ===== Catálogo (público) ===== */
    const catalogo = await reqJson(BASE + "/api/colecionaveis/catalogo");
    t("catálogo 100 figurinhas ativas", catalogo.r.status === 200 && catalogo.body.cards.length === 100,
        "n=" + (catalogo.body.cards || []).length);

    /* ===== Colecionadores ===== */
    const cols = await reqJson(BASE + "/api/colecionaveis/admin/colecionadores", json("GET", adminTok));
    t("colecionadores shape", cols.r.status === 200 && Array.isArray(cols.body.colecionadores) &&
        typeof cols.body.colecionadores[0]?.diferentes === "number",
        "n=" + (cols.body.colecionadores || []).length);

    /* Compra de pacote para gerar dados */
    const ck = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", json("POST", userTok, { paymentMethod: "pix", cpfCnpj: "12345678909" }));
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + ck.body.externalReference, json("POST", userTok));
    const pk = await reqJson(BASE + "/api/colecionaveis/pagamento/" + ck.body.externalReference, json("GET", userTok));
    await reqJson(BASE + "/api/colecionaveis/packs/purchases/" + pk.body.pacote.purchaseId + "/open", json("POST", userTok, {}));

    /* ===== Álbum de um usuário (admin) ===== */
    const album = await reqJson(BASE + "/api/colecionaveis/admin/usuario/" + reg.body.usuario.id, json("GET", adminTok));
    const ab = album.body;
    t("admin usuario álbum", album.r.status === 200 && ab.usuario && ab.progresso &&
        ab.progresso.diferentes > 0 && Array.isArray(ab.cards),
        "diferentes=" + (ab.progresso && ab.progresso.diferentes));
    const admin404 = await reqJson(BASE + "/api/colecionaveis/admin/usuario/999999", json("GET", adminTok));
    t("admin usuario inexistente -> 404", admin404.r.status === 404);

    /* ===== Estoque ===== */
    const estoque = await reqJson(BASE + "/api/colecionaveis/admin/estoque", json("GET", adminTok));
    const es = estoque.body;
    t("estoque shape", estoque.r.status === 200 && Array.isArray(es.cards) && es.cards.length === 100 &&
        typeof es.cards[0].em_circulacao === "number" && typeof es.cards[0].disponivel === "number",
        "cards=" + (es.cards || []).length);

    /* ===== Compras, vendas, transações, conquistas ===== */
    const compras = await reqJson(BASE + "/api/colecionaveis/admin/compras", json("GET", adminTok));
    t("compras shape", compras.r.status === 200 && Array.isArray(compras.body.compras) &&
        compras.body.compras.some(c => c.status === "paid"),
        "n=" + (compras.body.compras || []).length);

    const vendas = await reqJson(BASE + "/api/colecionaveis/admin/vendas", json("GET", adminTok));
    t("vendas shape", vendas.r.status === 200 && Array.isArray(vendas.body.vendas));

    const trans = await reqJson(BASE + "/api/colecionaveis/admin/transacoes", json("GET", adminTok));
    t("transações shape", trans.r.status === 200 && Array.isArray(trans.body.transacoes) &&
        trans.body.transacoes.length >= 1,
        "n=" + (trans.body.transacoes || []).length);

    const conquistas = await reqJson(BASE + "/api/colecionaveis/admin/conquistas", json("GET", adminTok));
    t("conquistas shape", conquistas.r.status === 200 && Array.isArray(conquistas.body.conquistas) &&
        typeof conquistas.body.conquistas[0]?.desbloqueios === "number",
        "n=" + (conquistas.body.conquistas || []).length);

    /* ===== Edição de card (admin) ===== */
    const editCard = await reqJson(BASE + "/api/colecionaveis/admin/cards/1", json("POST", adminTok, { image_url: "https://exemplo.com/arte-1.png" }));
    t("editar card arte", editCard.r.status === 200 && editCard.body.ok);

    const editCardBad = await reqJson(BASE + "/api/colecionaveis/admin/cards/1", json("POST", adminTok, { image_url: "javascript:alert(1)" }));
    t("editar card url insegura -> 400", editCardBad.r.status === 400, "status=" + editCardBad.r.status);

    const editCardBadRar = await reqJson(BASE + "/api/colecionaveis/admin/cards/1", json("POST", adminTok, { rarity: "INEXISTENTE" }));
    t("editar card raridade inválida -> 400", editCardBadRar.r.status === 400);

    const toggleCard = await reqJson(BASE + "/api/colecionaveis/admin/cards/2", json("POST", adminTok, { is_active: false }));
    t("desativar card", toggleCard.r.status === 200 && toggleCard.body.ok);

    const catalogo2 = await reqJson(BASE + "/api/colecionaveis/catalogo");
    t("catálogo reflete card inativo (99)", catalogo2.r.status === 200 && catalogo2.body.cards.length === 99,
        "n=" + (catalogo2.body.cards || []).length);

    const reactivar = await reqJson(BASE + "/api/colecionaveis/admin/cards/2", json("POST", adminTok, { is_active: true }));
    t("reativar card", reactivar.r.status === 200 && reactivar.body.ok);

    const cardSemAuth = await reqJson(BASE + "/api/colecionaveis/admin/cards/1", json("POST", null, { name: "X" }));
    t("editar card sem token -> 401", cardSemAuth.r.status === 401);

    /* ===== Edição de pacote (admin) ===== */
    const packs = await reqJson(BASE + "/api/colecionaveis/admin/packs", json("GET", adminTok));
    t("listar pacotes admin", packs.r.status === 200 && Array.isArray(packs.body.packs) && packs.body.packs.length === 4,
        "n=" + (packs.body.packs || []).length);

    const editPack = await reqJson(BASE + "/api/colecionaveis/admin/packs/1", json("POST", adminTok, { price: 2.5 }));
    t("editar preço pacote", editPack.r.status === 200 && editPack.body.ok);

    const info = await reqJson(BASE + "/api/colecionaveis/info");
    const precoAtual = (info.body.packs || []).find(p => p.id === 1)?.price;
    t("preço atualizado refletido no /info", precoAtual === 2.5, "preco=" + precoAtual);

    const editPackBad = await reqJson(BASE + "/api/colecionaveis/admin/packs/1", json("POST", adminTok, { price: 0 }));
    t("editar pacote preço inválido -> 400", editPackBad.r.status === 400);

    const togglePack = await reqJson(BASE + "/api/colecionaveis/admin/packs/4", json("POST", adminTok, { is_active: false }));
    t("desativar pacote", togglePack.r.status === 200 && togglePack.body.ok);

    const info2 = await reqJson(BASE + "/api/colecionaveis/info");
    t("pacote inativo some do /info", (info2.body.packs || []).length === 3,
        "n=" + (info2.body.packs || []).length);

    const reactivarPack = await reqJson(BASE + "/api/colecionaveis/admin/packs/4", json("POST", adminTok, { is_active: true }));
    t("reativar pacote", reactivarPack.r.status === 200 && reactivarPack.body.ok);

    const packSemAuth = await reqJson(BASE + "/api/colecionaveis/admin/packs/1", json("POST", null, { price: 9 }));
    t("editar pacote sem token -> 401", packSemAuth.r.status === 401);

    /* ===== Trocas admin (moderação) ===== */
    const trades = await reqJson(BASE + "/api/colecionaveis/admin/trades", json("GET", adminTok));
    t("trades admin shape", trades.r.status === 200 && Array.isArray(trades.body.trades));

    console.log(log.join("\n"));
    console.log("-----------------------------");
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("COLECIONAVEIS ADMIN: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error("ERRO GLOBAL:", e); process.exit(1); });
