/* =========================================================
   TESTE DE REGRESSÃO — CORREÇÕES DE PIX (Orders API)
   =========================================================
   A) OrderRequest NÃO contém notification_url
   B) X-Idempotency-Key presente
   C) payer.email + payer.identification válidos
   D) resposta do MP é processada corretamente
   E) QR code / copia-e-cola extraídos de payment_method.qr_*
   F) erro do MP não derruba o endpoint (mensagem amigável)
   G) log técnico não vaza email/CPF/token
   H) nova tentativa usa nova idempotency key
   I) pagamento duplicado protegido (idempotente)
   J) kit/combo continua funcionando
   K) compra de espaço continua funcionando
   L) pacote de figurinhas continua funcionando
   M) cartão (credit_card) continua funcionando
   N) webhook /webhooks/mercadopago continua funcionando

   Usa apenas mocks realistas da API do Mercado Pago.
   NÃO faz commit/push/deploy.
========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.PORT = process.env.PORT || "3211";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colpix-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const LOGS_FILE = path.join(process.env.DATA_DIR, "logs.jsonl");
const SPACES_FILE = path.join(process.env.DATA_DIR, "spaces.json");
const PORT = process.env.PORT || "3211";
const BASE = "http://localhost:" + PORT;

/* ---- Mock realista da API Orders do Mercado Pago ---- */
let seq = 1;
const ordersCriadas = new Map();
const pedidos = [];
let falharProximaCriacao = false;

const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) {
        return fetchOriginal(url, options);
    }

    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const idempotencyKey =
        (options.headers || {})["X-Idempotency-Key"] || "";

    if (u.endsWith("/v1/orders") && method === "POST") {
        if (falharProximaCriacao) {
            falharProximaCriacao = false;
            pedidos.push({ body, idempotencyKey, falhou: true });
            return {
                ok: false,
                status: 400,
                json: async () => ({
                    status: 400,
                    error: "unsupported_properties",
                    message: "Properties not supported",
                    cause: [{
                        code: "unsupported_properties",
                        description: "payload invalido: notification_url=https://milhaodoor.com.br/webhooks/mercadopago; email=TEST@EXEMPLO.COM; doc=12345678909; token=APP_USR-FAKETOKEN123",
                        action: "correct_parameter"
                    }]
                })
            };
        }

        const id = String(900000 + seq++);
        const pagamento =
            body.transactions && body.transactions.payments &&
            body.transactions.payments[0];
        const isCard =
            pagamento && pagamento.payment_method &&
            pagamento.payment_method.type === "credit_card";

        const order = {
            id,
            status: "open",
            external_reference: body.external_reference,
            transactions: {
                payments: [{
                    id: "pay-" + id,
                    status: "pending",
                    status_detail: "pending_waiting_transfer",
                    payment_method: isCard
                        ? { id: "master", type: "credit_card", installments: 1 }
                        : {
                            id: "pix",
                            type: "bank_transfer",
                            qr_code_base64: "bW9jaw==",
                            qr_code: "000201mock",
                            ticket_url: "https://mock.local/ticket/" + id
                        }
                }]
            }
        };

        ordersCriadas.set(id, order);
        pedidos.push({ body, idempotencyKey, orderId: id, falhou: false });
        return { ok: true, status: 201, json: async () => order };
    }

    const m = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (m && method === "GET") {
        const id = m[1];
        const order = ordersCriadas.get(id) || {
            id,
            status: "paid",
            external_reference: "mock",
            transactions: { payments: [{ id: "pay-" + id, status: "paid", status_detail: "accredited", payment_method: { id: "pix", type: "bank_transfer", qr_code_base64: "bW9jaw==", qr_code: "000201mock" } }] }
        };
        return {
            ok: true,
            status: 200,
            json: async () => ({ ...order, status: "paid" })
        };
    }

    return { ok: false, status: 404, json: async () => ({ message: "Rota MP não encontrada " + u }) };
};

/* ---- pg-mem antes do require do server ---- */
const { newDb } = require("pg-mem");
const dbmem = newDb();
const adapter = dbmem.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) {
    pgReal.types = adapter.types;
}

require(path.join(__dirname, "server.js"));

/* ---- helpers de teste ---- */
const log = [];
function t(nome, cond, extra) {
    log.push((cond ? "PASS" : "FAIL") + " | " + nome + (extra ? " | " + extra : ""));
}
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

