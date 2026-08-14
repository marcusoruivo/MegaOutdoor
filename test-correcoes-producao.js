/* Testes de correção de produção:
   - preços de kits menores que compra separada
   - validação de CPF/CNPJ nos checkouts
   - aceite de regras
   - pagamento de pacotes/cartão
   NÃO faz commit/push/deploy.
*/
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3199";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "correcoes-" + Date.now());
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
        const isCard = body && body.transactions && body.transactions.payments &&
            body.transactions.payments[0] && body.transactions.payments[0].payment_method &&
            body.transactions.payments[0].payment_method.type === "credit_card";
        const order = {
            id, status: "open", external_reference: body.external_reference,
            transactions: { payments: [{ id: "pay-" + id, status: "pending",
                status_detail: "pending_waiting_transfer",
                payment_method: isCard
                    ? { id: "master", type: "credit_card", installments: 1 }
                    : { id: "pix", type: "bank_transfer",
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

const BASE = "http://localhost:3199";
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

    const cpfValido = "12345678909";
    const cpfInvalido = "12345678900";

    /* ===== Admin ===== */
    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    const adminTok = login.body.token || "";

    /* ===== Usuários ===== */
    const email = "corr-test-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Correcao Test", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário comum", !!userTok);

    const email2 = "corr-test-2-" + Date.now() + "@teste.com";
    const reg2 = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Correcao Test 2", email: email2, senha: "senha-teste-123" }));
    const userTok2 = reg2.body.token || "";

    /* ===== 1) Preços dos kits ===== */
    const kitsResp = await reqJson(BASE + "/api/combos/kits", json("GET", null));
    const kits = (kitsResp.body.kits || []);
    t("5 kits retornados", kits.length === 5, "n=" + kits.length);
    t("todos os kits são mais baratos que comprar separado",
        kits.every(k => k.preco < k.precoSeparado),
        JSON.stringify(kits.map(k => ({ slug: k.slug, preco: k.preco, separado: k.precoSeparado, pct: k.pctDesconto }))));

    const starter = kits.find(k => k.slug === "starter");
    const premium = kits.find(k => k.slug === "premium");
    const lendario = kits.find(k => k.slug === "lendario");
    t("starter ~10% desconto", !!starter && starter.pctDesconto >= 8 && starter.pctDesconto <= 12, "pct=" + (starter && starter.pctDesconto));
    t("premium ~15% desconto", !!premium && premium.pctDesconto >= 12 && premium.pctDesconto <= 16, "pct=" + (premium && premium.pctDesconto));
    t("lendario ~18% desconto", !!lendario && lendario.pctDesconto >= 15 && lendario.pctDesconto <= 19, "pct=" + (lendario && lendario.pctDesconto));

    /* ===== 2) Kit checkout: CPF e regras ===== */
    const kitCheckoutBody = (extra) => Object.assign({
        licensePlan: "1_year",
        cpfCnpj: cpfValido,
        paymentMethod: "pix",
        aceiteRegras: true
    }, extra);

    t("kit sem CPF -> 400",
        (await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
            json("POST", userTok, kitCheckoutBody({ cpfCnpj: "" })))).r.status === 400);
    t("kit CPF inválido -> 400",
        (await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
            json("POST", userTok, kitCheckoutBody({ cpfCnpj: cpfInvalido })))).r.status === 400);
    t("kit sem aceite -> 400",
        (await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
            json("POST", userTok, kitCheckoutBody({ aceiteRegras: false })))).r.status === 400);
    const kitOk = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, kitCheckoutBody()));
    t("kit checkout válido -> 200", kitOk.r.status === 200, "status=" + kitOk.r.status);

    /* ===== 3) Pacote checkout: CPF ===== */
    const info = await reqJson(BASE + "/api/colecionaveis/info", json("GET", null));
    const pack = (info.body.packs || [])[0];
    t("pacote disponível", !!pack, "pack=" + (pack && pack.id));

    const packBody = (extra) => Object.assign({ paymentMethod: "pix", cpfCnpj: cpfValido }, extra);
    t("pacote sem CPF -> 400",
        (await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
            json("POST", userTok, packBody({ cpfCnpj: "" })))).r.status === 400);
    t("pacote CPF inválido -> 400",
        (await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
            json("POST", userTok, packBody({ cpfCnpj: cpfInvalido })))).r.status === 400);
    const packOk = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok, packBody()));
    t("pacote checkout válido -> 200", packOk.r.status === 200 && !!packOk.body.qrCodeBase64,
        "status=" + packOk.r.status);

    /* Confirma pagamentos dos pacotes para popular os álbuns. */
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + packOk.body.externalReference,
        json("POST", userTok, {}));
    const packOk2 = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok2, packBody()));
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + packOk2.body.externalReference,
        json("POST", userTok2, {}));

    /* ===== 4) Espaço checkout: CPF e regras ===== */
    const spaceBody = (extra) => Object.assign({
        spaces: [999998],
        name: "Correcao Test",
        email,
        cpfCnpj: cpfValido,
        paymentMethod: "pix",
        licensePlan: "1_year"
    }, extra);
    t("espaço sem CPF -> 400",
        (await reqJson(BASE + "/api/checkout", json("POST", userTok, spaceBody({ cpfCnpj: "" })))).r.status === 400);
    t("espaço CPF inválido -> 400",
        (await reqJson(BASE + "/api/checkout", json("POST", userTok, spaceBody({ cpfCnpj: cpfInvalido })))).r.status === 400);
    t("espaço sem aceite -> 400",
        (await reqJson(BASE + "/api/checkout", json("POST", userTok, spaceBody({ aceiteRegras: false })))).r.status === 400);
    const spaceOk = await reqJson(BASE + "/api/checkout", json("POST", userTok, spaceBody({ aceiteRegras: true })));
    t("espaço checkout válido -> 200", spaceOk.r.status === 200, "status=" + spaceOk.r.status);

    /* ===== 5) Cartão para pacote (campos aceitos) ===== */
    const packCard = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok, packBody({ paymentMethod: "credit_card", cardToken: "tok-mock-123" })));
    t("pacote cartão -> 200 (token aceito)", packCard.r.status === 200,
        "status=" + packCard.r.status + " method=" + (packCard.body && packCard.body.paymentMethod));

    /* ===== 6) Troca com diferença em dinheiro (com CPF) ===== */
    const album = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", userTok));
    const figurinha = (album.body.cards || []).find(c => c.quantidade > 0);
    const album2 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", userTok2));
    const fig2 = (album2.body.cards || []).find(c => c.quantidade > 0 && c.id !== (figurinha && figurinha.id));
    if (figurinha && fig2) {
        const tradeBody = {
            receiverId: undefined,
            ofereco: [{ cardId: figurinha.id }],
            recebo: [{ cardId: fig2.id }],
            cashAmount: 2,
            cashDirection: "proposer_pays"
        };
        // precisamos do id do usuário 2; usamos /auth/me
        const me2 = await reqJson(BASE + "/api/auth/me", json("GET", userTok2));
        tradeBody.receiverId = me2.body.usuario && me2.body.usuario.id;
        const tradeResp = await reqJson(BASE + "/api/colecionaveis/trades", json("POST", userTok, tradeBody));
        if (tradeResp.body && tradeResp.body.tradeId) {
            const acceptNoCpf = await reqJson(BASE + "/api/colecionaveis/trades/" + tradeResp.body.tradeId + "/accept",
                json("POST", userTok2, { paymentMethod: "pix" }));
            t("troca diferença sem CPF -> 400", acceptNoCpf.r.status === 400, "status=" + acceptNoCpf.r.status);
            const acceptOk = await reqJson(BASE + "/api/colecionaveis/trades/" + tradeResp.body.tradeId + "/accept",
                json("POST", userTok2, { paymentMethod: "pix", cpfCnpj: cpfValido }));
            t("troca diferença com CPF -> 200", acceptOk.r.status === 200, "status=" + acceptOk.r.status);
            if (acceptOk.body && acceptOk.body.orderId) {
                // quem paga a diferença é o proposer (userTok)
                await reqJson(BASE + "/api/colecionaveis/test/confirm/" + acceptOk.body.orderId,
                    json("POST", userTok, {}));
            }
        } else {
            t("troca criada", false, "não foi possível criar troca: " + JSON.stringify(tradeResp.body));
        }
    } else {
        t("troca com diferença", false, "usuários sem figurinhas suficientes");
    }

    /* ===== 7) Mercado de figurinhas (com CPF) ===== */
    const albumAposTroca = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", userTok));
    const figVenda = (albumAposTroca.body.cards || []).find(c => c.quantidade > 0);
    if (figVenda) {
        const listBody = { cardId: figVenda.id, preco: 5, quantidade: 1 };
        const listResp = await reqJson(BASE + "/api/colecionaveis/listings", json("POST", userTok, listBody));
        const listingId = listResp.body && listResp.body.id;
        const buyNoCpf = await reqJson(BASE + "/api/colecionaveis/listings/" + listingId + "/buy",
            json("POST", userTok2, { quantidade: 1, paymentMethod: "pix" }));
        t("mercado sem CPF -> 400", buyNoCpf.r.status === 400, "status=" + buyNoCpf.r.status);
        const buyOk = await reqJson(BASE + "/api/colecionaveis/listings/" + listingId + "/buy",
            json("POST", userTok2, { quantidade: 1, paymentMethod: "pix", cpfCnpj: cpfValido }));
        t("mercado com CPF -> 200", buyOk.r.status === 200,
            "status=" + buyOk.r.status + " err=" + (buyOk.body && buyOk.body.error));
    } else {
        t("mercado de figurinhas", false, "nenhuma figurinha no álbum para anunciar");
    }

    console.log(log.join("\n"));
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("-----------------------------");
    console.log("CORREÇÕES PRODUÇÃO: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
