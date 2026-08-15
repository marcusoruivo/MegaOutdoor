/* =========================================================
   TESTE — FIGURINHAS ANIMAIS DO MUNDO (CORREÇÃO 7 / PARTE 2)
   =========================================================
   Coleção de 100 ESPÉCIES REAIS com dados científicos.
   Sorteio do pacote PERSISTIDO (abre UMA vez; refresh devolve
   as MESMAS figurinhas). Backend é a autoridade do resultado.

   Cenários:
   1) catálogo: 100 cartas, distribuição 60/25/9/4/1/1
   2) dados científicos presentes (scientific_name/habitat/peso)
   3) pacote pago: sorteio persistido e idempotente
   4) /pagamento devolve o pacote já sorteado
   5) /figurinha expõe dados científicos
   6) admin edita dados científicos

   Usa mocks realistas do Mercado Pago. NÃO faz commit/push/deploy.
========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3252";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colanim-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

let seq = 1;
const ordersCriadas = new Map();
const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) return fetchOriginal(url, options);
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    if (u.endsWith("/v1/orders") && method === "POST") {
        const id = "ORDAN" + String(seq++).padStart(6, "0");
        const order = {
            id, status: "open",
            total_amount: body && body.total_amount ? String(body.total_amount) : "1.00",
            external_reference: body.external_reference,
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
        const order = ordersCriadas.get(id) || {
            id, status: "paid", total_amount: "1.00", external_reference: "mock",
            transactions: { payments: [{ id: "pay-" + id, status: "paid",
                status_detail: "accredited",
                payment_method: { id: "pix", type: "bank_transfer",
                    qr_code_base64: "bW9jaw==", qr_code: "000201mock" } }] }
        };
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

const BASE = "http://localhost:3252";
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

    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    const adminTok = (login.body && login.body.token) || "";
    t("login admin ok", !!adminTok);

    /* ===== 1) Coleção ===== */
    const info = await reqJson(BASE + "/api/colecionaveis/info", json("GET", null));
    const colecao = info.body.colecao || {};
    t("1) coleção ANIMAIS DO MUNDO", colecao.name === "MILHÃO DOOR — ANIMAIS DO MUNDO",
        "name=" + colecao.name);
    t("2) total de 100 figurinhas", Number(colecao.total) === 100,
        "total=" + colecao.total);

    const packs = info.body.packs || [];
    t("3) 4 pacotes ativos", packs.length === 4,
        "n=" + packs.length);
    const bronze = packs.find(p => p.slug === "bronze");
    t("4) pacote bronze com 3 figurinhas", !!bronze && Number(bronze.sticker_quantity) === 3,
        "qtd=" + (bronze && bronze.sticker_quantity));

    /* ===== 5) Catálogo ===== */
    const cat = await reqJson(BASE + "/api/colecionaveis/catalogo", json("GET", null));
    const cards = cat.body.cards || [];
    t("5) catálogo com 100 cartas", cat.r.status === 200 && cards.length === 100,
        "n=" + cards.length);

    const contagem = {};
    for (const c of cards) contagem[c.rarity] = (contagem[c.rarity] || 0) + 1;
    t("6) distribuição de raridade 60/25/9/4/1/1",
        contagem.COMUM === 60 && contagem.INCOMUM === 25 &&
        contagem.RARA === 9 && contagem.EPICA === 4 &&
        contagem.LENDARIA === 1 && contagem.MITICA === 1,
        "c=" + JSON.stringify(contagem));

    t("7) todas as cartas com nome científico",
        cards.length === 100 && cards.every(c =>
            typeof c.scientific_name === "string" && c.scientific_name.trim().length > 0),
        "sem-nome=" + cards.filter(c => !c.scientific_name).length);
    t("8) todas as cartas com habitat e peso",
        cards.every(c =>
            typeof c.habitat === "string" && c.habitat.trim().length > 0 &&
            typeof c.peso === "string" && c.peso.trim().length > 0),
        "sem-habitat=" + cards.filter(c => !c.habitat).length +
        " sem-peso=" + cards.filter(c => !c.peso).length);

    const lendaria = cards.find(c => c.rarity === "LENDARIA");
    t("9) LENDÁRIA é a Baleia-azul (Balaenoptera musculus)",
        !!lendaria && lendaria.name === "Baleia-azul" &&
        lendaria.scientific_name === "Balaenoptera musculus",
        "name=" + (lendaria && lendaria.name) + " sn=" + (lendaria && lendaria.scientific_name));

    const mitica = cards.find(c => c.rarity === "MITICA");
    t("10) MÍTICA é a Lula-colossal (Mesonychoteuthis hamiltoni)",
        !!mitica && mitica.name === "Lula-colossal" &&
        mitica.scientific_name === "Mesonychoteuthis hamiltoni",
        "name=" + (mitica && mitica.name));

    /* ===== 11) Compra e confirmação do pacote ===== */
    const email = "anim-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Anim Test", email, senha: "senha-teste-123" }));
    const userTok = (reg.body && reg.body.token) || "";
    t("11) registro usuário", !!userTok);

    const ck = await reqJson(BASE + "/api/colecionaveis/packs/" + bronze.id + "/checkout",
        json("POST", userTok, { paymentMethod: "pix", cpfCnpj: "12345678909" }));
    t("12) checkout do pacote bronze", ck.r.status === 200 && ck.body.ok &&
        !!ck.body.externalReference && !!ck.body.orderId,
        "status=" + ck.r.status + " ext=" + ck.body.externalReference);
    const extRef = ck.body.externalReference;
    const mpId = String(ck.body.orderId);

    const conf = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + extRef, json("POST", userTok));
    t("13) confirmação do pagamento (sorteio)", conf.r.status === 200 && conf.body.tipo === "pack",
        "status=" + conf.r.status);

    /* Reflete o que acontece no mundo real: pagamento aprovado no MP
       -> a Order fica paid. O test/confirm grava a compra; aqui também
       marcamos a Order do mock para o polling enxergar RECEIVED. */
    const ordemMock = ordersCriadas.get(mpId);
    if (ordemMock) {
        ordemMock.status = "paid";
        ordemMock.total_amount = String(ck.body.valor || bronze.price);
        ordemMock.transactions.payments[0].status = "paid";
        ordemMock.transactions.payments[0].status_detail = "accredited";
    }

    /* ===== 14) Sorteio persistido, idempotente ===== */
    const poll1 = await reqJson(BASE + "/api/colecionaveis/pagamento/" + extRef, json("GET", userTok));
    const pacote1 = poll1.body.pacote;
    const ids1 = (pacote1 && pacote1.figurinhas || []).map(f => f.id);
    t("14) /pagamento RECEIVED devolve pacote com 3 figurinhas",
        poll1.r.status === 200 && poll1.body.status === "RECEIVED" &&
        !!pacote1 && Array.isArray(pacote1.figurinhas) && pacote1.figurinhas.length === 3 &&
        ids1.length === new Set(ids1).size,
        "qtd=" + (pacote1 && pacote1.figurinhas.length));

    const poll2 = await reqJson(BASE + "/api/colecionaveis/pagamento/" + extRef, json("GET", userTok));
    const ids2 = (poll2.body.pacote && poll2.body.pacote.figurinhas || []).map(f => f.id);
    t("15) refresh devolve as MESMAS figurinhas (sorteio persistido)",
        JSON.stringify(ids2) === JSON.stringify(ids1),
        "ids1=" + JSON.stringify(ids1) + " ids2=" + JSON.stringify(ids2));

    const pollMp = await reqJson(BASE + "/api/colecionaveis/pagamento/" + mpId, json("GET", userTok));
    const idsMp = (pollMp.body.pacote && pollMp.body.pacote.figurinhas || []).map(f => f.id);
    t("16) polling pelo id numérico do MP devolve o mesmo pacote",
        pollMp.r.status === 200 && pollMp.body.status === "RECEIVED" &&
        JSON.stringify(idsMp) === JSON.stringify(ids1),
        "status=" + pollMp.r.status + " mp=" + pollMp.body.status);

    /* ===== 17) Figurinhas no álbum ===== */
    const album = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", userTok));
    const totalAlbum = (album.body.cards || []).reduce((s, c) => s + Number(c.quantidade || 0), 0);
    t("17) álbum recebeu 3 figurinhas do pacote", totalAlbum === 3, "total=" + totalAlbum);

    const alguma = (album.body.cards || []).find(c => c.quantidade > 0);
    t("18) dados científicos no meu-album",
        !!alguma && typeof alguma.scientific_name === "string" &&
        typeof alguma.habitat === "string" && typeof alguma.peso === "string",
        "sn=" + (alguma && alguma.scientific_name));

    /* ===== 19) /figurinha expõe dados científicos ===== */
    const fig = await reqJson(BASE + "/api/colecionaveis/figurinha/" + alguma.id, json("GET", userTok));
    t("19) /figurinha expõe scientific_name/habitat/peso",
        fig.r.status === 200 &&
        typeof fig.body.card.scientific_name === "string" &&
        fig.body.card.scientific_name === alguma.scientific_name,
        "sn=" + (fig.body.card && fig.body.card.scientific_name));

    /* ===== 20) Admin edita dados científicos ===== */
    const alvoAdmin = await reqJson(BASE + "/api/colecionaveis/admin/cards", json("GET", adminTok));
    const alvo = (alvoAdmin.body.cards || []).find(c => c.rarity === "COMUM") || (alvoAdmin.body.cards || [])[0];
    const ed = await reqJson(BASE + "/api/colecionaveis/admin/cards/" + alvo.id, json("POST", adminTok, {
        scientific_name: "Panthera leo editada",
        habitat: "Savana africana (editada)",
        peso: "150 kg (editado)"
    }));
    const apos = await reqJson(BASE + "/api/colecionaveis/admin/cards", json("GET", adminTok));
    const cartaApos = (apos.body.cards || []).find(c => c.id === alvo.id);
    t("20) admin edita scientific_name/habitat/peso e persiste",
        ed.r.status === 200 && ed.body.ok &&
        cartaApos.scientific_name === "Panthera leo editada" &&
        cartaApos.habitat === "Savana africana (editada)" &&
        cartaApos.peso === "150 kg (editado)",
        "status=" + ed.r.status + " sn=" + (cartaApos && cartaApos.scientific_name));

    /* ---- resultado ---- */
    const falhas = log.filter(l => l.startsWith("FAIL"));
    console.log("\n=== RESULTADO test-col-animais ===");
    for (const l of log) console.log(l);
    console.log("\nTotal: " + log.length + " | Passou: " + (log.length - falhas.length) + " | Falhou: " + falhas.length);
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
