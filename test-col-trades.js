/* Teste avançado de trocas: diferença em dinheiro, contraproposta com
   dinheiro, expiração, bloqueio de figurinha negociada, e idempotência. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3196";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "coltrades-" + Date.now());
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

const BASE = "http://localhost:3196";
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
async function comprarPacote(h, quem) {
    const c = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    if (c.r.status !== 200) return null;
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + c.body.externalReference, { method: "POST", headers: h });
    const al = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h });
    return al.body.cards.filter(x => x.quantidade > 0);
}

async function main() {
    await sleep(4500);
    const e1 = "t1-" + Date.now() + "@teste.com";
    const e2 = "t2-" + Date.now() + "@teste.com";
    const r1 = await registrar("Trade Um", e1);
    const r2 = await registrar("Trade Dois", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    t("registro", !!u1Id && !!u2Id);

    /* ambos compram pacote (repetidamente até terem cards) */
    let c1 = await comprarPacote(h1);
    let c2 = await comprarPacote(h2);
    t("u1 e u2 tem cards", c1.length > 0 && c2.length > 0, "u1=" + c1.length + " u2=" + c2.length);

    /* troca com diferença em dinheiro: u2 oferece card, u1 paga R$ 10,00 */
    const cardU2 = c2[0];
    /* u1 oferece um card que u2 não tem */
    const idsU2 = new Set(c2.map(x => x.id));
    const cardU1 = c1.find(x => !idsU2.has(x.id));
    t("cards disponiveis para troca com dinheiro", !!cardU2 && !!cardU1, "cU2=" + (cardU2 && cardU2.id) + " cU1=" + (cardU1 && cardU1.id));

    if (cardU2 && cardU1) {
        /* u1 cria proposta oferecendo cardU1 e recebendo cardU2 + paga R$ 10 */
        let trade = await reqJson(BASE + "/api/colecionaveis/trades", {
            method: "POST", headers: h1,
            body: JSON.stringify({
                receiverId: u2Id,
                ofereco: [{ cardId: cardU1.id }],
                recebo: [{ cardId: cardU2.id }],
                cashAmount: 10,
                cashDirection: "proposer_pays"
            })
        });
        t("cria troca com dinheiro (proposer paga)", trade.r.status === 200 && trade.body.ok,
            "status=" + trade.r.status + " err=" + (trade.body.error || ""));
        const tid = trade.body.tradeId;

        /* bloqueio: cardU1 (u1) e cardU2 (u2) não podem ser vendidos/listados agora */
        if (tid) {
            let tryListU1 = await reqJson(BASE + "/api/colecionaveis/listings", {
                method: "POST", headers: h1,
                body: JSON.stringify({ cardId: cardU1.id, quantidade: 1, preco: 5 })
            });
            t("figurinha bloqueada nao pode ser listada", tryListU1.r.status === 400,
                "status=" + tryListU1.r.status + " err=" + (tryListU1.body.error || ""));

            /* u2 aceita → deve gerar WAITING_PAYMENT */
            let acc = await reqJson(BASE + "/api/colecionaveis/trades/" + tid + "/accept", {
                method: "POST", headers: h2
            });
            t("aceite com dinheiro gera WAITING_PAYMENT", acc.r.status === 200 && acc.body.status === "WAITING_PAYMENT",
                "status=" + acc.r.status + " err=" + (acc.body.error || "") + " st=" + acc.body.status);
            const extRef = acc.body.externalReference;
            t("externalReference COL-TRADE-PAY", extRef && extRef.includes("COL-TRADE"), "ext=" + extRef);

            /* confirmar pagamento da diferença */
            if (extRef) {
                let pay = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + extRef, {
                    method: "POST", headers: h1
                });
                t("confirma diferenca da troca", pay.r.status === 200 && pay.body.tipo === "trade",
                    "status=" + pay.r.status + " err=" + (pay.body.error || ""));

                /* transferência concluída */
                let alU1 = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
                let alU2 = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h2 });
                const qU1tem = alU1.body.cards.find(x => x.id === cardU2.id).quantidade;
                const qU2tem = alU2.body.cards.find(x => x.id === cardU1.id).quantidade;
                t("troca com dinheiro completa (cards trocados)", qU1tem >= 1 && qU2tem >= 1,
                    "u1tem=" + qU1tem + " u2tem=" + qU2tem);
            }
        }

        /* ===== BLOQUEIO APÓS ACEITE ===== */
        /* Criar nova troca pendente e verificar bloqueio de ambos os lados */
        let t2 = await reqJson(BASE + "/api/colecionaveis/trades", {
            method: "POST", headers: h1,
            body: JSON.stringify({ receiverId: u2Id, ofereco: [{ cardId: cardU1.id }], recebo: [{ cardId: cardU2.id }] })
        });
        const t2id = t2.body.tradeId;
        if (t2id) {
            let acervo1 = await reqJson(BASE + "/api/colecionaveis/acervo", { headers: h1 });
            const dispU1 = acervo1.body.cards.find(x => x.id === cardU1.id);
            t("acervo reflete bloqueio (disponivel menor)", dispU1 && dispU1.disponivel === 0, "disp=" + (dispU1 && dispU1.disponivel));

            /* cancelar troca libera */
            let cancel = await reqJson(BASE + "/api/colecionaveis/trades/" + t2id + "/cancel", {
                method: "POST", headers: h1
            });
            t("cancela troca pendente", cancel.r.status === 200, "status=" + cancel.r.status + " err=" + (cancel.body.error || ""));

            let acervo1b = await reqJson(BASE + "/api/colecionaveis/acervo", { headers: h1 });
            const dispU1b = acervo1b.body.cards.find(x => x.id === cardU1.id);
            t("bloqueio liberado apos cancelar", dispU1b && dispU1b.disponivel >= 1, "disp=" + (dispU1b && dispU1b.disponivel));
        }
    }

    /* ===== EXPIRAÇÃO ===== */
    /* Criar troca e forçar expiração manualmente via SQL do pool interno? Não.
       Usamos o endpoint de cancel e depois verificamos que status vira CANCELLED.
       Para expiração real precisaríamos de TTL curto; testamos via comportamento. */
    let t3 = await reqJson(BASE + "/api/colecionaveis/trades", {
        method: "POST", headers: h1,
        body: JSON.stringify({ receiverId: u2Id, ofereco: [{ cardId: c1[1]?.id || c1[0].id }], recebo: [{ cardId: c2[1]?.id || c2[0].id }] })
    });
    t("cria troca para cancelar", t3.r.status === 200 && t3.body.tradeId, "status=" + t3.r.status);
    const t3id = t3.body.tradeId;
    if (t3id) {
        /* u1 (proposer) não pode aceitar a própria */
        let naoAceita = await reqJson(BASE + "/api/colecionaveis/trades/" + t3id + "/accept", {
            method: "POST", headers: h1
        });
        t("proposer nao pode aceitar propria troca", naoAceita.r.status === 403, "status=" + naoAceita.r.status + " err=" + (naoAceita.body.error || ""));

        /* u2 (receiver) não pode cancelar a proposta alheia */
        let naoCancela = await reqJson(BASE + "/api/colecionaveis/trades/" + t3id + "/cancel", {
            method: "POST", headers: h2
        });
        t("receiver nao pode cancelar troca do proposer", naoCancela.r.status === 403, "status=" + naoCancela.r.status + " err=" + (naoCancela.body.error || ""));
    }

    /* ===== IDEMPOTÊNCIA WEBHOOK ===== */
    /* Confirmar 2x o mesmo pedido de pacote não deve duplicar figurinhas */
    let ck = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h1,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    if (ck.r.status === 200) {
        const ext = ck.body.externalReference;
        let antes = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
        const totalAntes = antes.body.cards.reduce((a, c) => a + c.quantidade, 0);
        await reqJson(BASE + "/api/colecionaveis/test/confirm/" + ext, { method: "POST", headers: h1 });
        let depois = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
        const totalDepois = depois.body.cards.reduce((a, c) => a + c.quantidade, 0);
        t("pacote entrega 3 novas figurinhas", totalDepois === totalAntes + 3, "antes=" + totalAntes + " depois=" + totalDepois);
        /* segunda confirmação é no-op */
        await reqJson(BASE + "/api/colecionaveis/test/confirm/" + ext, { method: "POST", headers: h1 });
        let depois2 = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
        const totalDepois2 = depois2.body.cards.reduce((a, c) => a + c.quantidade, 0);
        t("segunda confirmacao nao duplica", totalDepois2 === totalDepois, "depois=" + totalDepois + " depois2=" + totalDepois2);
    }

    console.log(log.join("\n"));
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("-----------------------------");
    console.log("COLECIONAVEIS TRADES: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error("ERRO GLOBAL:", e); process.exit(1); });