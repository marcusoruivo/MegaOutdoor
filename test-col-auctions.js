/* Teste isolado do fluxo de leilões, sem confirmar checkout. */
process.env.DATABASE_URL = "postgres://memoria-auctions";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = "3291";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colauctions-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const orders = new Map();
let sequence = 1;
const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) return fetchOriginal(url, options);
    const body = options.body ? JSON.parse(options.body) : {};
    if (u.endsWith("/v1/orders") && (options.method || "GET").toUpperCase() === "POST") {
        const id = String(910000 + sequence++);
        const order = { id, status: "open", external_reference: body.external_reference,
            transactions: { payments: [{ id: "pay-" + id, status: "pending", status_detail: "pending_waiting_transfer",
                payment_method: { id: "pix", type: "bank_transfer", qr_code_base64: "bW9jaw==", qr_code: "000201mock", ticket_url: "https://mock.local/" + id } }] } };
        orders.set(id, order);
        return { ok: true, status: 201, json: async () => order };
    }
    const match = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (match && (options.method || "GET").toUpperCase() === "GET") {
        const order = orders.get(match[1]);
        return order ? { ok: true, status: 200, json: async () => order } : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
};

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();
const pg = require("pg");
pg.Pool = adapter.Pool;
pg.Client = adapter.Client;
if (adapter.types) pg.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:3291";
const checks = [];
function check(name, condition, detail) { checks.push((condition ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : "")); }
const json = (method, token, body) => ({ method, headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
async function request(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = {}; }
    return { response, body };
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
    await wait(4500);
    const stamp = Date.now();
    const seller = await request(BASE + "/api/auth/registrar", json("POST", null, { nome: "Vendedor Leilao", email: "seller-auction-" + stamp + "@teste.com", senha: "senha-teste-123" }));
    const bidder = await request(BASE + "/api/auth/registrar", json("POST", null, { nome: "Licitante Leilao", email: "bidder-auction-" + stamp + "@teste.com", senha: "senha-teste-123" }));
    const sellerToken = seller.body.token;
    const bidderToken = bidder.body.token;
    check("usuários de teste registrados", !!sellerToken && !!bidderToken);

    const info = await request(BASE + "/api/colecionaveis/info", json("GET", sellerToken));
    const pack = (info.body.packs || [])[0];
    const checkout = await request(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout", json("POST", sellerToken, { paymentMethod: "pix", cpfCnpj: "12345678909" }));
    const external = checkout.body.externalReference;
    await request(BASE + "/api/colecionaveis/test/confirm/" + external, json("POST", sellerToken));
    const order = orders.get(String(checkout.body.orderId));
    order.status = "paid";
    order.transactions.payments[0].status = "paid";
    order.transactions.payments[0].status_detail = "accredited";
    const paid = await request(BASE + "/api/colecionaveis/pagamento/" + external, json("GET", sellerToken));
    await request(BASE + "/api/colecionaveis/packs/purchases/" + paid.body.pacote.purchaseId + "/open", json("POST", sellerToken, {}));
    const acervo = await request(BASE + "/api/colecionaveis/acervo", json("GET", sellerToken));
    const card = (acervo.body.cards || [])[0];
    check("figurinha possuída disponível para o teste", !!card && card.id);

    const created = await request(BASE + "/api/colecionaveis/auctions", json("POST", sellerToken, { cardId: card.id, minimumBid: 2.5 }));
    const auctionId = created.body.auctionId;
    check("cria leilão e reserva a unidade", created.response.status === 201 && created.body.reserved === true);

    const listing = await request(BASE + "/api/colecionaveis/listings", json("POST", sellerToken, { cardId: card.id, quantidade: 1, preco: 1 }));
    check("reserva impede anunciar a mesma unidade", listing.response.status === 400);

    const bid = await request(BASE + "/api/colecionaveis/auctions/" + auctionId + "/bids", json("POST", bidderToken, { amount: 2.5 }));
    check("registra lance mínimo sem criar pagamento", bid.response.status === 201 && bid.body.paymentStatus === "not_applicable");
    const closed = await request(BASE + "/api/colecionaveis/auctions/" + auctionId + "/close", json("POST", sellerToken, {}));
    check("encerra com vencedor em pagamento pendente", closed.response.status === 200 && closed.body.status === "payment_pending" && closed.body.paymentStatus === "pending");

    const mine = await request(BASE + "/api/colecionaveis/auctions/mine", json("GET", sellerToken));
    check("lista estado do vencedor e reserva", mine.response.status === 200 && mine.body.auctions[0]?.status === "payment_pending", "status=" + mine.response.status);

    console.log("\n=== RESULTADO test-col-auctions ===");
    let failures = 0;
    for (const line of checks) { console.log(line); if (line.startsWith("FAIL")) failures++; }
    process.exit(failures ? 1 : 0);
}
main().catch(error => { console.error("ERRO DE TESTE:", error); process.exit(1); });
