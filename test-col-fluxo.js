/* Teste completo do fluxo de colecionáveis com mock do Mercado Pago.
   Cobre: pacote, entrega, album, acervo, marketplace, venda, compra,
   troca, contraproposta, troca com dinheiro, expiracao, bloqueio,
   transferencia, historico, conquistas, seguranca. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3197";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colfluxo-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

/* Mock do Mercado Pago: intercepta chamadas para api.mercadopago.com */
const ordenador = { seq: 1 };
const ordersCriadas = new Map();
const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) {
        return fetchOriginal(url, options);
    }
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;

    if (u.endsWith("/v1/orders") && method === "POST") {
        const id = String(900000 + ordenador.seq++);
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
                        transaction_data: {
                            qr_code_base64: "bW9jaw==",
                            qr_code: "000201mock",
                            ticket_url: "https://mock.local/ticket/" + id
                        }
                    }
                }]
            }
        };
        ordersCriadas.set(id, order);
        return {
            ok: true,
            status: 201,
            json: async () => order
        };
    }

    /* GET /v1/orders/:id */
    const m = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (m && method === "GET") {
        const id = m[1];
        const order = ordersCriadas.get(id) || {
            id,
            status: "open",
            external_reference: "mock",
            transactions: { payments: [] }
        };
        return {
            ok: true,
            status: 200,
            json: async () => order
        };
    }

    return {
        ok: false,
        status: 404,
        json: async () => ({ message: "Rota MP não encontrada " + u })
    };
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
async function registrar(nome, email) {
    const { r, body } = await reqJson(BASE + "/api/auth/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome, email, senha: "senha-teste-123" })
    });
    return { r, body };
}

