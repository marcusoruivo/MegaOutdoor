/* =========================================================
   TESTE — BENEFÍCIOS DE KIT (CORREÇÃO 7 / PARTE 1)
   =========================================================
   Pagamento aprovado de um kit NÃO aloca mais espaços
   automaticamente. O usuário escolhe manualmente (X/X) e
   confirma; a alocação é atômica e à prova de concorrência.

   Cenários:
   1) nenhuma auto-seleção após pagamento
   2) benefício listado com spacesAllowed e status
   3) seleção: max, parcial, duplicatas, espaço ocupado
   4) confirmação: exige EXATAMENTE X espaços
   5) confirmação persistida no mapa (paid + dono)
   6) dupla confirmação → 409
   7) /meus e /pagamento refletem espacosConfirmados
   8) benefício alheio → 404 (dono bloqueado)

   Usa mocks realistas do Mercado Pago. NÃO faz commit/push/deploy.
========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3251";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colbenef-" + Date.now());
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

const BASE = "http://localhost:3251";
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

const ESPACOS_LIVRES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

async function main() {
    await sleep(4500);

    const login = await reqJson(BASE + "/api/admin/login", json("POST", null, { usuario: "admin", senha: "senha123" }));
    t("login admin ok", login.r.status === 200 && !!login.body.token);
    const adminTok = login.body.token || "";

    const email = "benef-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Benef Test", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário u1", !!userTok);

    const email2 = "benef-2-" + Date.now() + "@teste.com";
    const reg2 = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Benef Test 2", email: email2, senha: "senha-teste-123" }));
    const userTok2 = reg2.body.token || "";
    t("registro usuário u2", !!userTok2);

    const kits = await reqJson(BASE + "/api/combos/kits");
    const starter = (kits.body.kits || []).find(k => k.slug === "starter");
    t("kit starter disponível", !!starter && Number(starter.espacos) === 3,
        "espacos=" + (starter && starter.espacos));

    /* ===== Checkout + pagamento do kit ===== */
    const ck = await reqJson(BASE + "/api/combos/kits/" + starter.id + "/checkout",
        json("POST", userTok, { licensePlan: "1_year", cpfCnpj: "12345678909", paymentMethod: "pix", aceiteRegras: true }));
    const extRef = ck.body.externalReference;
    t("checkout kit starter ok", ck.r.status === 200 && !!extRef && String(extRef).startsWith("KIT-"),
        "valor=" + ck.body.valor + " ext=" + extRef);

    const conf = await reqJson(BASE + "/api/combos/test/confirm/" + extRef, json("POST", userTok));
    t("confirmar pagamento do kit", conf.r.status === 200 && conf.body.ok && conf.body.tipo === "kit",
        "status=" + conf.r.status);

    /* ===== 1) NENHUMA auto-seleção após o pagamento ===== */
    const mapa = await reqJson(BASE + "/api/spaces", json("GET", null));
    const alocados = Object.values(mapa.body || {}).filter(s => s.usuarioId);
    t("1) pagamento NÃO alocou espaços automaticamente",
        (mapa.body && Object.keys(mapa.body).length === 0) || alocados.length === 0,
        "espacos no mapa=" + Object.keys(mapa.body || {}).length);

    /* ===== 2) Benefício listado ===== */
    const benef1 = await reqJson(BASE + "/api/combos/kits/beneficios", json("GET", userTok));
    const b = (benef1.body.beneficios || [])[0];
    t("2) benefício pago listado (spacesAllowed=3, sem confirmação)",
        benef1.r.status === 200 && benef1.body.beneficios.length === 1 &&
        b.spacesAllowed === 3 && b.espacosConfirmados === false && b.restantes === 3,
        "n=" + (benef1.body.beneficios || []).length + " allowed=" + (b && b.spacesAllowed));

    /* ===== 3) Seleção: mais que o permitido -> 400 ===== */
    const sel4 = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/selecionar",
        json("POST", userTok, { espacos: [1, 2, 3, 4] }));
    t("3) selecionar mais que o permitido -> 400", sel4.r.status === 400,
        "status=" + sel4.r.status + " err=" + sel4.body.error);

    /* ===== 4) Seleção parcial ok ===== */
    const sel2 = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/selecionar",
        json("POST", userTok, { espacos: [10, 20] }));
    t("4) seleção parcial (2/3) salva com restantes=1",
        sel2.r.status === 200 && sel2.body.espacosSelecionados.length === 2 &&
        sel2.body.restantes === 1 && sel2.body.espacosConfirmados === false,
        "sel=" + JSON.stringify(sel2.body.espacosSelecionados));

    /* ===== 5) Duplicatas normalizadas ===== */
    const selDup = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/selecionar",
        json("POST", userTok, { espacos: [10, 10, 20] }));
    t("5) duplicatas normalizadas ([10,10,20] -> [10,20])",
        selDup.r.status === 200 && JSON.stringify(selDup.body.espacosSelecionados) === "[10,20]",
        "sel=" + JSON.stringify(selDup.body.espacosSelecionados));

    /* ===== 6) Confirmação exige EXATAMENTE X espaços ===== */
    const confParcial = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/confirmar",
        json("POST", userTok, {}));
    t("6) confirmar com 2/3 -> 409 (exige exatamente 3)",
        confParcial.r.status === 409 && /exatamente 3/.test(confParcial.body.error),
        "status=" + confParcial.r.status + " err=" + confParcial.body.error);

    /* ===== 7) /pagamento antes da confirmação ===== */
    const pagAntes = await reqJson(BASE + "/api/combos/pagamento/" + extRef, json("GET", userTok));
    t("7) /pagamento antes: RECEIVED com espacosConfirmados=false",
        pagAntes.r.status === 200 && pagAntes.body.espacosConfirmados === false,
        "st=" + pagAntes.body.status + " conf=" + pagAntes.body.espacosConfirmados);

    /* ===== 8) Seleciona os 3 exatos ===== */
    const sel3 = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/selecionar",
        json("POST", userTok, { espacos: [1, 2, 3] }));
    t("8) selecionar 3/3 -> restantes=0",
        sel3.r.status === 200 && sel3.body.restantes === 0,
        "sel=" + JSON.stringify(sel3.body.espacosSelecionados));

    /* ===== 9) Confirmação efetiva ===== */
    const confOk = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/confirmar",
        json("POST", userTok, {}));
    t("9) confirmar 3/3 -> aloca e marca confirmado",
        confOk.r.status === 200 && confOk.body.ok &&
        JSON.stringify(confOk.body.espacos) === "[1,2,3]" &&
        confOk.body.espacosConfirmados === true,
        "status=" + confOk.r.status + " esp=" + JSON.stringify(confOk.body.espacos));

    /* ===== 10) Espaços no mapa, dono = u1 ===== */
    const mapa2 = await reqJson(BASE + "/api/spaces", json("GET", null));
    const esp1 = mapa2.body && mapa2.body["1"];
    const esp2 = mapa2.body && mapa2.body["2"];
    const esp3 = mapa2.body && mapa2.body["3"];
    t("10) espaços 1,2,3 no mapa como paid do usuário u1",
        !!esp1 && !!esp2 && !!esp3 &&
        esp1.status === "paid" && esp2.status === "paid" && esp3.status === "paid" &&
        esp1.usuarioId && esp2.usuarioId && esp3.usuarioId,
        "u1=" + (esp1 && esp1.usuarioId));

    /* ===== 11) Benefício some da lista após confirmar ===== */
    const benef2 = await reqJson(BASE + "/api/combos/kits/beneficios", json("GET", userTok));
    t("11) benefício confirmado NÃO aparece mais na lista",
        benef2.r.status === 200 && (benef2.body.beneficios || []).length === 0,
        "n=" + (benef2.body.beneficios || []).length);

    /* ===== 12) /meus reflete a confirmação ===== */
    const meus = await reqJson(BASE + "/api/combos/meus", json("GET", userTok));
    const compra = (meus.body.compras || []).find(c => c.orderId === extRef);
    t("12) /meus: status paid, espacosConfirmados=true, spacesAllowed=3",
        !!compra && compra.status === "paid" && compra.espacosConfirmados === true &&
        compra.spacesAllowed === 3 && JSON.stringify(compra.espacos) === "[1,2,3]",
        "conf=" + (compra && compra.espacosConfirmados) + " allowed=" + (compra && compra.spacesAllowed));

    /* ===== 13) /pagamento depois da confirmação ===== */
    const pagDepois = await reqJson(BASE + "/api/combos/pagamento/" + extRef, json("GET", userTok));
    t("13) /pagamento depois: espacosConfirmados=true",
        pagDepois.r.status === 200 && pagDepois.body.espacosConfirmados === true,
        "conf=" + pagDepois.body.espacosConfirmados);

    /* ===== 14) Dupla confirmação bloqueada (409) ===== */
    const confDup = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/confirmar",
        json("POST", userTok, {}));
    t("14) dupla confirmação -> 409",
        confDup.r.status === 409,
        "status=" + confDup.r.status + " err=" + confDup.body.error);

    /* ===== 15) Selecionar em benefício já confirmado -> 400 ===== */
    const selDepois = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/selecionar",
        json("POST", userTok, { espacos: [5, 6, 7] }));
    t("15) selecionar em benefício já confirmado -> 400",
        selDepois.r.status === 400,
        "status=" + selDepois.r.status);

    /* ===== 16) Benefício alheio -> 404 ===== */
    const alheioSel = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/selecionar",
        json("POST", userTok2, { espacos: [1, 2, 3] }));
    const alheioConf = await reqJson(BASE + "/api/combos/kits/beneficios/" + b.compraId + "/confirmar",
        json("POST", userTok2, {}));
    t("16) benefício alheio -> 404 (selecionar e confirmar)",
        alheioSel.r.status === 404 && alheioConf.r.status === 404,
        "sel=" + alheioSel.r.status + " conf=" + alheioConf.r.status);

    /* ===== 17) Espaço ocupado -> 400/409 (u2 não pode selecionar) ===== */
    const ck2 = await reqJson(BASE + "/api/combos/kits/" + starter.id + "/checkout",
        json("POST", userTok2, { licensePlan: "1_year", cpfCnpj: "12345678909", paymentMethod: "pix", aceiteRegras: true }));
    await reqJson(BASE + "/api/combos/test/confirm/" + ck2.body.externalReference, json("POST", userTok2));
    const benef2u = await reqJson(BASE + "/api/combos/kits/beneficios", json("GET", userTok2));
    const b2 = (benef2u.body.beneficios || [])[0];
    const selOcupado = await reqJson(BASE + "/api/combos/kits/beneficios/" + b2.compraId + "/selecionar",
        json("POST", userTok2, { espacos: [1, 5, 6] }));
    t("17) selecionar espaço ocupado -> 400",
        selOcupado.r.status === 400 && /não está mais disponível/.test(selOcupado.body.error),
        "status=" + selOcupado.r.status + " err=" + selOcupado.body.error);

    /* ===== 18) Concorrência: confirmar em espaço que sumiu -> 409 ===== */
    const selB2 = await reqJson(BASE + "/api/combos/kits/beneficios/" + b2.compraId + "/selecionar",
        json("POST", userTok2, { espacos: [1, 2, 3] }));
    const confB2 = await reqJson(BASE + "/api/combos/kits/beneficios/" + b2.compraId + "/confirmar",
        json("POST", userTok2, {}));
    t("18) confirmar com espaços que sumiram -> 409 (sem alocar)",
        selB2.r.status === 400 && confB2.r.status === 409,
        "sel=" + selB2.r.status + " conf=" + confB2.r.status + " err=" + confB2.body.error);

    /* ===== 19) u2 seleciona espaços livres e confirma com sucesso ===== */
    const selB2b = await reqJson(BASE + "/api/combos/kits/beneficios/" + b2.compraId + "/selecionar",
        json("POST", userTok2, { espacos: ESPACOS_LIVRES.slice(0, 3) }));
    const confB2b = await reqJson(BASE + "/api/combos/kits/beneficios/" + b2.compraId + "/confirmar",
        json("POST", userTok2, {}));
    t("19) u2 confirma com espaços livres -> 200",
        selB2b.r.status === 200 && confB2b.r.status === 200 &&
        JSON.stringify(confB2b.body.espacos) === JSON.stringify(ESPACOS_LIVRES.slice(0, 3)),
        "status=" + confB2b.r.status + " esp=" + JSON.stringify(confB2b.body.espacos));

    /* ===== 20) Nenhum espaço do kit criado no checkout persiste indevido ===== */
    const mapaFinal = await reqJson(BASE + "/api/spaces", json("GET", null));
    const chaves = Object.keys(mapaFinal.body || {}).map(Number).sort((a, b) => a - b);
    t("20) mapa final contém exatamente as confirmações manuais",
        JSON.stringify(chaves) === JSON.stringify([1, 2, 3, 10, 20, 30].sort((a, b) => a - b)),
        "chaves=" + JSON.stringify(chaves));

    /* ---- resultado ---- */
    const falhas = log.filter(l => l.startsWith("FAIL"));
    console.log("\n=== RESULTADO test-col-beneficios ===");
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
