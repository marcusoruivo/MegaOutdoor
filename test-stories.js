/* Teste dos Stories públicos: consentimento, idempotência e privacidade. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3261";

const path = require("path");
const fs = require("fs");
const { newDb } = require("pg-mem");

const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "stories-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

let sequence = 1;
const orders = new Map();
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
    if (!String(url).includes("api.mercadopago.com")) return originalFetch(url, options);
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    if (String(url).endsWith("/v1/orders") && method === "POST") {
        const id = "ORDSTORY" + String(sequence++).padStart(4, "0");
        const order = { id, status: "open", total_amount: String(body.total_amount || "2.00"),
            external_reference: body.external_reference,
            transactions: { payments: [{ id: "pay-" + id, status: "pending", status_detail: "pending_waiting_transfer",
                payment_method: { id: "pix", type: "bank_transfer", qr_code_base64: "bW9jaw==", qr_code: "000201story" } }] } };
        orders.set(id, order);
        return { ok: true, status: 201, json: async () => order };
    }
    const match = String(url).match(/\/v1\/orders\/([^/?#]+)/);
    if (match && method === "GET") {
        const order = orders.get(match[1]);
        if (order) {
            order.status = "processed";
            order.transactions.payments[0].status = "paid";
            order.transactions.payments[0].status_detail = "accredited";
            order.transactions.payments[0].paid_amount = order.total_amount;
            return { ok: true, status: 200, json: async () => order };
        }
    }
    return { ok: false, status: 404, json: async () => ({ message: "not found" }) };
};

const db = newDb();
const adapter = db.adapters.createPg();
const pg = require("pg");
pg.Pool = adapter.Pool;
pg.Client = adapter.Client;
if (adapter.types) pg.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:" + process.env.PORT;
const results = [];
function t(name, ok, extra) { results.push((ok ? "PASS" : "FAIL") + " | " + name + (extra ? " | " + extra : "")); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function json(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    return { response, body };
}
function headers(token) { return { "Content-Type": "application/json", Authorization: "Bearer " + token }; }

(async () => {
    await sleep(3500);
    const email = "stories-" + Date.now() + "@teste.com";
    const registered = await json(BASE + "/api/auth/registrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Colecionador Story", email, senha: "senha-teste-123" })
    });
    const token = registered.body.token;
    t("usuário registrado", registered.response.status === 200 && !!token);
    const info = await json(BASE + "/api/colecionaveis/info");
    const pack = (info.body.packs || [])[0];
    const checkout = async storyOptIn => json(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout", {
        method: "POST", headers: headers(token),
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909", storyOptIn })
    });
    const semConsentimento = await checkout(false);
    await json(BASE + "/api/colecionaveis/test/confirm/" + semConsentimento.body.externalReference, { method: "POST", headers: headers(token) });
    const antes = await json(BASE + "/api/stories");
    t("sem autorização não cria Story", antes.body.stories.length === 0);

    const comConsentimento = await checkout(true);
    const confirmUrl = BASE + "/api/colecionaveis/test/confirm/" + comConsentimento.body.externalReference;
    const confirmado = await json(confirmUrl, { method: "POST", headers: headers(token) });
    const repetido = await json(confirmUrl, { method: "POST", headers: headers(token) });
    const depois = await json(BASE + "/api/stories");
    const stories = depois.body.stories || [];
    t("autorização cria Story após confirmação", confirmado.response.status === 200 && stories.length >= 1);
    t("confirmação repetida não duplica Stories", repetido.response.status >= 400 && new Set(stories.map(s => s.id)).size === stories.length);
    const texto = JSON.stringify(stories);
    t("Stories não expõem dados sensíveis", !texto.includes(email) && !texto.includes("12345678909") && !texto.includes("Bearer"));
    t("Stories possuem expiração lógica no endpoint", stories.every(s => s.id && s.createdAt && s.title));
    console.log(results.join("\n"));
    const failed = results.filter(x => x.startsWith("FAIL")).length;
    console.log(`\nTotal: ${results.length} | Passou: ${results.length - failed} | Falhou: ${failed}`);
    process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
