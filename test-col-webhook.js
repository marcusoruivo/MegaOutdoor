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
const ordersInexistentes = new Set();

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
            total_amount: body && body.total_amount ? String(body.total_amount) : "1.00",
            external_reference: body && body.external_reference,
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
        if (id.startsWith("ORD404")) {
            return {
                ok: false,
                status: 404,
                json: async () => ({
                    message: "Order not found",
                    status: 404,
                    error: "not_found"
                })
            };
        }
        if (ordersInexistentes.has(id)) {
            return {
                ok: false,
                status: 404,
                json: async () => ({
                    message: "Order not found",
                    status: 404,
                    error: "not_found"
                })
            };
        }
        const ordGet = ordersCriadas.get(id);
        if (ordGet && ordGet._autoConfirm === false) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ...ordGet,
                    total_amount: ordGet.total_amount || "1.00"
                })
            };
        }
        const order = ordersCriadas.get(id) || {
            id,
            status: "paid",
            total_amount: "1.00",
            external_reference: "mock",
            transactions: { payments: [{ id: "pay-" + id, status: "paid", status_detail: "accredited", payment_method: { id: "pix", type: "bank_transfer" } }] }
        };
        return {
            ok: true,
            status: 200,
            json: async () => ({
                ...order,
                status: order.status === "open" ? "paid" : order.status,
                total_amount: order.total_amount || "1.00"
            })
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
/* Assina como o Mercado Pago ASSINA: o data.id é normalizado para MINÚSCULO
   no manifesto (o MP entrega ORD... em MAIÚSCULO na query, mas assina com
   o id em minúsculo). */
const assinar = (idManifest, ts, rid) => {
    const manifest = "id:" + String(idManifest).toLowerCase() +
        ";request-id:" + rid + ";ts:" + ts + ";";
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

    /* 20) WEBHOOK REAL DE ORDER (formato de produção): corpo COMPLETO do
       Mercado Pago (type, action, live_mode, application_id, data.id),
       assinatura calculada SOMENTE sobre
       id:<query data.id>;request-id:<x-request-id>;ts:<ts>;
       (campos extras NÃO entram no manifesto oficial) -> 200 + espaço pago. */
    const espReal = 999984;
    const checkoutReal = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espReal], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdReal = String(checkoutReal.body.mpOrderId);
    const tsReal = Math.floor(Date.now() / 1000);
    const ridReal = "req-real-order-" + Date.now();
    const corpoReal = {
        type: "order",
        action: "order.action_required",
        live_mode: true,
        application_id: 123456789,
        user_id: 987654321,
        api_version: "v1",
        date_created: new Date().toISOString(),
        data: { id: dataIdReal }
    };
    const wReal = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdReal + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsReal + ",v1=" + assinar(dataIdReal, tsReal, ridReal),
                "x-request-id": ridReal
            },
            body: JSON.stringify(corpoReal)
        });
    await sleep(700);
    const dbReal = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("20) webhook REAL de Order (corpo completo) -> 200 + espaço pago",
        wReal.r.status === 200 && wReal.body.received === true &&
        dbReal[String(espReal)] && dbReal[String(espReal)].status === "paid",
        "status=" + wReal.r.status + " body=" + JSON.stringify(wReal.body) +
        " espaço=" + (dbReal[String(espReal)] && dbReal[String(espReal)].status));

    /* 21) CORREÇÃO HMAC APLICADA: o Mercado Pago ENTREGA data.id=ORD... em
       MAIÚSCULO na query, mas ASSINA o manifesto com o data.id em MINÚSCULO.
       O validador normaliza o data.id para lowercase antes do HMAC ->
       notificação REAL agora é VÁLIDA: 200 received + espaço pago. */
    const espCase = 999983;
    const checkoutCase = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espCase], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdCase = String(checkoutCase.body.mpOrderId);
    const tsCase = Math.floor(Date.now() / 1000);
    const ridCase = "req-case-" + Date.now();
    const assinaturaMpLower = (id, ts, rid) => {
        const m = "id:" + String(id).toLowerCase() + ";request-id:" + rid + ";ts:" + ts + ";";
        return crypto.createHmac("sha256", SECRET).update(m).digest("hex");
    };
    const wCase = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdCase + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsCase + ",v1=" + assinaturaMpLower(dataIdCase, tsCase, ridCase),
                "x-request-id": ridCase
            },
            body: JSON.stringify({
                type: "order", action: "order.action_required", live_mode: true,
                data: { id: dataIdCase }
            })
        });
    await sleep(700);
    const dbCase = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("21) CORREÇÃO: notificação real (data.id minúsculo no manifesto) -> 200 + espaço pago",
        wCase.r.status === 200 && wCase.body.received === true &&
        dbCase[String(espCase)] && dbCase[String(espCase)].status === "paid",
        "status=" + wCase.r.status + " body=" + JSON.stringify(wCase.body) +
        " espaço=" + (dbCase[String(espCase)] && dbCase[String(espCase)].status));

    /* 23) REGRESSÃO: assinatura com data.id em MAIÚSCULO no manifesto
       (como o validador ANTIGO fazia) -> 401. O validador agora normaliza
       para lowercase; a assinatura deve ser a do MP (id minúsculo). */
    const tsUpper = Math.floor(Date.now() / 1000);
    const ridUpper = "req-upper-" + Date.now();
    const assinaturaMpUpper = (id, ts, rid) => {
        const m = "id:" + id + ";request-id:" + rid + ";ts:" + ts + ";";
        return crypto.createHmac("sha256", SECRET).update(m).digest("hex");
    };
    const wUpper = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdCase + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsUpper + ",v1=" + assinaturaMpUpper(dataIdCase, tsUpper, ridUpper),
                "x-request-id": ridUpper
            },
            body: JSON.stringify({
                type: "order", action: "order.action_required", live_mode: true,
                data: { id: dataIdCase }
            })
        });
    t("23) REGRESSÃO: assinatura com data.id MAIÚSCULO no manifesto -> 401",
        wUpper.r.status === 401,
        "status=" + wUpper.r.status + " (validador exige id minúsculo no manifesto)");

    /* 24) ORDER REAL (ID exato da notificação real de produção):
       ORD01M0253SXFMB7N4T2RWDYKANH — ID alfanumérico documentado pelo MP.
       NÃO pode ser tratado como simulação/teste: reconhecemos como Order
       real, consultamos a API (mock) e liberamos o espaço. */
    const espRealId = 999981;
    const checkoutRealId = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espRealId], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const ordemRealId = "ORD01M0253SXFMB7N4T2RWDYKANH";
    const dbRealId = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    const extRefReal = dbRealId[String(espRealId)] && dbRealId[String(espRealId)].orderId;
    dbRealId[String(espRealId)].mpOrderId = ordemRealId;
    fs.writeFileSync(SPACES_FILE, JSON.stringify(dbRealId));
    ordersCriadas.set(ordemRealId, {
        id: ordemRealId,
        status: "paid",
        total_amount: "1.00",
        external_reference: extRefReal,
        transactions: {
            payments: [{
                id: "pay-" + ordemRealId,
                status: "paid",
                status_detail: "accredited",
                payment_method: { id: "pix", type: "bank_transfer" }
            }]
        }
    });
    const tsRealId = Math.floor(Date.now() / 1000);
    const ridRealId = "req-real-id-" + Date.now();
    const wRealId = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + ordemRealId + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsRealId + ",v1=" + assinar(ordemRealId, tsRealId, ridRealId),
                "x-request-id": ridRealId
            },
            body: JSON.stringify({
                type: "order", action: "order.action_required", live_mode: true,
                data: { id: ordemRealId }
            })
        });
    await sleep(700);
    const dbRealId2 = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("24) ORDER REAL (ORD01M0253SXFMB7N4T2RWDYKANH) -> consultada + espaço pago",
        wRealId.r.status === 200 && wRealId.body.received === true &&
        wRealId.body.simulation !== true &&
        dbRealId2[String(espRealId)] &&
        dbRealId2[String(espRealId)].status === "paid",
        "status=" + wRealId.r.status + " body=" + JSON.stringify(wRealId.body) +
        " espaço=" + (dbRealId2[String(espRealId)] && dbRealId2[String(espRealId)].status));

    /* 25) SIMULAÇÃO do painel do MP (dataId=5555, como na simulação antiga):
       sem prefixo ORD -> 200 simulation:true, SEM consultar a API. */
    const url5555 = BASE + "/webhooks/mercadopago?data.id=5555&type=order";
    const ts5555 = Math.floor(Date.now() / 1000);
    const rid5555 = "req-5555-" + Date.now();
    const w5555 = await reqJson(url5555, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + ts5555 + ",v1=" + assinar("5555", ts5555, rid5555),
            "x-request-id": rid5555
        },
        body: JSON.stringify({ type: "order", data: { id: "5555" } })
    });
    t("25) simulação (dataId=5555) -> 200 simulation:true (sem consultar API)",
        w5555.r.status === 200 && w5555.body.simulation === true,
        "status=" + w5555.r.status + " body=" + JSON.stringify(w5555.body));

    /* 26) Order INEXISTENTE (formato ORD real, mas a API responde 404):
       fluxo NÃO encerra como simulação — consulta a API, registra o erro e
       devolve 200 received, sem liberar espaço e sem quebrar. */
    const ordemInexistente = "ORD404NEXISTENTE00000000000000";
    const tsInex = Math.floor(Date.now() / 1000);
    const ridInex = "req-inex-" + Date.now();
    const wInex = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + ordemInexistente + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsInex + ",v1=" + assinar(ordemInexistente, tsInex, ridInex),
                "x-request-id": ridInex
            },
            body: JSON.stringify({ type: "order", data: { id: ordemInexistente } })
        });
    t("26) Order inexistente (404) -> 200 received, sem simulação e sem liberar",
        wInex.r.status === 200 && wInex.body.received === true &&
        wInex.body.simulation !== true,
        "status=" + wInex.r.status + " body=" + JSON.stringify(wInex.body));

    /* 27) Order ORD em MINÚSCULO também é Order real (não é simulação):
       o reconhecimento não depende de caixa alta. */
    const ordemLower = "ord01testelowercase000000000000";
    const tsLower = Math.floor(Date.now() / 1000);
    const ridLower = "req-lower-" + Date.now();
    const wLower = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + ordemLower + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsLower + ",v1=" + assinar(ordemLower, tsLower, ridLower),
                "x-request-id": ridLower
            },
            body: JSON.stringify({ type: "order", data: { id: ordemLower } })
        });
    t("27) ORD minúsculo -> Order real (não é simulação)",
        wLower.r.status === 200 && wLower.body.received === true &&
        wLower.body.simulation !== true,
        "status=" + wLower.r.status + " body=" + JSON.stringify(wLower.body));

    /* =====================================================
       BOTÃO "JÁ PAGUEI O PIX" — GET /api/payment-status/:id
       O backend consulta o Mercado Pago, valida posse, valor e
       external_reference e só então marca como pago (idempotente).
       ===================================================== */

    const email2 = "webhook-btn-" + Date.now() + "@teste.com";
    const reg2 = await reqJson(BASE + "/api/auth/registrar",
        json("POST", null, { nome: "Webhook Btn 2", email: email2, senha: "senha-teste-123" }));
    const userTok2 = (reg2.body && reg2.body.token) || "";
    t("registro segundo usuário (botão)", !!userTok2);

    /* 28) approved: consulta imediata (botão) -> 200 RECEIVED + espaço pago */
    const espPollOk = 999980;
    const ckPollOk = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollOk], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollOk = String(ckPollOk.body.mpOrderId);
    ordersCriadas.get(dataIdPollOk).status = "paid";
    const wPollOk = await reqJson(BASE + "/api/payment-status/" + dataIdPollOk, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollOk = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("28) botão approved -> 200 RECEIVED + espaço pago",
        wPollOk.r.status === 200 && wPollOk.body.status === "RECEIVED" &&
        dbPollOk[String(espPollOk)] && dbPollOk[String(espPollOk)].status === "paid",
        "status=" + wPollOk.r.status + " st=" + wPollOk.body.status +
        " espaço=" + (dbPollOk[String(espPollOk)] && dbPollOk[String(espPollOk)].status));

    /* 29) pending: consulta -> 200 com status real, espaço NÃO liberado */
    const espPollPend = 999979;
    const ckPollPend = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollPend], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollPend = String(ckPollPend.body.mpOrderId);
    ordersCriadas.get(dataIdPollPend)._autoConfirm = false;
    const wPollPend = await reqJson(BASE + "/api/payment-status/" + dataIdPollPend, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollPend = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("29) botão pending -> status real, espaço NÃO liberado",
        wPollPend.r.status === 200 && wPollPend.body.status !== "RECEIVED" &&
        wPollPend.body.accessCode === null &&
        dbPollPend[String(espPollPend)] &&
        dbPollPend[String(espPollPend)].status === "reserved",
        "status=" + wPollPend.r.status + " st=" + wPollPend.body.status +
        " espaço=" + (dbPollPend[String(espPollPend)] && dbPollPend[String(espPollPend)].status));

    /* 30) rejected: consulta -> 200, libera a reserva na hora (regra existente) */
    const espPollRej = 999978;
    const ckPollRej = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollRej], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollRej = String(ckPollRej.body.mpOrderId);
    ordersCriadas.get(dataIdPollRej).status = "rejected";
    const wPollRej = await reqJson(BASE + "/api/payment-status/" + dataIdPollRej, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollRej = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("30) botão rejected -> 200, reserva liberada na hora",
        wPollRej.r.status === 200 && wPollRej.body.status === "rejected" &&
        !dbPollRej[String(espPollRej)],
        "status=" + wPollRej.r.status + " st=" + wPollRej.body.status +
        " existe=" + (!!dbPollRej[String(espPollRej)]));

    /* 31) cancelled: consulta -> 200, reserva liberada (regra existente) */
    const espPollCanc = 999977;
    const ckPollCanc = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollCanc], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollCanc = String(ckPollCanc.body.mpOrderId);
    ordersCriadas.get(dataIdPollCanc).status = "cancelled";
    const wPollCanc = await reqJson(BASE + "/api/payment-status/" + dataIdPollCanc, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollCanc = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("31) botão cancelled -> 200, reserva liberada",
        wPollCanc.r.status === 200 && wPollCanc.body.status === "cancelled" &&
        !dbPollCanc[String(espPollCanc)],
        "status=" + wPollCanc.r.status + " st=" + wPollCanc.body.status +
        " existe=" + (!!dbPollCanc[String(espPollCanc)]));

    /* 32) Order inexistente no MP (404) -> 404, sem liberar nada */
    const espPollInex = 999976;
    const ckPollInex = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollInex], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollInex = String(ckPollInex.body.mpOrderId);
    ordersInexistentes.add(dataIdPollInex);
    const wPollInex = await reqJson(BASE + "/api/payment-status/" + dataIdPollInex, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollInex = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("32) botão Order inexistente (404) -> 404 e nada liberado",
        wPollInex.r.status === 404 &&
        dbPollInex[String(espPollInex)] &&
        dbPollInex[String(espPollInex)].status === "reserved",
        "status=" + wPollInex.r.status + " body=" + JSON.stringify(wPollInex.body) +
        " espaço=" + (dbPollInex[String(espPollInex)] && dbPollInex[String(espPollInex)].status));

    /* 33) Order de OUTRO usuário -> 403 (acesso negado) */
    const espPollOutro = 999975;
    const ckPollOutro = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollOutro], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollOutro = String(ckPollOutro.body.mpOrderId);
    const wPollOutro = await reqJson(BASE + "/api/payment-status/" + dataIdPollOutro, {
        headers: { "Authorization": "Bearer " + userTok2 }
    });
    t("33) botão order de outro usuário -> 403",
        wPollOutro.r.status === 403,
        "status=" + wPollOutro.r.status + " body=" + JSON.stringify(wPollOutro.body));

    /* 34) VALOR DIVERGENTE na consulta -> 200 divergencia + espaço NÃO pago */
    const espPollDiv = 999974;
    const ckPollDiv = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollDiv], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollDiv = String(ckPollDiv.body.mpOrderId);
    const ordemPollDiv = ordersCriadas.get(dataIdPollDiv);
    ordemPollDiv.status = "paid";
    ordemPollDiv.total_amount = "0.50";
    const wPollDiv = await reqJson(BASE + "/api/payment-status/" + dataIdPollDiv, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollDiv = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("34) botão valor divergente -> 200 divergencia + espaço NÃO liberado",
        wPollDiv.r.status === 200 && wPollDiv.body.divergencia === true &&
        dbPollDiv[String(espPollDiv)] &&
        dbPollDiv[String(espPollDiv)].status === "reserved",
        "status=" + wPollDiv.r.status + " body=" + JSON.stringify(wPollDiv.body) +
        " espaço=" + (dbPollDiv[String(espPollDiv)] && dbPollDiv[String(espPollDiv)].status));

    /* 35) consulta repetida (clique duplicado) -> idempotente, MESMO paidAt */
    const paidAtOk = dbPollOk[String(espPollOk)] && dbPollOk[String(espPollOk)].paidAt;
    const wPollOk2 = await reqJson(BASE + "/api/payment-status/" + dataIdPollOk, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollOk2 = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("35) consulta repetida idempotente -> 200 e paidAt inalterado",
        wPollOk2.r.status === 200 && wPollOk2.body.status === "RECEIVED" &&
        dbPollOk2[String(espPollOk)] && dbPollOk2[String(espPollOk)].status === "paid" &&
        dbPollOk2[String(espPollOk)].paidAt === paidAtOk,
        "status=" + wPollOk2.r.status + " st=" + wPollOk2.body.status);

    /* 36) clique duplicado protegido no FRONTEND: botão desabilita durante a
       requisição ("Verificando pagamento...") e só o backend decide pago. */
    const htmlIdx = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    t("36) botão no frontend: desabilita + 'Verificando pagamento...' + idempotente",
        htmlIdx.includes('id="btnJaPagueiPix"') &&
        htmlIdx.includes("Verificando pagamento...") &&
        htmlIdx.includes("verificandoPagamento = true") &&
        htmlIdx.includes("Já paguei o PIX"),
        "btn=" + htmlIdx.includes('id="btnJaPagueiPix"'));

    /* 22) prova criptográfica do formato canônico do MP: o HMAC calculado
       sobre id:<data.id em minúsculo>;request-id:<rid>;ts:<ts>; gera
       exatamente o v1 recebido (len 64). */
    const manifestLowerCase = "id:" + dataIdCase.toLowerCase() +
        ";request-id:" + ridCase + ";ts:" + tsCase + ";";
    const v1Case = assinaturaMpLower(dataIdCase, tsCase, ridCase);
    const esperadoLower = crypto.createHmac("sha256", SECRET)
        .update(manifestLowerCase).digest("hex");
    t("22) manifesto minúsculo = forma canônica (v1 len 64)",
        esperadoLower === v1Case && esperadoLower.length === 64,
        "len=" + esperadoLower.length);

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

    /* 9) VALOR DIVERGENTE: total_amount diferente do cobrado
       no checkout -> webhook 200 com divergencia, espaço NÃO liberado. */
    const espDiv = 999989;
    const checkoutDiv = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espDiv], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdDiv = String(checkoutDiv.body.mpOrderId);
    ordersCriadas.get(dataIdDiv).total_amount = "0.50";
    const tsDiv = Math.floor(Date.now() / 1000);
    const ridDiv = "req-div-" + Date.now();
    const wDiv = await reqJson(BASE + "/webhooks/mercadopago?data.id=" + dataIdDiv + "&type=order", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsDiv + ",v1=" + assinar(dataIdDiv, tsDiv, ridDiv),
            "x-request-id": ridDiv
        },
        body: JSON.stringify({ type: "order", data: { id: dataIdDiv } })
    });
    await sleep(700);
    const dbDiv = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("9) valor divergente -> 200 divergencia + espaço NÃO liberado",
        wDiv.r.status === 200 && wDiv.body.divergencia === true &&
        dbDiv[String(espDiv)] && dbDiv[String(espDiv)].status === "reserved",
        "status=" + wDiv.r.status + " body=" + JSON.stringify(wDiv.body) +
        " espaço=" + (dbDiv[String(espDiv)] && dbDiv[String(espDiv)].status));

    /* 18) external_reference DIVERGENTE: assinatura HMAC VÁLIDA, mas o
       external_reference da Order (eco do MP) não bate com o orderId
       interno do espaço -> 200 externalReferenceDivergencia:true, espaço
       NÃO liberado (vínculo pagamento -> pedido). */
    const espExt = 999986;
    const checkoutExt = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espExt], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdExt = String(checkoutExt.body.mpOrderId);
    ordersCriadas.get(dataIdExt).external_reference = "MEGA-ORDEM-ALHEIA";
    const tsExt = Math.floor(Date.now() / 1000);
    const ridExt = "req-ext-" + Date.now();
    const wExt = await reqJson(BASE + "/webhooks/mercadopago?data.id=" + dataIdExt + "&type=order", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsExt + ",v1=" + assinar(dataIdExt, tsExt, ridExt),
            "x-request-id": ridExt
        },
        body: JSON.stringify({ type: "order", data: { id: dataIdExt } })
    });
    await sleep(700);
    const dbExt = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("18) external_reference divergente -> NÃO libera espaço",
        wExt.r.status === 200 && wExt.body.externalReferenceDivergencia === true &&
        dbExt[String(espExt)] && dbExt[String(espExt)].status === "reserved",
        "status=" + wExt.r.status + " body=" + JSON.stringify(wExt.body) +
        " espaço=" + (dbExt[String(espExt)] && dbExt[String(espExt)].status));

    /* 19) Order CANCELLED com external_reference DIVERGENTE -> espaço
       NÃO liberado (não devolve espaço de outra venda). */
    const espExtCanc = 999985;
    const checkoutExtCanc = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espExtCanc], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdExtCanc = String(checkoutExtCanc.body.mpOrderId);
    const ordemExtCanc = ordersCriadas.get(dataIdExtCanc);
    ordemExtCanc.status = "cancelled";
    ordemExtCanc.external_reference = "MEGA-ORDEM-ALHEIA-2";
    const tsExtCanc = Math.floor(Date.now() / 1000);
    const ridExtCanc = "req-ext-canc-" + Date.now();
    const wExtCanc = await reqJson(BASE + "/webhooks/mercadopago?data.id=" + dataIdExtCanc + "&type=order", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsExtCanc + ",v1=" + assinar(dataIdExtCanc, tsExtCanc, ridExtCanc),
            "x-request-id": ridExtCanc
        },
        body: JSON.stringify({ type: "order", data: { id: dataIdExtCanc } })
    });
    await sleep(700);
    const dbExtCanc = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("19) CANCELLED com external_reference divergente -> NÃO libera",
        wExtCanc.r.status === 200 && dbExtCanc[String(espExtCanc)] &&
        dbExtCanc[String(espExtCanc)].status === "reserved",
        "status=" + wExtCanc.r.status +
        " espaço=" + (dbExtCanc[String(espExtCanc)] && dbExtCanc[String(espExtCanc)].status));

    /* 17) Order CANCELLED -> espaço liberado imediatamente (sem esperar TTL). */
    const espCanc = 999987;    const checkoutCanc = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espCanc], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdCanc = String(checkoutCanc.body.mpOrderId);
    ordersCriadas.get(dataIdCanc).status = "cancelled";
    const tsCanc = Math.floor(Date.now() / 1000);
    const ridCanc = "req-canc-" + Date.now();
    const wCanc = await reqJson(BASE + "/webhooks/mercadopago?data.id=" + dataIdCanc + "&type=order", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": "ts=" + tsCanc + ",v1=" + assinar(dataIdCanc, tsCanc, ridCanc),
            "x-request-id": ridCanc
        },
        body: JSON.stringify({ type: "order", data: { id: dataIdCanc } })
    });
    await sleep(700);
    const dbCanc = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("17) order CANCELLED -> espaço liberado imediatamente",
        wCanc.r.status === 200 && !dbCanc[String(espCanc)],
        "status=" + wCanc.r.status + " existe=" + (!!dbCanc[String(espCanc)]));

    /* =========================================================
       CORREÇÃO 6 — Orders API: order.status="processed" (status_detail
       "accredited") = PAGO. Reproduz o problema REAL de produção:
       webhook order.processed + GET /v1/orders/{id} retornando
       processed/accredited -> a Order DEVE ser reconhecida como paga.
    ========================================================= */

    /* 37) CENÁRIO REAL: Order processed + status_detail accredited +
       payment processed + status_detail accredited + paid_amount certo
       -> PAGO (espaço liberado). */
    const espProc = 999970;
    const ckProc = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espProc], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdProc = String(ckProc.body.mpOrderId);
    const ordemProc = ordersCriadas.get(dataIdProc);
    ordemProc.status = "processed";
    ordemProc.status_detail = "accredited";
    ordemProc.total_paid_amount = ordemProc.total_amount;
    ordemProc.transactions.payments[0].status = "processed";
    ordemProc.transactions.payments[0].status_detail = "accredited";
    ordemProc.transactions.payments[0].paid_amount = ordemProc.total_amount;
    const tsProc = Math.floor(Date.now() / 1000);
    const ridProc = "req-proc-" + Date.now();
    const wProc = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdProc + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsProc + ",v1=" + assinar(dataIdProc, tsProc, ridProc),
                "x-request-id": ridProc
            },
            body: JSON.stringify({ type: "order", action: "order.processed", live_mode: true, data: { id: dataIdProc } })
        });
    await sleep(700);
    const dbProc = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("37) CENÁRIO REAL processed/accredited -> PAGO + espaço pago",
        wProc.r.status === 200 && wProc.body.received === true &&
        dbProc[String(espProc)] && dbProc[String(espProc)].status === "paid",
        "status=" + wProc.r.status + " body=" + JSON.stringify(wProc.body) +
        " espaço=" + (dbProc[String(espProc)] && dbProc[String(espProc)].status));

    /* 37b) webhook duplicado com processed -> idempotente (paidAt inalterado) */
    const paidAtProc1 = dbProc[String(espProc)] && dbProc[String(espProc)].paidAt;
    const tsProcDup = Math.floor(Date.now() / 1000);
    const ridProcDup = "req-proc-dup-" + Date.now();
    const wProcDup = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdProc + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsProcDup + ",v1=" + assinar(dataIdProc, tsProcDup, ridProcDup),
                "x-request-id": ridProcDup
            },
            body: JSON.stringify({ type: "order", action: "order.processed", live_mode: true, data: { id: dataIdProc } })
        });
    await sleep(700);
    const dbProcDup = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("37b) processed duplicado -> idempotente, paidAt inalterado",
        wProcDup.r.status === 200 &&
        dbProcDup[String(espProc)] && dbProcDup[String(espProc)].status === "paid" &&
        dbProcDup[String(espProc)].paidAt === paidAtProc1,
        "status=" + wProcDup.r.status +
        " paidAt igual=" + (dbProcDup[String(espProc)].paidAt === paidAtProc1));

    /* 38) order.status="accredited" (variação) -> PAGO */
    const espAcred = 999969;
    const ckAcred = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espAcred], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdAcred = String(ckAcred.body.mpOrderId);
    const ordemAcred = ordersCriadas.get(dataIdAcred);
    ordemAcred.status = "accredited";
    ordemAcred.status_detail = "accredited";
    ordemAcred.transactions.payments[0].status = "processed";
    ordemAcred.transactions.payments[0].status_detail = "accredited";
    const tsAcred = Math.floor(Date.now() / 1000);
    const ridAcred = "req-acred-" + Date.now();
    const wAcred = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdAcred + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsAcred + ",v1=" + assinar(dataIdAcred, tsAcred, ridAcred),
                "x-request-id": ridAcred
            },
            body: JSON.stringify({ type: "order", action: "order.processed", live_mode: true, data: { id: dataIdAcred } })
        });
    await sleep(700);
    const dbAcred = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("38) order.status accredited -> PAGO + espaço pago",
        wAcred.r.status === 200 &&
        dbAcred[String(espAcred)] && dbAcred[String(espAcred)].status === "paid",
        "status=" + wAcred.r.status +
        " espaço=" + (dbAcred[String(espAcred)] && dbAcred[String(espAcred)].status));

    /* 39) action_required/waiting_transfer (ANTES do pagamento) -> NÃO PAGO */
    const espProcPend = 999968;
    const ckProcPend = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espProcPend], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdProcPend = String(ckProcPend.body.mpOrderId);
    const ordemProcPend = ordersCriadas.get(dataIdProcPend);
    ordemProcPend.status = "action_required";
    ordemProcPend.status_detail = "waiting_transfer";
    ordemProcPend.transactions.payments[0].status = "action_required";
    ordemProcPend.transactions.payments[0].status_detail = "action_required";
    const tsProcPend = Math.floor(Date.now() / 1000);
    const ridProcPend = "req-proc-pend-" + Date.now();
    const wProcPend = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdProcPend + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsProcPend + ",v1=" + assinar(dataIdProcPend, tsProcPend, ridProcPend),
                "x-request-id": ridProcPend
            },
            body: JSON.stringify({ type: "order", action: "order.action_required", live_mode: true, data: { id: dataIdProcPend } })
        });
    await sleep(700);
    const dbProcPend = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("39) action_required/waiting_transfer -> NÃO PAGO (espaço reservado)",
        wProcPend.r.status === 200 && wProcPend.body.received === true &&
        dbProcPend[String(espProcPend)] && dbProcPend[String(espProcPend)].status === "reserved",
        "status=" + wProcPend.r.status +
        " espaço=" + (dbProcPend[String(espProcPend)] && dbProcPend[String(espProcPend)].status));

    /* 40) order processed MAS payment refunded -> NÃO PAGO (a transação vale
       mais que o status da Order: pagamento devolvido nunca é pago). */
    const espProcRef = 999967;
    const ckProcRef = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espProcRef], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdProcRef = String(ckProcRef.body.mpOrderId);
    const ordemProcRef = ordersCriadas.get(dataIdProcRef);
    ordemProcRef.status = "processed";
    ordemProcRef.status_detail = "accredited";
    ordemProcRef.transactions.payments[0].status = "refunded";
    ordemProcRef.transactions.payments[0].status_detail = "refunded";
    const tsProcRef = Math.floor(Date.now() / 1000);
    const ridProcRef = "req-proc-ref-" + Date.now();
    const wProcRef = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdProcRef + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsProcRef + ",v1=" + assinar(dataIdProcRef, tsProcRef, ridProcRef),
                "x-request-id": ridProcRef
            },
            body: JSON.stringify({ type: "order", action: "order.processed", live_mode: true, data: { id: dataIdProcRef } })
        });
    await sleep(700);
    const dbProcRef = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("40) processed mas payment refunded -> NÃO PAGO",
        wProcRef.r.status === 200 &&
        dbProcRef[String(espProcRef)] && dbProcRef[String(espProcRef)].status === "reserved",
        "status=" + wProcRef.r.status +
        " espaço=" + (dbProcRef[String(espProcRef)] && dbProcRef[String(espProcRef)].status));

    /* 41) order.status="failed" -> NÃO PAGO (espaço continua reservado) */
    const espFail = 999966;
    const ckFail = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espFail], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdFail = String(ckFail.body.mpOrderId);
    ordersCriadas.get(dataIdFail).status = "failed";
    const tsFail = Math.floor(Date.now() / 1000);
    const ridFail = "req-fail-" + Date.now();
    const wFail = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdFail + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsFail + ",v1=" + assinar(dataIdFail, tsFail, ridFail),
                "x-request-id": ridFail
            },
            body: JSON.stringify({ type: "order", action: "order.rejected", live_mode: true, data: { id: dataIdFail } })
        });
    await sleep(700);
    const dbFail = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("41) order failed -> NÃO PAGO",
        wFail.r.status === 200 &&
        dbFail[String(espFail)] && dbFail[String(espFail)].status === "reserved",
        "status=" + wFail.r.status +
        " espaço=" + (dbFail[String(espFail)] && dbFail[String(espFail)].status));

    /* 42) order.status="expired" -> NÃO PAGO (regra existente: libera reserva) */
    const espExp = 999965;
    const ckExp = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espExp], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdExp = String(ckExp.body.mpOrderId);
    ordersCriadas.get(dataIdExp).status = "expired";
    const tsExp = Math.floor(Date.now() / 1000);
    const ridExp = "req-exp-" + Date.now();
    const wExp = await reqJson(
        BASE + "/webhooks/mercadopago?data.id=" + dataIdExp + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "ts=" + tsExp + ",v1=" + assinar(dataIdExp, tsExp, ridExp),
                "x-request-id": ridExp
            },
            body: JSON.stringify({ type: "order", action: "order.rejected", live_mode: true, data: { id: dataIdExp } })
        });
    await sleep(700);
    const dbExp = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("42) order expired -> NÃO PAGO (reserva liberada pela regra)",
        wExp.r.status === 200 && !dbExp[String(espExp)],
        "status=" + wExp.r.status + " existe=" + (!!dbExp[String(espExp)]));

    /* 43) botão "Já paguei o PIX" consulta a MESMA Order real: processed ->
       payment-status devolve RECEIVED e marca o espaço pago. */
    const espPollProc = 999964;
    const ckPollProc = await reqJson(BASE + "/api/checkout",
        json("POST", userTok, {
            spaces: [espPollProc], aceiteRegras: true, name: "Webhook Test", email,
            cpfCnpj: cpfValido, paymentMethod: "pix", licensePlan: "1_year"
        }));
    const dataIdPollProc = String(ckPollProc.body.mpOrderId);
    const ordemPollProc = ordersCriadas.get(dataIdPollProc);
    ordemPollProc.status = "processed";
    ordemPollProc.status_detail = "accredited";
    ordemPollProc.total_paid_amount = ordemPollProc.total_amount;
    ordemPollProc.transactions.payments[0].status = "processed";
    ordemPollProc.transactions.payments[0].status_detail = "accredited";
    ordemPollProc.transactions.payments[0].paid_amount = ordemPollProc.total_amount;
    const wPollProc = await reqJson(BASE + "/api/payment-status/" + dataIdPollProc, {
        headers: { "Authorization": "Bearer " + userTok }
    });
    await sleep(700);
    const dbPollProc = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
    t("43) botão consulta Order real processed -> RECEIVED + espaço pago",
        wPollProc.r.status === 200 && wPollProc.body.status === "RECEIVED" &&
        dbPollProc[String(espPollProc)] && dbPollProc[String(espPollProc)].status === "paid",
        "status=" + wPollProc.r.status + " st=" + wPollProc.body.status +
        " espaço=" + (dbPollProc[String(espPollProc)] && dbPollProc[String(espPollProc)].status));

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
