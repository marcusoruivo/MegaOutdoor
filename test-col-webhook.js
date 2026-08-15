/* =========================================================
   TESTE DEDICADO — WEBHOOK MERCADO PAGO (API Orders)
   =========================================================
   1) assinatura válida   -> 200 received + espaço pago
   2) assinatura inválida -> 401 (HMAC errado)
   3) assinatura ausente  -> 401
   4) data.id vindo da QUERY string (autoritativo, não o corpo)
   5) webhook duplicado   -> idempotente (sem duplicar)

   Formato oficial: POST /webhooks/mercadopago?data.id=<id>&type=order
   com headers x-signature (ts=...,v1=...) e x-request-id.

   NÃO faz commit/push/deploy.
========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.PORT = process.env.PORT || "3222";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colwebhook-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const SPACES_FILE = path.join(process.env.DATA_DIR, "spaces.json");
const PORT = process.env.PORT || "3222";
const BASE = "http://localhost:" + PORT;

/* ---- Mock da API Orders do Mercado Pago ---- */
let seq = 1;
const ordersCriadas = new Map();

const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) {
        return fetchOriginal(url, options);
    }

    const method = (options.method || "GET").toUpperCase();

    if (u.endsWith("/v1/orders") && method === "POST") {
        const body = options.body ? JSON.parse(options.body) : null;
        const id = "ORD01" + String(seq++).padStart(6, "0");
        const order = {
            id,
            status: "open",
            external_reference: body.external_reference,
            transactions: {
                payments: [{
                    id: "pay-" + id,
                    status: "pending",
                    status_detail: "pending_waiting_transfer",
                    payment_method: {
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
        return { ok: true, status: 201, json: async () => order };
    }

    const m = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (m && method === "GET") {
        const id = m[1];
        const order = ordersCriadas.get(id) || {
            id,
            status: "paid",
            external_reference: "mock",
            transactions: { payments: [{ id: "pay-" + id, status: "paid", status_detail: "accredited", payment_method: { id: "pix", type: "bank_transfer" } }] }
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

/* ---- helpers ---- */
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

const SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET;
const assinar = (idManifest, ts, rid) => {
    const manifest = "id:" + idManifest + ";request-id:" + rid + ";ts:" + ts + ";";
    return crypto.createHmac("sha256", SECRET).update(manifest).digest("hex");
};

async function main() {
    await sleep(4500);

    const cpfValido = "12345678909";
    const email = "webhook-test-" + Date.now() + "@teste.com";

    const reg = await reqJson(BASE + "/api/auth/registrar",
        json("POST", null, { nome: "Webhook Test", email, senha: "senha-teste-123" }));
    const userTok = (reg.body && reg.body.token) || "";
    t("registro usuário", !!userTok);

    const espId = 999988;
    const checkout = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espId], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    t("espaço reservado (pré-webhook)", checkout.r.status === 200,
        "status=" + checkout.r.status + " mpOrderId=" + checkout.body.mpOrderId);

    t("checkout pendente (PIX) NÃO devolve accessCode",
        !checkout.body.accessCode,
        "accessCode=" + JSON.stringify(checkout.body.accessCode));

    const dataId = String(checkout.body.mpOrderId);
    const evento = { type: "order", data: { id: dataId } };
    const url = BASE + "/webhooks/mercadopago?data.id=" + dataId + "&type=order";

    /* 3) assinatura ausente -> 401 */
    const wSem = await reqJson(url, json("POST", null, evento));
    t("3) assinatura ausente -> 401", wSem.r.status === 401, "status=" + wSem.r.status);

    /* 2) assinatura inválida (HMAC com secret errado) -> 401 */
    const tsInv = Math.floor(Date.now() / 1000);
    const ridInv = "req-invalida-" + Date.now();
    const hmacInv = crypto.createHmac("sha256", "secret-errado").update(
        "id:" + dataId + ";request-id:" + ridInv + ";ts:" + tsInv + ";"
    ).digest("hex");
    const wInv = await reqJson(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsInv + ",v1=" + hmacInv,
            "x-request-id": ridInv
        },
        body: JSON.stringify(evento)
    });
    t("2) assinatura inválida -> 401", wInv.r.status === 401, "status=" + wInv.r.status);

    /* 4) data.id da query é autoritativo:
       assinatura com data.id do CORPO (diferente do query) -> 401 */
    const tsBody = Math.floor(Date.now() / 1000);
    const ridBody = "req-corpo-" + Date.now();
    const wBody = await reqJson(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsBody + ",v1=" + assinar("999999", tsBody, ridBody),
            "x-request-id": ridBody
        },
        body: JSON.stringify(evento)
    });
    t("4) data.id do corpo (divergente) -> 401", wBody.r.status === 401,
        "status=" + wBody.r.status);

    /* 8) simulação do painel do Mercado Pago (data.id=123456): assinatura
       VÁLIDA, mas sem formato de Order real -> 200 simulation:true, SEM
       consultar /v1/orders/123456 (evita "path param order id is invalid"). */
    const urlSim = BASE + "/webhooks/mercadopago?data.id=123456&type=order";
    const tsSim = Math.floor(Date.now() / 1000);
    const ridSim = "req-sim-" + Date.now();
    const wSim = await reqJson(urlSim, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsSim + ",v1=" + assinar("123456", tsSim, ridSim),
            "x-request-id": ridSim
        },
        body: JSON.stringify({ type: "order", data: { id: "123456" } })
    });
    t("8) simulação (data.id=123456) -> 200 simulation:true",
        wSim.r.status === 200 && wSim.body.simulation === true,
        "status=" + wSim.r.status + " body=" + JSON.stringify(wSim.body));

    /* 8b) identificador sem formato de Order (ex.: texto livre) também é
       tratado como simulação/teste, sem consultar a API. */
    const urlTexto = BASE + "/webhooks/mercadopago?data.id=texto-livre&type=order";
    const tsTexto = Math.floor(Date.now() / 1000);
    const ridTexto = "req-texto-" + Date.now();
    const wTexto = await reqJson(urlTexto, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsTexto + ",v1=" + assinar("texto-livre", tsTexto, ridTexto),
            "x-request-id": ridTexto
        },
        body: JSON.stringify({ type: "order", data: { id: "texto-livre" } })
    });
    t("8b) id sem formato de Order -> 200 simulation:true",
        wTexto.r.status === 200 && wTexto.body.simulation === true,
        "status=" + wTexto.r.status + " body=" + JSON.stringify(wTexto.body));

    /* 1) assinatura válida (query data.id + secret correto) -> 200 + pago */
    const tsOk = Math.floor(Date.now() / 1000);
    const ridOk = "req-valida-" + Date.now();
    const wOk = await reqJson(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsOk + ",v1=" + assinar(dataId, tsOk, ridOk),
            "x-request-id": ridOk
        },
        body: JSON.stringify(evento)
    });
    t("1) assinatura válida -> 200 received",
        wOk.r.status === 200 && wOk.body.received === true,
        "status=" + wOk.r.status + " body=" + JSON.stringify(wOk.body));

    await sleep(700);
    const dbEsp = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("1) espaço pago via webhook",
        dbEsp[String(espId)] && dbEsp[String(espId)].status === "paid",
        "status=" + (dbEsp[String(espId)] && dbEsp[String(espId)].status));

    /* approved: o polling (consulta real do MP) devolve o accessCode */
    const poll = await reqJson(BASE + "/api/payment-status/" + dataId, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    t("approved: payment-status RECEIVED + accessCode",
        poll.r.status === 200 &&
        poll.body.status === "RECEIVED" &&
        /^MEGA-[A-F0-9-]{16,}$/.test(poll.body.accessCode || ""),
        "status=" + poll.r.status + " st=" + poll.body.status +
        " code=" + JSON.stringify(poll.body.accessCode));

    const poll2 = await reqJson(BASE + "/api/payment-status/" + dataId, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    t("approved: polling repetido devolve o MESMO código",
        poll2.body.accessCode === poll.body.accessCode,
        "igual=" + (poll2.body.accessCode === poll.body.accessCode));

    const rest = await reqJson(BASE + "/api/restore",
        json("POST", null, { accessCode: poll.body.accessCode }));
    t("approved: código retornado restaura o espaço (mesmo código do pedido)",
        rest.r.status === 200 &&
        Array.isArray(rest.body.spaces) &&
        rest.body.spaces.some(s => Number(s.id) === espId),
        "status=" + rest.r.status + " espaços=" + JSON.stringify(rest.body.spaces));

    /* 5) webhook duplicado -> idempotente (200, sem duplicar/erro) */
    const paidAt1 = dbEsp[String(espId)] && dbEsp[String(espId)].paidAt;
    const tsDup = Math.floor(Date.now() / 1000);
    const ridDup = "req-duplicada-" + Date.now();
    const wDup = await reqJson(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsDup + ",v1=" + assinar(dataId, tsDup, ridDup),
            "x-request-id": ridDup
        },
        body: JSON.stringify(evento)
    });
    t("5) webhook duplicado -> 200", wDup.r.status === 200, "status=" + wDup.r.status);

    await sleep(700);
    const dbEsp2 = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("5) duplicado não altera o espaço",
        dbEsp2[String(espId)] && dbEsp2[String(espId)].status === "paid" &&
        dbEsp2[String(espId)].paidAt === paidAt1,
        "status=" + (dbEsp2[String(espId)] && dbEsp2[String(espId)].status));

    /* ---- resultado ---- */
    const falhas = log.filter(l => l.startsWith("FAIL"));
    console.log("\n=== RESULTADO test-col-webhook ===");
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
