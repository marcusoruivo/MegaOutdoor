/* Valida a matemática dos combos/kits e o detalhamento dos pacotes. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3291";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colcombopreco-" + Date.now());
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

const BASE = "http://localhost:3291";
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

    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    t("login admin ok", login.r.status === 200 && !!login.body.token);

    const email = "combo-preco-test-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Combo Preco Test", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário", !!userTok);

    const kits = await reqJson(BASE + "/api/combos/kits", json("GET", userTok));
    const lista = kits.body.kits || [];
    t("kits retornam detalhamento", lista.length > 0 && lista.every(k => Array.isArray(k.packageSummary)));

    let todosMaisBaratos = true;
    for (const k of lista) {
        const avulso = Number(k.spacesPrice) + Number(k.packsPrice);
        const final = Number(k.preco);
        if (!(final < avulso)) {
            todosMaisBaratos = false;
            console.log("COMBO PRECO ERRO:", k.slug, "final", final, "avulso", avulso);
        }
    }
    t("todos os combos são mais baratos que avulso", todosMaisBaratos);

    const starter = lista.find(k => k.slug === "starter");
    t("starter: 3 espaços, 1 bronze, desconto 10%",
        starter && starter.espacos === 3 &&
        starter.packageSummary.length === 1 &&
        starter.packageSummary[0].pack_slug === "bronze" &&
        starter.packageSummary[0].quantidade === 1 &&
        starter.discountPercent === 10 &&
        starter.spacesPrice === 3 &&
        starter.preco === 4.5,
        JSON.stringify(starter && starter.packageSummary));

    const premium = lista.find(k => k.slug === "premium");
    t("premium: detalhamento dos pacotes (ouro + prata)",
        premium && premium.packageSummary.length >= 2 &&
        premium.packageSummary.some(p => p.pack_slug === "ouro") &&
        premium.packageSummary.some(p => p.pack_slug === "prata"),
        JSON.stringify(premium && premium.packageSummary));

    const mega = lista.find(k => k.slug === "mega");
    t("mega: total de figurinhas computado", mega && mega.totalCards > 0, "totalCards=" + (mega && mega.totalCards));

    t("todos os kits expõem spacesPrice e packsPrice",
        lista.every(k => typeof k.spacesPrice === "number" && typeof k.packsPrice === "number"));

    console.log("\n=== RESULTADO test-col-combos-precos ===");
    let pass = 0, fail = 0;
    for (const linha of log) {
        console.log(linha);
        if (linha.startsWith("PASS")) pass++; else fail++;
    }
    console.log("\nTotal: " + log.length + " | Passou: " + pass + " | Falhou: " + fail);
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error("ERRO DE TESTE:", err); process.exit(1); });
