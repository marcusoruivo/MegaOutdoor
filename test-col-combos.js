/* Valida os sistemas de Combos & Kits e de Bugs/Sugestões. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3198";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colcombos-" + Date.now());
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
        const order = ordersCriadas.get(id);
        if (!order) {
            return { ok: false, status: 404, json: async () => ({ message: "Order not found", status: 404, error: "not_found" }) };
        }
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

    /* ===== Acessos ===== */
    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    t("login admin ok", login.r.status === 200 && !!login.body.token);
    const adminTok = login.body.token || "";

    const email = "combo-test-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Combo Test", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário comum", !!userTok);

    const email2 = "combo-test-2-" + Date.now() + "@teste.com";
    const reg2 = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Combo Test 2", email: email2, senha: "senha-teste-123" }));
    const userTok2 = reg2.body.token || "";
    t("registro segundo usuário", !!userTok2);

    /* ===== Kits públicos ===== */
    const kits = await reqJson(BASE + "/api/combos/kits");
    const lista = kits.body.kits || [];
    t("5 kits padrão semeados", kits.r.status === 200 && lista.length === 5,
        "n=" + lista.length);
    const premium = lista.find(k => k.slug === "premium");
    t("kit premium destaque e preço", !!premium && premium.destaque === "MAIS VENDIDO" &&
        premium.preco === 38.25 && premium.precoNormal === 45,
        "preco=" + (premium && premium.preco) + " normal=" + (premium && premium.precoNormal));
    const lendario = lista.find(k => k.slug === "lendario");
    t("kit lendário preço", !!lendario && lendario.preco === 131.2,
        "preco=" + (lendario && lendario.preco));
    t("kits expõem licenças", lista.every(k => typeof k.licencas === "object" &&
        k.licencas && Object.keys(k.licencas).length === 3),
        "licencas=" + JSON.stringify(premium && premium.licencas));
    t("kits expõem pacotes com id", lista.every(k => Array.isArray(k.pacotes) &&
        k.pacotes.every(p => typeof p.pack_id === "number" && p.pack_id > 0)),
        "packs de premium=" + JSON.stringify(premium && premium.pacotes));
    t("todos os kits são mais baratos que a compra separada",
        lista.every(k => k.preco < k.precoSeparado),
        "ex=" + JSON.stringify(lista.map(k => ({ slug: k.slug, preco: k.preco, separado: k.precoSeparado }))));

    const cpfValido = "12345678909";
    const checkoutBody = (plano) => ({
        licensePlan: plano,
        cpfCnpj: cpfValido,
        paymentMethod: "pix",
        aceiteRegras: true
    });

    /* ===== Checkout sem token -> 401 ===== */
    const ckSemToken = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout", json("POST", null, { licensePlan: 1 }));
    t("checkout sem token -> 401", ckSemToken.r.status === 401, "status=" + ckSemToken.r.status);

    /* ===== Checkout sem CPF -> 400 ===== */
    const ckSemCpf = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, { licensePlan: "1_year", aceiteRegras: true }));
    t("checkout sem CPF -> 400", ckSemCpf.r.status === 400, "status=" + ckSemCpf.r.status);

    /* ===== Checkout sem aceite -> 400 ===== */
    const ckSemRegras = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, { licensePlan: "1_year", cpfCnpj: cpfValido }));
    t("checkout sem aceite -> 400", ckSemRegras.r.status === 400, "status=" + ckSemRegras.r.status);

    /* ===== Checkout ===== */
    const ck = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("1_year")));
    const compra = ck.body;
    t("checkout kit ok", ck.r.status === 200 && compra.valor === 38.25 && compra.externalReference &&
        compra.externalReference.startsWith("KIT-"), "valor=" + compra.valor);
    t("checkout retorna meios de pagamento", !!compra.paymentMethod && compra.paymentStatus === "pending" &&
        typeof compra.paid === "boolean", "method=" + compra.paymentMethod);

    /* ===== Checkout com licença (taxa única) ===== */
    const ck5 = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("5_years")));
    t("checkout licença 5 anos soma taxa única", ck5.r.status === 200 && ck5.body.valor === 78.25,
        "valor=" + ck5.body.valor);
    const ck5b = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok2, checkoutBody("5_years")));
    t("taxa única independe do usuário", ck5b.body.valor === 78.25, "valor=" + ck5b.body.valor);

    /* ===== CORREÇÃO 4 — TOTAL DO KIT COM 1/3/5 ANOS =====
       Taxa única por pedido: 1 ANO=0, 3 ANOS=+20, 5 ANOS=+40.
       Fórmula: base (já com o desconto do kit) + taxa DA licença.
       Frontend e backend usam a MESMA fórmula (base + fee uma vez). */
    const frontendHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    t("C4) frontend usa base + fee UMA única vez (sem multiplicar)",
        frontendHtml.includes("Number(kit.preco) + Number(lic.fee)"),
        "formula=" + /Number\(kit\.preco\) \+ Number\(lic\.fee\)/.test(frontendHtml));
    t("C4) dataset.kitId gravado no elemento correto (kitLicencas)",
        frontendHtml.includes('document.getElementById("kitLicencas").dataset.kitId = kit.id;') &&
        !frontendHtml.includes('getElementById("kitModalLicencas").dataset.kitId'),
        "fix=" + frontendHtml.includes('document.getElementById("kitLicencas").dataset.kitId = kit.id;'));

    const taxas = { "1_year": 0, "3_years": 20, "5_years": 40 };
    for (const k of lista) {
        for (const plano of ["1_year", "3_years", "5_years"]) {
            const ckPlano = await reqJson(BASE + "/api/combos/kits/" + k.id + "/checkout",
                json("POST", userTok, checkoutBody(plano)));
            const esperado = Math.round((Number(k.preco) + taxas[plano]) * 100) / 100;
            t("C4) kit '" + k.slug + "' " + plano + " -> base + taxa (frontend=backend)",
                ckPlano.r.status === 200 && ckPlano.body.valor === esperado,
                "valor=" + ckPlano.body.valor + " esperado=" + esperado +
                " (preco=" + k.preco + " + taxa=" + taxas[plano] + ")");
        }
    }

    /* Taxa aplicada SOMENTE uma vez: 3 anos = base + 20; 5 anos = base + 40
       (NUNCA base + 20 + 40). */
    const ckTres = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("3_years")));
    t("C4) 3 anos soma a taxa UMA única vez (+20)",
        ckTres.r.status === 200 && ckTres.body.valor === Math.round((premium.preco + 20) * 100) / 100,
        "valor=" + ckTres.body.valor + " esperado=" + (Math.round((premium.preco + 20) * 100) / 100));
    const ckCinco = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("5_years")));
    t("C4) 5 anos soma a taxa UMA única vez (+40), sem acumular a de 3 anos",
        ckCinco.r.status === 200 && ckCinco.body.valor === Math.round((premium.preco + 40) * 100) / 100 &&
        (ckCinco.body.valor - premium.preco) === 40,
        "valor=" + ckCinco.body.valor + " esperado=" + (Math.round((premium.preco + 40) * 100) / 100));

    /* ===== BOTÃO "JÁ PAGUEI O PIX" — kits (/api/combos/pagamento/:id) ===== */
    const ckBtn = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("1_year")));
    const mpIdBtn = String(ckBtn.body.orderId);

    /* pending: status real, entrega aguardando, NADA entregue */
    const btnPend = await reqJson(BASE + "/api/combos/pagamento/" + ckBtn.body.externalReference, json("GET", userTok));
    t("botão kit pending -> status real + entrega aguardando",
        btnPend.r.status === 200 && btnPend.body.ok && btnPend.body.status !== "RECEIVED" &&
        btnPend.body.entrega === "aguardando",
        "status=" + btnPend.r.status + " st=" + btnPend.body.status);

    /* approved: MP pago -> RECEIVED + entrega confirmada (idempotente) */
    ordersCriadas.get(mpIdBtn).status = "paid";
    const btnOk = await reqJson(BASE + "/api/combos/pagamento/" + ckBtn.body.externalReference, json("GET", userTok));
    const btnOk2 = await reqJson(BASE + "/api/combos/pagamento/" + ckBtn.body.externalReference, json("GET", userTok));
    t("botão kit approved -> RECEIVED + entrega confirmada (clique repetido idempotente)",
        btnOk.r.status === 200 && btnOk.body.status === "RECEIVED" && btnOk.body.entrega === "confirmada" &&
        btnOk2.r.status === 200 && btnOk2.body.status === "RECEIVED",
        "st1=" + btnOk.body.status + " st2=" + btnOk2.body.status);

    /* rejected: MP responde rejeitado -> status real retornado (nada entregue) */
    const ckBtnRej = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok2, checkoutBody("1_year")));
    ordersCriadas.get(String(ckBtnRej.body.orderId)).status = "rejected";
    const btnRej = await reqJson(BASE + "/api/combos/pagamento/" + ckBtnRej.body.externalReference, json("GET", userTok2));
    t("botão kit rejected -> status real retornado, nada entregue",
        btnRej.r.status === 200 && btnRej.body.status === "rejected" && btnRej.body.entrega === "aguardando",
        "status=" + btnRej.r.status + " st=" + btnRej.body.status);

    /* Order inexistente (MP 404) -> 404, sem quebrar */
    const ckBtnInex = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("1_year")));
    ordersCriadas.delete(String(ckBtnInex.body.orderId));
    const btnInex = await reqJson(BASE + "/api/combos/pagamento/" + ckBtnInex.body.externalReference, json("GET", userTok));
    t("botão kit Order inexistente (404) -> 404",
        btnInex.r.status === 404,
        "status=" + btnInex.r.status + " body=" + JSON.stringify(btnInex.body));

    /* Order de OUTRO usuário -> 403 */
    const ckBtnOutro = await reqJson(BASE + "/api/combos/kits/" + premium.id + "/checkout",
        json("POST", userTok, checkoutBody("1_year")));
    const btnOutro = await reqJson(BASE + "/api/combos/pagamento/" + ckBtnOutro.body.externalReference, json("GET", userTok2));
    t("botão kit order de outro usuário -> 403",
        btnOutro.r.status === 403,
        "status=" + btnOutro.r.status);

    /* ===== Status antes de pagar ===== */
    const antes = await reqJson(BASE + "/api/combos/pagamento/" + ck.body.externalReference, json("GET", userTok));
    t("pedido pendente antes do pagamento", antes.r.status === 200 &&
        antes.body.status !== "RECEIVED" && antes.body.entrega === "aguardando",
        "status=" + antes.body.status);

    /* ===== Confirmar pagamento ===== */
    const conf = await reqJson(BASE + "/api/combos/test/confirm/" + ck.body.externalReference, json("POST", userTok));
    t("confirmar pagamento kit", conf.r.status === 200 && conf.body.ok && conf.body.tipo === "kit");

    const depois = await reqJson(BASE + "/api/combos/pagamento/" + ck.body.externalReference, json("GET", userTok));
    t("polling responde após confirmação", depois.r.status === 200,
        "status=" + depois.r.status + " entrega=" + depois.body.entrega);

    /* ===== Idempotência: confirmar de novo não duplica ===== */
    const acervo1 = await reqJson(BASE + "/api/colecionaveis/acervo", json("GET", userTok));
    const total1 = (acervo1.body.stats && acervo1.body.stats.total) || 0;
    const conf2 = await reqJson(BASE + "/api/combos/test/confirm/" + ck.body.externalReference, json("POST", userTok));
    const acervo2 = await reqJson(BASE + "/api/colecionaveis/acervo", json("GET", userTok));
    const total2 = (acervo2.body.stats && acervo2.body.stats.total) || 0;
    t("confirmar de novo é ignorado (idempotência)", (conf2.r.status === 400 || conf2.body.ok) &&
        total1 === total2, "status=" + conf2.r.status + " total1=" + total1 + " total2=" + total2);

    /* ===== Entrega: espaços alocados + licença + pacotes ===== */
    const meus = await reqJson(BASE + "/api/combos/meus", json("GET", userTok));
    const compraPaga = (meus.body.compras || []).find(c => c.orderId === compra.externalReference);
    t("compra registrada como paid", !!compraPaga && compraPaga.status === "paid");
    t("licença de 1 ano aplicada", !!compraPaga && compraPaga.licenseMonths === 12);

    const acervo = await reqJson(BASE + "/api/colecionaveis/acervo", json("GET", userTok));
    const totalUser = (acervo.body.stats && acervo.body.stats.total) || 0;
    t("figurinhas entregues do kit (premium: 1 ouro + 2 prata)", totalUser > 0, "total=" + totalUser);

    /* ===== /meus bloqueia outro usuário? ===== */
    const meus2 = await reqJson(BASE + "/api/combos/meus", json("GET", userTok2));
    t("outro usuário não vê compras alheias", (meus2.body.compras || []).every(c => c.orderId !== compra.externalReference));

    /* ===== Admin: kits CRUD ===== */
    const adminKits = await reqJson(BASE + "/api/combos/admin/kits", json("GET", adminTok));
    t("admin lista kits", adminKits.r.status === 200 && adminKits.body.kits.length === 5);
    const semAdmin = await reqJson(BASE + "/api/combos/admin/kits", json("GET", userTok));
    t("admin kits sem token admin -> 401", semAdmin.r.status === 401, "status=" + semAdmin.r.status);

    const novo = await reqJson(BASE + "/api/combos/admin/kits", json("POST", adminTok, {
        nome: "KIT TESTE", slug: "kit-teste-" + Date.now(), descricao: "Kit criado no teste",
        precoNormal: 30, preco: 25, espacos: 5,
        pacotes: [{ pack_id: 1, quantidade: 1 }], bonus: "Bônus", destaque: "TESTE", sortOrder: 99
    }));
    t("admin cria kit", novo.r.status === 200 && novo.body.ok && novo.body.id > 0,
        "id=" + (novo.body && novo.body.id));
    const novoId = novo.body.id;

    const atu = await reqJson(BASE + "/api/combos/admin/kits/" + novoId, json("POST", adminTok, {
        preco: 20, precoNormal: 24, destaque: "NOVO"
    }));
    t("admin edita kit", atu.r.status === 200 && atu.body.ok);
    const aposEditar = await reqJson(BASE + "/api/combos/admin/kits", json("GET", adminTok));
    const kitEditado = (aposEditar.body.kits || []).find(k => k.id === novoId);
    t("edição persiste valores", !!kitEditado && kitEditado.preco === 20 &&
        kitEditado.preco_normal === 24 && kitEditado.destaque === "NOVO",
        "preco=" + (kitEditado && kitEditado.preco));

    const dupe = await reqJson(BASE + "/api/combos/admin/kits/" + novoId + "/duplicar", json("POST", adminTok));
    t("admin duplica kit", dupe.r.status === 200 && dupe.body.ok && dupe.body.id !== novoId);
    const apesDuplicar = await reqJson(BASE + "/api/combos/admin/kits", json("GET", adminTok));
    const kitDuplicado = (apesDuplicar.body.kits || []).find(k => k.id === dupe.body.id);
    t("cópia nasce inativa com nome de cópia", !!kitDuplicado &&
        (kitDuplicado.nome || "").indexOf("Cópia") !== -1 && kitDuplicado.is_active === false,
        "nome=" + (kitDuplicado && kitDuplicado.nome));

    const tog = await reqJson(BASE + "/api/combos/admin/kits/" + novoId + "/toggle", json("POST", adminTok));
    t("admin alterna ativação do kit", tog.r.status === 200 && tog.body.is_active === false);
    const tog2 = await reqJson(BASE + "/api/combos/admin/kits/" + novoId + "/toggle", json("POST", adminTok));
    t("admin reativa kit", tog2.r.status === 200 && tog2.body.is_active === true);

    /* ===== Vendas admin ===== */
    const vendas = await reqJson(BASE + "/api/combos/admin/vendas", json("GET", adminTok));
    const resumoVendas = vendas.body;
    t("vendas admin tem total e por kit", vendas.r.status === 200 &&
        typeof resumoVendas.totalReceita === "number" && resumoVendas.totalReceita >= 38.25 &&
        Array.isArray(resumoVendas.porKit) && resumoVendas.porKit.length > 0,
        "receita=" + resumoVendas.totalReceita + " kits=" + resumoVendas.porKit.length);

    const packsAdmin = await reqJson(BASE + "/api/combos/admin/packs", json("GET", adminTok));
    t("admin lista pacotes disponíveis", packsAdmin.r.status === 200 && packsAdmin.body.packs.length >= 4,
        "n=" + (packsAdmin.body.packs || []).length);

    /* ===== Bugs & Sugestões ===== */
    const bugSemAssunto = await reqJson(BASE + "/api/bugs", json("POST", null, { tipo: "bug", assunto: "", descricao: "x" }));
    t("bug sem assunto -> 400", bugSemAssunto.r.status === 400);

    const bugOk = await reqJson(BASE + "/api/bugs", json("POST", userTok, {
        tipo: "bug", assunto: "Teste", descricao: "Descrição do bug",
        pagina: "mapa", espaco: 42, email: "extra@teste.com"
    }));
    t("envia bug autenticado", bugOk.r.status === 200 && bugOk.body.ok &&
        bugOk.body.id > 0,
        "id=" + bugOk.body.id);

    const sugOk = await reqJson(BASE + "/api/bugs", json("POST", null, {
        tipo: "sugestao", assunto: "Sugestão", descricao: "Melhorar o mapa",
        pagina: "mapa"
    }));
    t("envia sugestão anônima", sugOk.r.status === 200 && sugOk.body.ok);

    /* ===== Admin bugs ===== */
    const adminSemTok = await reqJson(BASE + "/api/admin/bugs");
    t("admin bugs sem token -> 401", adminSemTok.r.status === 401, "status=" + adminSemTok.r.status);

    const adminBugs = await reqJson(BASE + "/api/admin/bugs", json("GET", adminTok));
    const bugsLista = adminBugs.body.bugs || [];
    t("admin lista bugs/sugestões", adminBugs.r.status === 200 && bugsLista.length >= 2 &&
        Array.isArray(adminBugs.body.contagem) && bugsLista.some(b => b.assunto === "Teste"),
        "n=" + bugsLista.length + " contagem=" + JSON.stringify(adminBugs.body.contagem));

    const filtro = await reqJson(BASE + "/api/admin/bugs?status=novo", json("GET", adminTok));
    t("filtro por status", filtro.r.status === 200 && (filtro.body.bugs || []).every(b => b.status === "novo") &&
        (filtro.body.bugs || []).length >= 1,
        "n=" + (filtro.body.bugs || []).length);

    const alvo = bugsLista.find(b => b.assunto === "Teste");
    const atuBug = await reqJson(BASE + "/api/admin/bugs/" + alvo.id, json("POST", adminTok, {
        status: "em_analise", observacao: "Vou verificar"
    }));
    t("admin atualiza status/observação", atuBug.r.status === 200 && atuBug.body.ok);
    const aposBug = await reqJson(BASE + "/api/admin/bugs", json("GET", adminTok));
    const bugAtualizado = (aposBug.body.bugs || []).find(b => b.id === alvo.id);
    t("atualização persiste", !!bugAtualizado && bugAtualizado.status === "em_analise" &&
        bugAtualizado.observacao === "Vou verificar",
        "status=" + (bugAtualizado && bugAtualizado.status));

    /* ===== Rate limit do envio de bugs ===== */
    let blocked = 0;
    for (let i = 0; i < 505; i++) {
        const b = await reqJson(BASE + "/api/bugs", json("POST", userTok2, {
            tipo: "bug", assunto: "Rate " + i, descricao: "x"
        }));
        if (b.r.status === 429) blocked++;
    }
    t("rate limit bloqueia spam de bugs", blocked > 0, "bloqueados=" + blocked);

    /* ===== Resumo final ===== */
    const falhas = log.filter(l => l.startsWith("FAIL"));
    console.log("\n===== RESULTADO COMBOS & BUGS =====");
    log.forEach(l => console.log(l));
    console.log("-----");
    console.log("Total: " + log.length + " | Passou: " + (log.length - falhas.length) + " | Falhou: " + falhas.length);
    if (falhas.length) {
        console.log("FALHAS:");
        falhas.forEach(f => console.log("  " + f));
    }
    process.exit(falhas.length ? 1 : 0);
}

main().catch(e => {
    console.error("ERRO FATAL:", e);
    process.exit(1);
});
