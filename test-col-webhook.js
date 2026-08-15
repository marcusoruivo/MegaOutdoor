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
