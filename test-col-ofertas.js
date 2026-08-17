/* Teste do sistema de OFERTAS (FAZER OFERTA / negociação / pagamento)
   e do ÁLBUM PÚBLICO (visibilidade + perfil público). */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3197";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colofertas-" + Date.now());
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
async function registrar(nome, email) {
    const { r, body } = await reqJson(BASE + "/api/auth/registrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome, email, senha: "senha-teste-123" })
    });
    return { r, body };
}
async function comprarPacote(h) {
    const c = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    if (c.r.status !== 200) return null;
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + c.body.externalReference, { method: "POST", headers: h });
    const pago = await reqJson(BASE + "/api/colecionaveis/pagamento/" + c.body.externalReference, { headers: h });
    if (pago.body.pacote && pago.body.pacote.purchaseId) {
        await reqJson(BASE + "/api/colecionaveis/packs/purchases/" + pago.body.pacote.purchaseId + "/open", { method: "POST", headers: h, body: "{}" });
    }
    const al = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h });
    return al.body.cards.filter(x => x.quantidade > 0);
}
async function figurinha(h, cardId) {
    const d = await reqJson(BASE + "/api/colecionaveis/figurinha/" + cardId, { headers: h });
    return d.body.card;
}

async function main() {
    await sleep(4500);
    const e1 = "o1-" + Date.now() + "@teste.com";
    const e2 = "o2-" + Date.now() + "@teste.com";
    const r1 = await registrar("Oferta Um", e1);
    const r2 = await registrar("Oferta Dois", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    t("registro", !!u1Id && !!u2Id);

    let c1 = await comprarPacote(h1);
    let c2 = await comprarPacote(h2);
    t("u1 e u2 tem cards", c1.length > 0 && c2.length > 0, "u1=" + c1.length + " u2=" + c2.length);
    if (!c1.length || !c2.length) { finalizar(); return; }

    const idsU1 = new Set(c1.map(x => x.id));
    const cardU2 = c2[0];
    const cardU1 = c1[0];

    /* --- SEGURANÇA: oferta para si mesmo é bloqueada --- */
    let resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: cardU1.id, offereeId: u1Id, quantidade: 1, valor: 5 })
    });
    t("oferta para si mesmo bloqueada", resp.r.status === 400, "status=" + resp.r.status + " " + (resp.body.error || ""));

    /* --- CRIAÇÃO: u1 oferta 5,00 por cardU2 --- */
    resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: cardU2.id, offereeId: u2Id, quantidade: 1, valor: 5, mensagem: "fecho?" })
    });
    t("oferta criada (PENDENTE)", resp.r.status === 201 && resp.body.oferta && resp.body.oferta.status === "PENDENTE", "status=" + resp.r.status);
    const ofertaId = resp.body.oferta && resp.body.oferta.id;

    /* --- DUPLICIDADE: segunda oferta pendente do mesmo par+card é bloqueada --- */
    resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: cardU2.id, offereeId: u2Id, quantidade: 1, valor: 6 })
    });
    t("duplicada pendente bloqueada", resp.r.status === 400, "status=" + resp.r.status);

    /* --- LISTAGEM: u2 recebeu, u1 enviou --- */
    const mine2 = await reqJson(BASE + "/api/colecionaveis/offers/mine", { headers: h2 });
    const mine1 = await reqJson(BASE + "/api/colecionaveis/offers/mine", { headers: h1 });
    t("u2 recebeu a oferta", mine2.body.recebidas.some(o => o.id === ofertaId), "n=" + mine2.body.recebidas.length);
    t("u1 enviou a oferta", mine1.body.enviadas.some(o => o.id === ofertaId), "n=" + mine1.body.enviadas.length);

    /* --- SEGURANÇA: quem NÃO é o offeree não pode aceitar --- */
    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + ofertaId + "/accept", { method: "POST", headers: h1, body: "{}" });
    t("oferente não pode aceitar a própria oferta", resp.r.status === 403, "status=" + resp.r.status);

    /* --- ACEITE: u2 aceita, disponibilidade cai 1 --- */
    const dispAntes = await figurinha(h2, cardU2.id);
    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + ofertaId + "/accept", { method: "POST", headers: h2, body: "{}" });
    t("aceite da oferta", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);
    const dispDepois = await figurinha(h2, cardU2.id);
    t("disponibilidade do vendedor caiu", dispAntes.disponivel - 1 === dispDepois.disponivel,
        "antes=" + dispAntes.disponivel + " depois=" + dispDepois.disponivel + " qtd=" + dispDepois.quantidade);

    /* --- CONTRAPROPOSTA: u2 contraporá uma nova oferta (card c2[1]) --- */
    const cardContra = c2[1];
    resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: cardContra.id, offereeId: u2Id, quantidade: 1, valor: 7 })
    });
    const origId = resp.body.oferta && resp.body.oferta.id;
    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + origId + "/counter", {
        method: "POST", headers: h2,
        body: JSON.stringify({ quantidade: 1, valor: 8, mensagem: "contra 8" })
    });
    const novaId = resp.body.oferta && resp.body.oferta.id;
    t("contraproposta criada", resp.r.status === 201 && !!novaId, "status=" + resp.r.status);
    const origMine = await reqJson(BASE + "/api/colecionaveis/offers/mine", { headers: h1 });
    const origOferta = origMine.body.enviadas.find(o => o.id === origId);
    t("oferta original vira RECUSADA após contraproposta", origOferta && origOferta.status === "RECUSADA", "status=" + (origOferta && origOferta.status));

    /* --- RECUSA (card c2[2], não duplicado) --- */
    const cardRecusa = c2[2];
    resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: cardRecusa.id, offereeId: u2Id, quantidade: 1, valor: 3 })
    });
    const recId = resp.body.oferta && resp.body.oferta.id;
    t("oferta p/ recusa criada", !!recId, "id=" + recId);
    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + recId + "/decline", { method: "POST", headers: h2, body: "{}" });
    t("recusa da oferta", resp.r.status === 200, "status=" + resp.r.status);

    /* --- CANCELAMENTO (pelo oferente, card c1[1], não duplicado) --- */
    const cardCancel = c1[1];
    resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: cardCancel.id, offereeId: u2Id, quantidade: 1, valor: 4 })
    });
    const canId = resp.body.oferta && resp.body.oferta.id;
    t("oferta p/ cancelamento criada", !!canId, "id=" + canId);
    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + canId + "/cancel", { method: "POST", headers: h1, body: "{}" });
    t("cancelamento pelo oferente", resp.r.status === 200, "status=" + resp.r.status);

    /* --- PAGAMENTO da oferta aceita (ofertaId): transfere figurinha --- */
    const cardU2Antes = await figurinha(h1, cardU2.id);
    const cardU2AntesV = await figurinha(h2, cardU2.id);
    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + ofertaId + "/pay", {
        method: "POST", headers: h1,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    t("pagamento da oferta gerado", resp.r.status === 200 && !!resp.body.externalReference, "status=" + resp.r.status + " total=" + resp.body.total);
    if (resp.r.status === 200) {
        const orderId = resp.body.externalReference;
        await reqJson(BASE + "/api/colecionaveis/test/confirm/" + orderId, { method: "POST", headers: h1 });
        const cardU2Depois = await figurinha(h1, cardU2.id);
        const cardU2DepoisV = await figurinha(h2, cardU2.id);
        t("comprador recebeu a figurinha", cardU2Depois.quantidade === cardU2Antes.quantidade + 1,
            "antes=" + cardU2Antes.quantidade + " depois=" + cardU2Depois.quantidade);
        t("vendedor perdeu a figurinha", cardU2DepoisV.quantidade === cardU2AntesV.quantidade - 1,
            "antes=" + cardU2AntesV.quantidade + " depois=" + cardU2DepoisV.quantidade);
        const mine1b = await reqJson(BASE + "/api/colecionaveis/offers/mine", { headers: h1 });
        const paga = mine1b.body.enviadas.find(o => o.id === ofertaId);
        t("oferta vira CONCLUIDA após pagamento", paga && paga.status === "CONCLUIDA", "status=" + (paga && paga.status));
    }

    /* --- ÁLBUM PÚBLICO --- */
    resp = await reqJson(BASE + "/api/colecionaveis/colecionador/" + u2Id, { headers: h1 });
    t("álbum privado por padrão", resp.body.perfil && resp.body.perfil.privado === true && resp.body.cards.length === 0,
        "privado=" + (resp.body.perfil && resp.body.perfil.privado));

    resp = await reqJson(BASE + "/api/colecionaveis/perfil/visibilidade", {
        method: "PUT", headers: h2, body: JSON.stringify({ albumPublico: true })
    });
    t("alternou para público", resp.r.status === 200 && resp.body.albumPublico === true, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/colecionaveis/colecionador/" + u2Id, { headers: h1 });
    t("álbum público expõe cards", resp.body.perfil && resp.body.perfil.privado === false && resp.body.cards.length > 0,
        "cards=" + (resp.body.cards || []).length);
    t("perfil público não expõe email", !(resp.body.perfil || {}).email, "email=" + (resp.body.perfil || {}).email);

    resp = await reqJson(BASE + "/api/colecionaveis/colecionador/999999", { headers: h1 });
    t("colecionador inexistente -> 404", resp.r.status === 404, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/colecionaveis/perfil/visibilidade", {
        method: "PUT", headers: h2, body: JSON.stringify({ albumPublico: false })
    });
    t("alternou para privado", resp.r.status === 200 && resp.body.albumPublico === false, "status=" + resp.r.status);

    /* --- DIAGNÓSTICO (sem segredos) --- */
    resp = await reqJson(BASE + "/api/colecionaveis/diagnostico/pagamentos", { headers: h1 });
    const diag = resp.body || {};
    t("diagnóstico tem split e credenciais sem valores", resp.r.status === 200 &&
        (diag.split.habilitado === "SIM" || diag.split.habilitado === "NÃO") &&
        diag.credenciais.ambiente && !JSON.stringify(diag).includes("access_token_enc"),
        "split=" + (diag.split && diag.split.habilitado) + " ambiente=" + (diag.credenciais && diag.credenciais.ambiente));

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("OFERTAS/ÁLBUM: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });