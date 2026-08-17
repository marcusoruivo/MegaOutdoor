/* Teste avançado da rotina: senha-recuperação, espaços (usuarioId/link),
   destaques, chat conversas, oferta CONTRAPROPOSTA, pay resume. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3198";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "rotina-" + Date.now());
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

const BASE = "http://localhost:3198";
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

async function main() {
    await sleep(4500);
    const e1 = "u1-" + Date.now() + "@teste.com";
    const e2 = "u2-" + Date.now() + "@teste.com";
    const r1 = await registrar("User Um", e1);
    const r2 = await registrar("User Dois", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    t("registro de 2 usuários", !!u1Id && !!u2Id);

    /* --- AUTH: login/me/logout --- */
    let resp = await reqJson(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e1, senha: "senha-teste-123" })
    });
    t("login ok", resp.r.status === 200 && !!resp.body.token, "status=" + resp.r.status);
    const h1b = { "Authorization": "Bearer " + resp.body.token, "Content-Type": "application/json" };

    resp = await reqJson(BASE + "/api/auth/me", { headers: h1b });
    t("/api/auth/me com token", resp.r.status === 200 && resp.body.usuario?.email === e1, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/auth/me", {});
    t("/api/auth/me sem token -> 401", resp.r.status === 401, "status=" + resp.r.status);

    /* --- SENHA-RECUPERAÇÃO --- */
    resp = await reqJson(BASE + "/api/auth/senha-recuperacao", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "inexistente@teste.com" })
    });
    t("recuperação email inexistente -> 200 (não revela)", resp.r.status === 200 && resp.body.ok === true && !resp.body.testeToken, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/auth/senha-recuperacao", {
        method: "POST", headers: { "Content-Type": "application/json", "x-test-mode": "1" },
        body: JSON.stringify({ email: e1 })
    });
    t("recuperação email existente + testeToken", resp.r.status === 200 && !!resp.body.testeToken, "status=" + resp.r.status);
    const tokenReset = resp.body.testeToken;

    resp = await reqJson(BASE + "/api/auth/redefinir-senha", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenReset, novaSenha: "nova-senha-456" })
    });
    t("redefinir senha com token válido", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e1, senha: "nova-senha-456" })
    });
    t("login com nova senha", resp.r.status === 200 && !!resp.body.token, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/auth/redefinir-senha", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenReset, novaSenha: "outra-senha-789" })
    });
    t("redefinir com token usado -> 400", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/auth/redefinir-senha", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "token-invalido", novaSenha: "qualquer-coisa" })
    });
    t("redefinir com token inválido -> 400", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/auth/redefinir-senha", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "qualquer", novaSenha: "123" })
    });
    t("redefinir senha fraca -> 400", resp.r.status === 400, "status=" + resp.r.status);

    /* --- ESPAÇOS: checkout test mode + usuarioId --- */
    resp = await reqJson(BASE + "/api/test/reserve", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ spaces: [1001, 1002], name: "User Um", email: e1 })
    });
    t("reserva em modo teste cria espaços paid", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/spaces", {});
    const sp1001 = resp.body[1001];
    t("espaço 1001 tem status paid", sp1001 && sp1001.status === "paid", "status=" + (sp1001 && sp1001.status));
    t("espaço 1001 tem usuarioId do comprador", sp1001 && sp1001.usuarioId === u1Id, "uid=" + (sp1001 && sp1001.usuarioId));
    t("espaço 1002 tem usuarioId do comprador", resp.body[1002] && resp.body[1002].usuarioId === u1Id, "uid=" + (resp.body[1002] && resp.body[1002].usuarioId));

    /* --- /api/link: ownership --- */
    resp = await reqJson(BASE + "/api/link", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ ids: [1001], link: "https://meusite.com" })
    });
    t("/api/link pelo dono -> 200", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/link", {
        method: "POST", headers: h2,
        body: JSON.stringify({ ids: [1001], link: "https://outro.com" })
    });
    t("/api/link por outro usuário -> 403", resp.r.status === 403, "status=" + resp.r.status);

    /* --- DESTAQUES: validações --- */
    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duracao: "24h", titulo: "Teste", cpfCnpj: "12345678909" })
    });
    t("destaque sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ duracao: "99h", titulo: "Teste", cpfCnpj: "12345678909" })
    });
    t("destaque duração inválida -> 400", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ duracao: "24h", titulo: "Teste", cpfCnpj: "000" })
    });
    t("destaque CPF inválido -> 400", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ duracao: "24h", cpfCnpj: "12345678909" })
    });
    t("destaque sem título -> 400", resp.r.status === 400, "status=" + resp.r.status);

    /* --- DESTAQUE: criação + validações --- */
    resp = await reqJson(BASE + "/api/stories/destaques", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ duracao: "24h", titulo: "Destaque Teste", subtitulo: "Sub", cpfCnpj: "12345678909", paymentMethod: "pix" })
    });
    t("destaque criado (pendente)", resp.r.status === 200 && resp.body.ok === true && resp.body.id, "status=" + resp.r.status + " id=" + resp.body.id);
    const destaqueId = resp.body.id;
    t("destaque retorna totalCents correto (24h=4500)", resp.body.totalCents === 4500, "totalCents=" + resp.body.totalCents);

    resp = await reqJson(BASE + "/api/stories/destaques/meus", { headers: h1b });
    t("meus destaques lista o criado", resp.r.status === 200 && resp.body.destaques.some(d => d.id === destaqueId), "n=" + (resp.body.destaques || []).length);

    resp = await reqJson(BASE + "/api/stories/destaques/meus", { headers: h2 });
    t("meus destaques de outro usuário não vê", resp.r.status === 200 && !resp.body.destaques.some(d => d.id === destaqueId), "n=" + (resp.body.destaques || []).length);

    resp = await reqJson(BASE + "/api/stories/destaques/" + destaqueId, { headers: h1b });
    t("GET destaque/:id retorna status pendente", resp.r.status === 200 && resp.body.destaque.status === "pendente", "status=" + (resp.body.destaque && resp.body.destaque.status));

    resp = await reqJson(BASE + "/api/stories/destaques/" + destaqueId + "/publicar", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ titulo: "Publicado!", subtitulo: "Agora sim" })
    });
    t("publicar destaque pendente -> 403", resp.r.status === 403, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/destaques/" + destaqueId, { headers: h2 });
    t("GET destaque de outro usuário -> 404", resp.r.status === 404, "status=" + resp.r.status);

    /* --- COLECIONÁVEIS: chat conversas + oferta CONTRAPROPOSTA --- */
    let c1 = await comprarPacote(h1b);
    let c2 = await comprarPacote(h2);
    t("u1 e u2 tem cards", c1.length > 0 && c2.length > 0, "u1=" + c1.length + " u2=" + c2.length);
    if (!c1.length || !c2.length) { finalizar(); return; }

    const cardU2 = c2[0];
    resp = await reqJson(BASE + "/api/colecionaveis/offers", {
        method: "POST", headers: h1b,
        body: JSON.stringify({ cardId: cardU2.id, offereeId: u2Id, quantidade: 1, valor: 5 })
    });
    const ofertaId = resp.body.oferta && resp.body.oferta.id;
    t("oferta criada (PENDENTE)", resp.r.status === 201 && resp.body.oferta.status === "PENDENTE", "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/colecionaveis/offers/" + ofertaId + "/counter", {
        method: "POST", headers: h2,
        body: JSON.stringify({ quantidade: 1, valor: 6, mensagem: "contra 6" })
    });
    const novaId = resp.body.oferta && resp.body.oferta.id;
    t("contraproposta criada", resp.r.status === 201 && !!novaId, "status=" + resp.r.status);

    const mine1 = await reqJson(BASE + "/api/colecionaveis/offers/mine", { headers: h1b });
    const origOferta = mine1.body.enviadas.find(o => o.id === ofertaId);
    t("oferta original vira CONTRAPROPOSTA", origOferta && origOferta.status === "CONTRAPROPOSTA", "status=" + (origOferta && origOferta.status));

    const mine2 = await reqJson(BASE + "/api/colecionaveis/offers/mine", { headers: h2 });
    const contraOferta = mine2.body.enviadas.find(o => o.id === novaId);
    t("contraproposta está PENDENTE para o oferente original", contraOferta && contraOferta.status === "PENDENTE", "status=" + (contraOferta && contraOferta.status));

    /* --- CHAT CONVERSAS --- */
    resp = await reqJson(BASE + "/api/colecionaveis/chat/conversas", { headers: h1b });
    t("chat conversas lista", resp.r.status === 200 && Array.isArray(resp.body.conversas), "n=" + (resp.body.conversas || []).length);

    resp = await reqJson(BASE + "/api/colecionaveis/chat/conversas", { headers: h2 });
    t("chat conversas do vendedor lista", resp.r.status === 200 && Array.isArray(resp.body.conversas), "n=" + (resp.body.conversas || []).length);

    /* --- CONFIG / SEGURANÇA --- */
    resp = await reqJson(BASE + "/api/config", {});
    t("/api/config retorna allowTestMode", resp.r.status === 200 && resp.body.allowTestMode === true, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/stories/config", {});
    t("/api/stories/config retorna pricing", resp.r.status === 200 && resp.body.pricing && resp.body.pricing["24h"] === 45, "24h=" + (resp.body.pricing && resp.body.pricing["24h"]));

    resp = await reqJson(BASE + "/api/colecionaveis/diagnostico/pagamentos", { headers: h1b });
    t("diagnóstico não expõe tokens", resp.r.status === 200 && !JSON.stringify(resp.body).includes("access_token_enc"), "status=" + resp.r.status);

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("ROTINA AVANÇADA: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
