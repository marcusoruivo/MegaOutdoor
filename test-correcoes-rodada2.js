/* Rodada 2 — testes das correções de produção:
   - Ofertas: aceite sem CPF do comprador; pagamento gerado pelo
     comprador (POST /api/offers/:id/payment); "JÁ PAGUEI" não confirma;
     split 90/10; propriedade só transfere após confirmação real;
     usuário não acessa pagamento de negociação alheia.
   - Story: só associa destaque a espaço do próprio usuário (403 p/ outro).
   - Cartão: bandeira ausente -> 400 claro (sem payload inválido ao MP).
   - Busca: o front inicia a busca vazia (value="", autocomplete off).
   NÃO faz commit/push/deploy.
*/
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-mock-token";
process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.PORT = process.env.PORT || "3201";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "corr2-" + Date.now());
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
        const id = "ORD" + String(9000000 + ordenador.seq++);
        const isCard = body && body.transactions && body.transactions.payments &&
            body.transactions.payments[0] && body.transactions.payments[0].payment_method &&
            body.transactions.payments[0].payment_method.type === "credit_card";
        const order = {
            id, status: "open", external_reference: body.external_reference,
            total_amount: body.total_amount,
            transactions: { payments: [{ id: "pay-" + id, status: "pending",
                status_detail: "pending_waiting_transfer",
                payment_method: isCard
                    ? { id: "master", type: "credit_card", installments: 1 }
                    : { id: "pix", type: "bank_transfer",
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

const BASE = "http://localhost:3201";
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
function assinarWebhook(dataId, ts, requestId) {
    const trechos = [];
    trechos.push(`id:${String(dataId).toLowerCase()}`);
    if (requestId) trechos.push(`request-id:${requestId}`);
    trechos.push(`ts:${ts}`);
    const manifest = trechos.join(";") + ";";
    return crypto.createHmac("sha256", "segredo-webhook-teste")
        .update(manifest).digest("hex");
}

async function main() {
    await sleep(4500);

    const cpfValido = "12345678909";
    const cpfInvalido = "12345678900";

    /* ===== Admin ===== */
    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    const adminTok = login.body.token || "";
    t("login admin", !!adminTok);

    /* ===== Usuários: A (dono), B (comprador), C (terceiro) ===== */
    const eA = "dono-" + Date.now() + "@teste.com";
    const eB = "comprador-" + Date.now() + "@teste.com";
    const eC = "terceiro-" + Date.now() + "@teste.com";

    const regA = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Dono Teste", email: eA, senha: "senha-teste-123" }));
    const tokA = regA.body.token || "";
    const idA = regA.body.usuario && regA.body.usuario.id;
    t("registro dono", !!tokA && !!idA);

    const regB = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Comprador Teste", email: eB, senha: "senha-teste-123" }));
    const tokB = regB.body.token || "";
    const idB = regB.body.usuario && regB.body.usuario.id;
    t("registro comprador", !!tokB && !!idB);

    const regC = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Terceiro Teste", email: eC, senha: "senha-teste-123" }));
    const tokC = regC.body.token || "";
    const idC = regC.body.usuario && regC.body.usuario.id;
    t("registro terceiro", !!tokC && !!idC);

    /* ===== Concessão admin de espaços para A ===== */
    const concessao = await reqJson(BASE + "/api/admin/concessoes/espacos",
        json("POST", adminTok, { usuarioId: idA, ids: [500001, 500002], motivo: "teste rodada 2" }));
    t("concessão de espaços para A", concessao.r.status === 200 && !!concessao.body.concessaoId,
        "status=" + concessao.r.status + " err=" + (concessao.body && concessao.body.error));

    /* Token de A (proprietário) via admin */
    const espAdmin = await reqJson(BASE + "/api/admin/spaces?busca=500001&all=1", json("GET", adminTok));
    const esp500001 = (espAdmin.body.espacos || []).find(s => s.id === 500001);
    const tokenA = esp500001 && esp500001.orderToken || "";
    t("token do espaço #500001 obtido", !!tokenA);

    /* Chave Pix do dono A (necessária para aceitar oferta) */
    const pixKeyA = await reqJson(BASE + "/api/pix-key",
        json("POST", null, { token: tokenA, chave: "dono-pix@teste.com" }));
    t("chave Pix do dono cadastrada", pixKeyA.r.status === 200, "status=" + pixKeyA.r.status);

    /* =========================
       STORY — SÓ ESPAÇOS DO USUÁRIO
    ========================= */
    const storyBody = (extra) => Object.assign({
        duracao: "6h", titulo: "Destaque de teste",
        cpfCnpj: cpfValido, paymentMethod: "pix"
    }, extra);

    t("story: espaço de A por A -> 200",
        (await reqJson(BASE + "/api/stories/destaques",
            json("POST", tokA, storyBody({ espacoId: 500001 })))).r.status === 200);

    t("story: espaço de A por B -> 403",
        (await reqJson(BASE + "/api/stories/destaques",
            json("POST", tokB, storyBody({ espacoId: 500001 })))).r.status === 403);

    t("story: espaço inexistente -> 400",
        (await reqJson(BASE + "/api/stories/destaques",
            json("POST", tokA, storyBody({ espacoId: 999999 })))).r.status === 400);

    const meA = await reqJson(BASE + "/api/auth/me", json("GET", tokA));
    const idsDeA = ((meA.body.usuario && meA.body.espacos) || []).map(s => s.id);
    t("me: A só vê os próprios espaços", idsDeA.includes(500001) && idsDeA.includes(500002),
        "ids=" + JSON.stringify(idsDeA));

    const meB = await reqJson(BASE + "/api/auth/me", json("GET", tokB));
    const idsDeB = ((meB.body.usuario && meB.body.espacos) || []).map(s => s.id);
    t("me: B NÃO vê espaço de A", !idsDeB.includes(500001), "idsB=" + JSON.stringify(idsDeB));

    /* =========================
       OFERTAS
    ========================= */

    /* B cria oferta pelo espaço #500001 do A */
    const criaOferta = await reqJson(BASE + "/api/offers",
        json("POST", null, { spaceId: 500001, spaceIds: [500001], name: "Comprador Teste", email: eB, value: 100, message: "Oferta de teste" }));
    const offerId = criaOferta.body.offerId || "";
    t("oferta criada por B", criaOferta.r.status === 200 && !!offerId, "status=" + criaOferta.r.status);

    await sleep(300);

    /* Notificação ao dono (A) */
    const notifA = await reqJson(BASE + "/api/notificacoes", json("GET", tokA));
    const notifARecebida = (notifA.body.notificacoes || []).some(n => n.tipo === "oferta_recebida");
    t("A recebe notificação de oferta recebida", notifARecebida);

    /* Terceiro NÃO recebe a notificação */
    const notifC = await reqJson(BASE + "/api/notificacoes", json("GET", tokC));
    const notifCRecebida = (notifC.body.notificacoes || []).some(n => n.tipo === "oferta_recebida");
    t("C NÃO recebe notificação de oferta de A", !notifCRecebida);

    /* Aceite do dono SEM CPF do comprador */
    const aceita = await reqJson(BASE + "/api/offers/" + offerId + "/accept",
        json("POST", null, { token: tokenA }));
    t("aceite sem CPF -> 200 accepted/pending",
        aceita.r.status === 200 && aceita.body.status === "accepted" && aceita.body.paymentStatus === "pending",
        "status=" + aceita.r.status + " " + JSON.stringify(aceita.body).slice(0, 160));
    t("aceite NÃO devolve QR ao vendedor", !aceita.body.qrCode && !aceita.body.payload);
    t("aceite mantém a chave do próprio vendedor", aceita.body.ownerPixKey === "dono-pix@teste.com");

    await sleep(300);

    /* Notificação ao comprador (B) */
    const notifB = await reqJson(BASE + "/api/notificacoes", json("GET", tokB));
    const notifBAceita = (notifB.body.notificacoes || []).some(n => n.tipo === "oferta_aceita");
    t("B recebe notificação de oferta aceita", notifBAceita);

    /* Pagamento ainda não gerado */
    const pagIni = await reqJson(BASE + "/api/offers/" + offerId + "/payment", json("GET", tokB));
    t("GET payment antes de gerar -> paymentRequired", pagIni.r.status === 200 && pagIni.body.paymentRequired === true,
        JSON.stringify(pagIni.body).slice(0, 160));

    /* Terceiro NÃO pode consultar pagamento */
    const pagC = await reqJson(BASE + "/api/offers/" + offerId + "/payment", json("GET", tokC));
    t("terceiro NÃO consulta pagamento -> 403", pagC.r.status === 403);

    /* Gerar pagamento (comprador B): CPF inválido -> 400 */
    const pagInv = await reqJson(BASE + "/api/offers/" + offerId + "/payment",
        json("POST", tokB, { cpfCnpj: cpfInvalido }));
    t("gerar pix CPF inválido -> 400", pagInv.r.status === 400);

    /* Terceiro NÃO pode gerar pagamento */
    const pagCpost = await reqJson(BASE + "/api/offers/" + offerId + "/payment",
        json("POST", tokC, { cpfCnpj: cpfValido }));
    t("terceiro NÃO gera pagamento -> 403", pagCpost.r.status === 403);

    /* CPF válido -> 200 com QR e mpOrderId */
    const pagOk = await reqJson(BASE + "/api/offers/" + offerId + "/payment",
        json("POST", tokB, { cpfCnpj: cpfValido }));
    const mpOrderId = pagOk.body.mpOrderId || "";
    t("gerar pix do comprador -> 200 com QR", pagOk.r.status === 200 && !!pagOk.body.qrCode && !!mpOrderId,
        "status=" + pagOk.r.status + " err=" + (pagOk.body && pagOk.body.error));

    /* "JÁ PAGUEI" NÃO confirma e NÃO transfere */
    const report = await reqJson(BASE + "/api/offers/" + offerId + "/report-payment", json("POST", tokB, {}));
    t("JÁ PAGUEI -> reported (não confirmed)", report.r.status === 200 && report.body.paymentStatus === "reported",
        "status=" + report.r.status);

    const pagPos = await reqJson(BASE + "/api/offers/" + offerId + "/payment", json("GET", tokB));
    t("após JÁ PAGUEI o status NÃO é paid", pagPos.r.status === 200 && pagPos.body.status !== "paid");

    const meAApos = await reqJson(BASE + "/api/auth/me", json("GET", tokA));
    const idsDeAApos = ((meAApos.body.usuario && meAApos.body.espacos) || []).map(s => s.id);
    t("JÁ PAGUEI NÃO transfere propriedade (A mantém #500001)", idsDeAApos.includes(500001),
        "idsA=" + JSON.stringify(idsDeAApos));

    /* Confirmação REAL via webhook do MP (order paga) */
    const mockOrder = ordersCriadas.get(mpOrderId);
    if (mockOrder) {
        mockOrder.status = "paid";
        mockOrder.transactions.payments[0].status = "approved";
        mockOrder.transactions.payments[0].status_detail = "accredited";
    }
    const ts = String(Date.now());
    const wh = await reqJson(BASE + "/webhooks/mercadopago?data.id=" + encodeURIComponent(mpOrderId) + "&type=order",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": "v1=" + assinarWebhook(mpOrderId, ts, "req-test-1") + ",ts=" + ts,
                "x-request-id": "req-test-1"
            },
            body: JSON.stringify({ type: "order", data: { id: mpOrderId } })
        });
    t("webhook de order paga aceito", wh.r.status === 200, "status=" + wh.r.status);

    await sleep(400);

    /* Oferta agora paga + split 90/10 */
    const pagFinal = await reqJson(BASE + "/api/offers/" + offerId + "/payment", json("GET", tokB));
    t("após confirmação real -> paid", pagFinal.r.status === 200 && pagFinal.body.status === "paid",
        "status=" + pagFinal.r.status + " body=" + JSON.stringify(pagFinal.body).slice(0, 200));

    /* split 90/10 verificável nas transações (venda p/ vendedor) */
    /* split 90/10 em centavos — lido direto do armazenamento local */
    const offersArquivo = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "offers.json"), "utf8"));
    const ofArq = offersArquivo[offerId] || {};
    t("split 90/10 em centavos", ofArq.comissaoCents === 1000 && ofArq.vendedorCents === 9000 && ofArq.valorPagoCompradorCents === 10000,
        JSON.stringify({ c: ofArq.comissaoCents, v: ofArq.vendedorCents, t: ofArq.valorPagoCompradorCents }));
    t("liquidação pendente para o vendedor", ofArq.liquidacaoStatus === "pendente", "liq=" + ofArq.liquidacaoStatus);
    t("status final da oferta = paid", ofArq.status === "paid", "status=" + ofArq.status);

    const trans = await reqJson(BASE + "/api/admin/transacoes?busca=" + encodeURIComponent(offerId) + "&limite=50", json("GET", adminTok));
    const listaTrans = trans.body.transacoes || [];
    const venda = listaTrans.find(x => x.tipo === "venda" && x.orderId === offerId);
    const compra = listaTrans.find(x => x.tipo === "compra" && x.orderId === offerId);
    t("transação venda registrada (100 / comissão 10)",
        !!venda && venda.valorTotal === 100 && venda.comissao === 10,
        JSON.stringify(venda));
    t("transação compra registrada para o novo dono", !!compra && compra.valorTotal === 100,
        JSON.stringify(compra));

    const meBfinal = await reqJson(BASE + "/api/auth/me", json("GET", tokB));
    const idsDeBfinal = ((meBfinal.body.usuario && meBfinal.body.espacos) || []).map(s => s.id);
    t("propriedade transferida para B", idsDeBfinal.includes(500001), "idsB=" + JSON.stringify(idsDeBfinal));

    const meAposFinal = await reqJson(BASE + "/api/auth/me", json("GET", tokA));
    const idsDeAposFinal = ((meAposFinal.body.usuario && meAposFinal.body.espacos) || []).map(s => s.id);
    t("A NÃO possui mais #500001", !idsDeAposFinal.includes(500001), "idsA=" + JSON.stringify(idsDeAposFinal));

    /* Não é possível gerar pagamento duplicado */
    const duplo = await reqJson(BASE + "/api/offers/" + offerId + "/payment",
        json("POST", tokB, { cpfCnpj: cpfValido }));
    t("pagamento duplicado -> 400", duplo.r.status === 400, "status=" + duplo.r.status);

    /* =========================
       CARTÃO — BANDEIRA AUSENTE
    ========================= */
    const cardBody = {
        spaces: [500010],
        name: "Card Teste",
        email: eB,
        cpfCnpj: cpfValido,
        paymentMethod: "credit_card",
        cardToken: "tok-mock-123",
        aceiteRegras: true,
        licensePlan: "1_year"
    };
    const cardSemBandeira = await reqJson(BASE + "/api/checkout", json("POST", tokB, cardBody));
    t("cartão sem bandeira -> 400 claro", cardSemBandeira.r.status === 400 && /bandeira/i.test(cardSemBandeira.body.error || ""),
        "status=" + cardSemBandeira.r.status + " err=" + (cardSemBandeira.body && cardSemBandeira.body.error));

    const cardComBandeira = await reqJson(BASE + "/api/checkout", json("POST", tokB, Object.assign({}, cardBody, { paymentMethodId: "master" })));
    t("cartão com bandeira -> 200 (pix/order criada)", cardComBandeira.r.status === 200,
        "status=" + cardComBandeira.r.status + " err=" + (cardComBandeira.body && cardComBandeira.body.error));

    /* =========================
       FRONT — BUSCA INICIA VAZIA
    ========================= */
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const buscaMatch = html.match(/id="spaceSearch"[^>]*value=""/);
    t("front: spaceSearch inicia vazio", !!buscaMatch);
    const buscaAutocomplete = /id="spaceSearch"[^>]*autocomplete="off"/.test(html);
    t("front: spaceSearch autocomplete off", buscaAutocomplete);
    const noRuivo = !/RUIVO/i.test(html);
    t("front: 'RUIVO' não está hardcoded no HTML", noRuivo);

    console.log(log.join("\n"));
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("-----------------------------");
    console.log("RODADA 2: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});