const MSG_FRIENDLY =
    "Não foi possível gerar o PIX agora. Tente novamente em alguns segundos.";

async function main() {
    await sleep(4500);

    const cpfValido = "12345678909";
    const email = "pix-test-" + Date.now() + "@teste.com";

    const login = await reqJson(BASE + "/api/admin/login",
        json("POST", null, { usuario: "admin", senha: "senha123" }));
    const adminTok = (login.body && login.body.token) || "";
    t("login admin", !!adminTok);

    const reg = await reqJson(BASE + "/api/auth/registrar",
        json("POST", null, { nome: "Pix Test", email, senha: "senha-teste-123" }));
    const userTok = (reg.body && reg.body.token) || "";
    t("registro usuário", !!userTok);

    /* L) pacote de figurinhas continua funcionando (PIX) */
    const info = await reqJson(BASE + "/api/colecionaveis/info", json("GET", null));
    const pack = (info.body.packs || [])[0];
    t("pacote disponível", !!pack, "pack=" + (pack && pack.id));
    const packPix = () => ({ paymentMethod: "pix", cpfCnpj: cpfValido });

    const p1 = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok, packPix()));
    t("L) pacote PIX -> 200", p1.r.status === 200,
        "status=" + p1.r.status + " err=" + (p1.body && p1.body.error));

    const pedido1 = pedidos.find(p =>
        !p.falhou && p.body.external_reference === p1.body.externalReference);

    /* A) OrderRequest sem notification_url */
    t("A) OrderRequest sem notification_url",
        !!pedido1 && pedido1.body.notification_url === undefined);
    const keys = pedido1 ? Object.keys(pedido1.body).sort().join(",") : "";
    t("A) chaves top-level do schema",
        keys === "description,external_reference,payer,processing_mode,total_amount,transactions,type",
        "keys=" + keys);

    /* B) X-Idempotency-Key presente */
    t("B) X-Idempotency-Key presente", !!pedido1 && !!pedido1.idempotencyKey,
        "key=" + (pedido1 && pedido1.idempotencyKey));

    /* C) payer válido */
    t("C) payer.email válido",
        !!pedido1 && pedido1.body.payer && pedido1.body.payer.email === email,
        "email=" + (pedido1 && pedido1.body.payer && pedido1.body.payer.email));
    t("C) payer.identification CPF",
        !!pedido1 && pedido1.body.payer && pedido1.body.payer.identification &&
        pedido1.body.payer.identification.type === "CPF" &&
        pedido1.body.payer.identification.number === cpfValido);
    t("C) payer sem first_name/last_name",
        !!pedido1 && pedido1.body.payer &&
        pedido1.body.payer.first_name === undefined &&
        pedido1.body.payer.last_name === undefined);

    /* D) resposta processada corretamente */
    t("D) resposta processada",
        p1.body.ok === true &&
        !!p1.body.orderId &&
        p1.body.externalReference === p1.body.externalReference &&
        !!p1.body.paymentId,
        "orderId=" + p1.body.orderId + " ext=" + p1.body.externalReference +
        " pay=" + p1.body.paymentId);

    /* E) QR / copia-e-cola extraídos de payment_method.qr_* */
    t("E) qrCodeBase64 extraído", p1.body.qrCodeBase64 === "bW9jaw==",
        "qr=" + p1.body.qrCodeBase64);
    t("E) copia-e-cola extraído", p1.body.payload === "000201mock",
        "payload=" + p1.body.payload);
    t("E) ticketUrl extraído",
        !!p1.body.ticketUrl && p1.body.ticketUrl.indexOf("/ticket/") > 0,
        "t=" + p1.body.ticketUrl);

    /* I) proteção contra pagamento duplicado */
    const conf1 = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + p1.body.externalReference,
        json("POST", userTok, {}));
    t("I) confirmação da 1ª vez", conf1.r.status === 200,
        "status=" + conf1.r.status + " body=" + JSON.stringify(conf1.body));

    const albumApos1 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", userTok));
    const total1 = (albumApos1.body.cards || []).reduce((s, c) => s + Number(c.quantidade || 0), 0);

    const conf2 = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + p1.body.externalReference,
        json("POST", userTok, {}));
    const albumApos2 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", userTok));
    const total2 = (albumApos2.body.cards || []).reduce((s, c) => s + Number(c.quantidade || 0), 0);

    t("I) 2ª confirmação rejeitada (idempotente)", conf2.r.status === 400,
        "status=" + conf2.r.status);
    t("I) figurinhas não duplicadas", total1 === total2, "t1=" + total1 + " t2=" + total2);
    t("I) quantidade do pacote entregue na 1ª vez",
        total1 === Number(pack.sticker_quantity),
        "total=" + total1 + " esperado=" + pack.sticker_quantity);

    /* F) erro do MP não derruba o endpoint */
    falharProximaCriacao = true;
    const pErr = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok, packPix()));
    t("F) erro MP -> 500 sem crash", pErr.r.status === 500, "status=" + pErr.r.status);
    t("F) mensagem amigável ao usuário", pErr.body.error === MSG_FRIENDLY,
        "err=" + pErr.body.error);

    /* G) log técnico não vaza segredos */
    const logsTxt = fs.readFileSync(LOGS_FILE, "utf8");
    const linhaErro = (logsTxt.split("\n").find(l => l.indexOf("mercadopago_erro") > 0)) || "";
    t("G) log mercadopago_erro gravado", linhaErro !== "");
    t("G) log sem e-mail", linhaErro.indexOf("TEST@EXEMPLO.COM") < 0);
    t("G) log sem CPF", linhaErro.indexOf("12345678909") < 0);
    t("G) log sem token do MP", linhaErro.indexOf("APP_USR-FAKETOKEN123") < 0);
    const respErro = JSON.stringify(pErr.body);
    t("G) resposta sem vazar segredos",
        respErro.indexOf("TEST@EXEMPLO.COM") < 0 &&
        respErro.indexOf("APP_USR-FAKETOKEN123") < 0);

    /* H) nova tentativa usa nova idempotency key */
    const p2 = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok, packPix()));
    const pedido2 = pedidos.find(p =>
        !p.falhou && p.body.external_reference === p2.body.externalReference);
    const chaves = pedidos.map(p => p.idempotencyKey);
    t("H) chave única por tentativa",
        new Set(chaves).size === chaves.length,
        "tentativas=" + chaves.length + " unicas=" + new Set(chaves).size);
    t("H) tentativa que falhou usou chave própria",
        !!pedido1 && pedido1.idempotencyKey !==
        ((pedidos.find(p => p.falhou) || {}).idempotencyKey));
    t("H) sucesso posterior usa chave diferente",
        !!pedido1 && !!pedido2 && pedido1.idempotencyKey !== pedido2.idempotencyKey);

    /* J) kit/combo continua funcionando */
    const kits = await reqJson(BASE + "/api/combos/kits", json("GET", null));
    const kit = ((kits.body.kits || []).find(k => k.nivel === "premium")) ||
        (kits.body.kits || [])[0];
    t("kit disponível", !!kit, "kit=" + (kit && kit.id));
    const kitRes = await reqJson(BASE + "/api/combos/kits/" + kit.id + "/checkout",
        json("POST", userTok,
            { paymentMethod: "pix", cpfCnpj: cpfValido, aceiteRegras: true, licensePlan: "1_year" }));
    t("J) kit PIX -> 200", kitRes.r.status === 200,
        "status=" + kitRes.r.status + " err=" + (kitRes.body && kitRes.body.error));
    t("J) kit devolve QR/copia-e-cola",
        kitRes.body.qrCodeBase64 === "bW9jaw==" && kitRes.body.payload === "000201mock");

    /* K) compra de espaço continua funcionando */
    const espRes = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [999995], aceiteRegras: true, name: "Pix Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    t("K) espaço PIX -> 200", espRes.r.status === 200,
        "status=" + espRes.r.status + " err=" + (espRes.body && espRes.body.error));
    t("K) espaço devolve QR/copia-e-cola",
        espRes.body.qrCode === "bW9jaw==" && espRes.body.payload === "000201mock");

    /* M) cartão (credit_card) continua funcionando */
    const cardRes = await reqJson(BASE + "/api/colecionaveis/packs/" + pack.id + "/checkout",
        json("POST", userTok,
            { paymentMethod: "credit_card", cpfCnpj: cpfValido, cardToken: "card_tok_teste" }));
    const pedidoCard = pedidos.filter(p =>
        p.body.transactions && p.body.transactions.payments &&
        p.body.transactions.payments[0].payment_method &&
        p.body.transactions.payments[0].payment_method.type === "credit_card"
    ).pop();
    t("M) cartão -> 200", cardRes.r.status === 200,
        "status=" + cardRes.r.status + " err=" + (cardRes.body && cardRes.body.error));
    t("M) request cartão com token",
        !!pedidoCard &&
        pedidoCard.body.transactions.payments[0].payment_method.token === "card_tok_teste");
    t("M) request cartão sem notification_url",
        !!pedidoCard && pedidoCard.body.notification_url === undefined);

    /* N) webhook continua funcionando (formato oficial da API Orders:
       POST /webhooks/mercadopago?data.id=<id>&type=order) */
    const espRes2 = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [999996], aceiteRegras: true, name: "Pix Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    t("N) espaço reservado (pré-webhook)", espRes2.r.status === 200,
        "status=" + espRes2.r.status + " mpOrderId=" + espRes2.body.mpOrderId);

    const dataId = String(espRes2.body.mpOrderId);
    const evento = { type: "order", data: { id: dataId } };
    const urlWebhook = BASE + "/webhooks/mercadopago?data.id=" + dataId + "&type=order";
    const assinatura = (idManifest, ts, rid) => {
        const manifest = "id:" + idManifest + ";request-id:" + rid + ";ts:" + ts + ";";
        return crypto
            .createHmac("sha256", process.env.MERCADOPAGO_WEBHOOK_SECRET)
            .update(manifest)
            .digest("hex");
    };

    /* Sem assinatura -> 401. */
    const wErr = await reqJson(urlWebhook, json("POST", null, evento));
    t("N) assinatura ausente -> 401", wErr.r.status === 401, "status=" + wErr.r.status);

    /* Assinatura com data.id ERRADO (divergente do query) -> 401:
       prova que a validação usa o query parameter data.id. */
    const tsErrado = Math.floor(Date.now() / 1000);
    const ridErrado = "teste-request-errado-" + Date.now();
    const wErrado = await reqJson(urlWebhook, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsErrado + ",v1=" + assinatura("999999", tsErrado, ridErrado),
            "x-request-id": ridErrado
        },
        body: JSON.stringify(evento)
    });
    t("N) assinatura com id errado -> 401",
        wErrado.r.status === 401, "status=" + wErrado.r.status);

    /* Assinatura oficial com o query data.id -> 200 + liberação. */
    const ts = Math.floor(Date.now() / 1000);
    const rid = "teste-request-" + Date.now();
    const wOk = await reqJson(urlWebhook, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + ts + ",v1=" + assinatura(dataId, ts, rid),
            "x-request-id": rid
        },
        body: JSON.stringify(evento)
    });
    t("N) assinatura válida -> 200 received",
        wOk.r.status === 200 && wOk.body.received === true,
        "status=" + wOk.r.status + " body=" + JSON.stringify(wOk.body));

    await sleep(700);
    const dbEsp = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("N) espaço pago via webhook",
        dbEsp["999996"] && dbEsp["999996"].status === "paid",
        "status=" + (dbEsp["999996"] && dbEsp["999996"].status));

    /* Repetição do mesmo webhook (idempotente) não quebra nada. */
    const ts2 = Math.floor(Date.now() / 1000);
    const rid2 = "teste-request-repetido-" + Date.now();
    const wRep = await reqJson(urlWebhook, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + ts2 + ",v1=" + assinatura(dataId, ts2, rid2),
            "x-request-id": rid2
        },
        body: JSON.stringify(evento)
    });
    t("N) repetição do webhook idempotente",
        wRep.r.status === 200, "status=" + wRep.r.status);

    /* ---- resultado ---- */
    const falhas = log.filter(l => l.startsWith("FAIL"));
    console.log("\n=== RESULTADO test-col-pix ===");
    for (const l of log) {
        console.log(l);
    }
    console.log("\n" + (log.length - falhas.length) + "/" + log.length + " PASS");
    if (falhas.length) {
        console.log("FALHAS:\n" + falhas.join("\n"));
        process.exit(1);
    }
    console.log("OK");
    process.exit(0);
}

main().catch(e => {
    console.error("ERRO no teste:", e);
    process.exit(1);
});