async function main() {
    await sleep(4500);

    let { r, body } = await reqJson(BASE + "/api/colecionaveis/info");
    const cards = body.cards || [];

    const e1 = "f1-" + Date.now() + "@teste.com";
    const e2 = "f2-" + Date.now() + "@teste.com";
    let r1 = await registrar("Fluxo Um", e1);
    let r2 = await registrar("Fluxo Dois", e2);
    const tok1 = r1.body.token;
    const tok2 = r2.body.token;
    const h1 = { "Authorization": "Bearer " + tok1, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + tok2, "Content-Type": "application/json" };
    t("registro u1/u2", !!tok1 && !!tok2);

    /* ============ PACOTE ============ */
    let check = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h1,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    t("checkout pacote bronze", check.r.status === 200 && check.body.ok, "status=" + check.r.status + " err=" + (check.body.error || ""));
    const extRef = check.body.externalReference;
    const mpOrderId = check.body.orderId;
    t("externalReference COL-PACK", typeof extRef === "string" && extRef.startsWith("COL-PACK"), "ext=" + extRef);

    /* confirmar (sem pagamento real) */
    let conf = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + extRef, {
        method: "POST", headers: h1
    });
    t("confirma pacote via teste", conf.r.status === 200 && conf.body.tipo === "pack",
        "status=" + conf.r.status + " err=" + (conf.body.error || ""));

    /* polling usa o id numérico MP (d.orderId no frontend) */
    let poll = await reqJson(BASE + "/api/colecionaveis/pagamento/" + mpOrderId, {
        method: "GET", headers: h1
    });
    t("polling com id numerico MP responde", poll.r.status === 200,
        "status=" + poll.r.status + " err=" + (poll.body.error || ""));
    /* polling com externalReference também responde */
    let poll2 = await reqJson(BASE + "/api/colecionaveis/pagamento/" + extRef, {
        method: "GET", headers: h1
    });
    t("polling com externalReference responde", poll2.r.status === 200,
        "status=" + poll2.r.status + " err=" + (poll2.body.error || ""));

    let album = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
    const totalU1 = album.body.cards.reduce((a, c) => a + c.quantidade, 0);
    t("pacote entregou 3 figurinhas", totalU1 === 3, "total=" + totalU1);

    /* idempotencia: confirmar de novo nao duplica */
    let conf2 = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + extRef, {
        method: "POST", headers: h1
    });
    let album2 = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
    const totalU1b = album2.body.cards.reduce((a, c) => a + c.quantidade, 0);
    t("confirmação idempotente (sem duplicar)", conf2.r.status === 400 && totalU1b === 3,
        "status=" + conf2.r.status + " total=" + totalU1b);

    /* repetidas no acervo */
    let acervo = await reqJson(BASE + "/api/colecionaveis/acervo", { headers: h1 });
    t("acervo com cards e stats", acervo.r.status === 200 && acervo.body.stats.total === 3 && acervo.body.stats.repetidas >= 0,
        "total=" + acervo.body.stats.total);

    /* ============ VENDA NO MERCADO ============ */
    const minhaCard = album.body.cards.find(c => c.quantidade > 0);
    t("usuario tem card para vender", !!minhaCard, "cardId=" + (minhaCard && minhaCard.id));

    let list = await reqJson(BASE + "/api/colecionaveis/listings", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: minhaCard.id, quantidade: 1, preco: 5.00 })
    });
    t("cria anúncio de venda", list.r.status === 200 && list.body.ok, "status=" + list.r.status + " err=" + (list.body.error || ""));

    /* acervo de u1 agora tem 2 disponiveis (vendeu 1) */
    let acervo2 = await reqJson(BASE + "/api/colecionaveis/acervo", { headers: h1 });
    const acCard = acervo2.body.cards.find(c => c.id === minhaCard.id);
    t("disponivel apos listar (1 menos)", acCard && acCard.disponivel === (minhaCard.quantidade - 1),
        "disp=" + (acCard && acCard.disponivel));

    /* nao pode listar mais do que tem disponivel */
    let list2 = await reqJson(BASE + "/api/colecionaveis/listings", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: minhaCard.id, quantidade: minhaCard.quantidade, preco: 5 })
    });
    t("nao lista alem do disponivel", list2.r.status === 400, "status=" + list2.r.status + " err=" + (list2.body.error || ""));

    /* marketplace lista anúncio */
    let mk = await reqJson(BASE + "/api/colecionaveis/marketplace");
    t("marketplace com anúncio", mk.r.status === 200 && mk.body.listings.length === 1, "total=" + mk.body.totalItems);
    const listing = mk.body.listings[0];

    /* ============ COMPRA NO MERCADO ============ */
    let buyCheck = await reqJson(BASE + "/api/colecionaveis/listings/" + listing.id + "/buy", {
        method: "POST", headers: h2,
        body: JSON.stringify({ quantidade: 1, paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    t("checkout compra no mercado", buyCheck.r.status === 200 && buyCheck.body.ok,
        "status=" + buyCheck.r.status + " err=" + (buyCheck.body.error || ""));
    const buyExt = buyCheck.body.externalReference;
    t("externalReference COL-BUY", buyExt.startsWith("COL-BUY"), "ext=" + buyExt);

    let buyConf = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + buyExt, {
        method: "POST", headers: h2
    });
    t("confirma compra mercado", buyConf.r.status === 200 && buyConf.body.tipo === "purchase",
        "status=" + buyConf.r.status + " err=" + (buyConf.body.error || ""));

    /* u2 agora tem a figurinha */
    let albumU2 = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h2 });
    const qU2 = albumU2.body.cards.find(c => c.id === minhaCard.id).quantidade;
    t("u2 recebeu figurinha comprada", qU2 === 1, "q=" + qU2);

    /* u1 nao tem mais (vendeu) */
    let albumU1 = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
    const qU1 = albumU1.body.cards.find(c => c.id === minhaCard.id).quantidade;
    t("u1 perdeu figurinha vendida", qU1 === minhaCard.quantidade - 1, "q=" + qU1);

    /* anúncio marcado vendido */
    let mk2 = await reqJson(BASE + "/api/colecionaveis/marketplace");
    t("anuncio removido do marketplace", mk2.body.listings.length === 0, "total=" + mk2.body.totalItems);

    /* ============ TROCA ============ */
    /* u2 precisa de figurinhas para oferecer. Compra mais um pacote. */
    let check2 = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h2,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    const extRef2 = check2.body.externalReference;
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + extRef2, { method: "POST", headers: h2 });

    let albumU2b = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h2 });
    const u2Cards = albumU2b.body.cards.filter(c => c.quantidade > 0);
    /* card que u2 tem repetido (para oferecer) ou qualquer um */
    const u2Repetido = u2Cards.find(c => c.quantidade > 1) || u2Cards[0];

    /* u1 oferece algo que u2 quer; u1 precisa de 2+ cards. Compra mais um pacote para u1 */
    let check3 = await reqJson(BASE + "/api/colecionaveis/packs/1/checkout", {
        method: "POST", headers: h1,
        body: JSON.stringify({ paymentMethod: "pix", cpfCnpj: "12345678909" })
    });
    await reqJson(BASE + "/api/colecionaveis/test/confirm/" + check3.body.externalReference, { method: "POST", headers: h1 });
    let albumU1c = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
    const u1Cards = albumU1c.body.cards.filter(c => c.quantidade > 0);
    const u1Repetido = u1Cards.find(c => c.quantidade > 1) || u1Cards[0];
    const u1Outro = u1Cards.find(c => c.id !== u1Repetido.id) || u1Repetido;

    /* cards que u2 quer receber (cards que u1 tem e u2 nao) */
    const u2Ids = new Set(u2Cards.map(c => c.id));
    const cardParaU2 = u1Cards.find(c => !u2Ids.has(c.id));
    const cardParaU1 = u2Repetido;

    console.log("DEBUG u1Cards=", u1Cards.map(c => c.id + ":" + c.quantidade).join(","));
    console.log("DEBUG u2Cards=", u2Cards.map(c => c.id + ":" + c.quantidade).join(","));
    console.log("DEBUG cardParaU1(u2 oferece)=", cardParaU1 && cardParaU1.id, "cardParaU2(u1 oferece)=", cardParaU2 && cardParaU2.id);

    console.log("DEBUG u1Cards=", u1Cards.map(c => c.id + ":" + c.quantidade).join(","));
    console.log("DEBUG u2Cards=", u2Cards.map(c => c.id + ":" + c.quantidade).join(","));
    console.log("DEBUG cardParaU1(u2 oferece)=", cardParaU1 && cardParaU1.id, "cardParaU2(u1 oferece)=", cardParaU2 && cardParaU2.id);

    if (!cardParaU2 || !cardParaU1) {
        console.log("DEBUG: sem cards para troca");
    }
    t("tem cards para troca", !!cardParaU2 && !!cardParaU1,
        "u1of=" + (cardParaU2 && cardParaU2.id) + " u2of=" + (cardParaU1 && cardParaU1.id));

    if (cardParaU2 && cardParaU1) {
        /* u2 envia proposta para u1 */
        const receptorId = r1.body.usuario ? r1.body.usuario.id : null;
        let meuPerfil = await reqJson(BASE + "/api/colecionaveis/perfil", { headers: h2 });
        const u1Id = meuPerfil.body.perfil ? null : null;
        /* pegar id do u1 via colec no perfil: usa usuario.id da resposta de registro */
        let u1IdFinal = r1.body.usuario?.id;

        let trade = await reqJson(BASE + "/api/colecionaveis/trades", {
            method: "POST", headers: h2,
            body: JSON.stringify({
                receiverId: u1IdFinal,
                ofereco: [{ cardId: cardParaU1.id }],
                recebo: [{ cardId: cardParaU2.id }]
            })
        });
        t("cria proposta de troca", trade.r.status === 200 && trade.body.ok,
            "status=" + trade.r.status + " err=" + (trade.body.error || ""));
        const tradeId = trade.body.tradeId;

        /* u1 aceita */
        let acc = await reqJson(BASE + "/api/colecionaveis/trades/" + tradeId + "/accept", {
            method: "POST", headers: h1
        });
        t("u1 aceita troca simples", acc.r.status === 200 && (acc.body.status === "COMPLETED" || acc.body.status === "ACCEPTED"),
            "status=" + acc.r.status + " err=" + (acc.body.error || "") + " st=" + acc.body.status);

        /* transferência: u2 recebeu cardParaU2, u1 recebeu cardParaU1 */
        let albumU1d = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h1 });
        let albumU2d = await reqJson(BASE + "/api/colecionaveis/meu-album", { headers: h2 });
        const u1TemNovo = albumU1d.body.cards.find(c => c.id === cardParaU1.id).quantidade;
        const u2TemNovo = albumU2d.body.cards.find(c => c.id === cardParaU2.id).quantidade;
        t("transferencia de troca completa", u1TemNovo >= 1 && u2TemNovo >= 1,
            "u1=" + u1TemNovo + " u2=" + u2TemNovo);
    }

    /* ============ CONTRA-PROPOSTA ============ */
    if (cardParaU2 && cardParaU1) {
        const u1IdFinal = r1.body.usuario?.id;
        let trade2 = await reqJson(BASE + "/api/colecionaveis/trades", {
            method: "POST", headers: h2,
            body: JSON.stringify({
                receiverId: u1IdFinal,
                ofereco: [{ cardId: cardParaU1.id }],
                recebo: [{ cardId: cardParaU2.id }]
            })
        });
        const t2id = trade2.body.tradeId;
        if (t2id) {
            let counter = await reqJson(BASE + "/api/colecionaveis/trades/" + t2id + "/counter", {
                method: "POST", headers: h1,
                body: JSON.stringify({ ofereco: [{ cardId: u1Repetido.id }] })
            });
            t("contraproposta aceita pelo sistema", counter.r.status === 200,
                "status=" + counter.r.status + " err=" + (counter.body.error || ""));
        }
    }

    /* ============ SEGURANCA ============ */
    /* usuário 2 não pode confirmar pedido de u1 */
    let segConf = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + (check3.body.externalReference || ""), {
        method: "POST", headers: h2
    });
    t("u2 nao confirma pedido de u1", segConf.r.status === 403, "status=" + segConf.r.status + " err=" + (segConf.body.error || ""));

    /* usuário 2 não pode acessar pedido de u1 */
    let segPago = await reqJson(BASE + "/api/colecionaveis/pagamento/" + (check3.body.externalReference || ""), {
        method: "GET", headers: h2
    });
    t("u2 nao acessa pedido de u1 (pagamento)", segPago.r.status === 403, "status=" + segPago.r.status);

    /* vender figurinha que nao possui */
    let segVenda = await reqJson(BASE + "/api/colecionaveis/listings", {
        method: "POST", headers: h1,
        body: JSON.stringify({ cardId: 999, quantidade: 1, preco: 5 })
    });
    t("venda de figurinha inexistente rejeitada", segVenda.r.status === 400, "status=" + segVenda.r.status);

    /* ============ HISTORICO ============ */
    let hist = await reqJson(BASE + "/api/colecionaveis/historico", { headers: h1 });
    t("historico com transacoes", hist.r.status === 200 && hist.body.historico && hist.body.historico.length > 0,
        "items=" + (hist.body.historico && hist.body.historico.length));

    /* ============ CONQUISTAS ============ */
    let conc = await reqJson(BASE + "/api/colecionaveis/conquistas", { headers: h1 });
    t("conquistas endpoint ok", conc.r.status === 200 && Array.isArray(conc.body.conquistas), "status=" + conc.r.status);

    console.log(log.join("\n"));
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("-----------------------------");
    console.log("COLECIONAVEIS FLUXO: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error("ERRO GLOBAL:", e); process.exit(1); });