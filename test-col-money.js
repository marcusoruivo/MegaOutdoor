/* =========================================================
   TESTE DEDICADO — VALORES MONETÁRIOS (CENTAVOS) E LICENÇA
   =========================================================
   1) 1 ano  = base, sem taxa
   2) 3 anos = base + R$ 20,00
   3) 5 anos = base + R$ 40,00
   4) mudança 1 -> 3 -> 5 anos (cada plano é calculado do zero;
      NUNCA soma a taxa por cima da anterior)
   5) desconto progressivo incide apenas sobre o base (produtos),
      taxa de licença sem desconto e sem duplicação
   6) sem erro decimal: valueCents sempre inteiro e
      value * 100 === valueCents (exato)
   7) formatação BRL do index.html: R$ 22,50 / R$ 16,72 /
      R$ 1.000,00 (nunca R$ 22,5,00 nem R$ 22,5)

   NÃO faz commit/push/deploy.
   ========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.PORT = process.env.PORT || "3226";

const path = require("path");
const fs = require("fs");

const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "colmoney-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const PORT = process.env.PORT || "3226";
const BASE = "http://localhost:" + PORT;

/* ---- Mock da API Orders do Mercado Pago (ids reais ORD01...) ---- */
let seq = 1;
const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) {
        return fetchOriginal(url, options);
    }
    const method = (options.method || "GET").toUpperCase();
    if (u.endsWith("/v1/orders") && method === "POST") {
        const id = "ORD01" + String(seq++).padStart(6, "0");
        const order = {
            id,
            status: "open",
            external_reference: options.body ? JSON.parse(options.body).external_reference : "mock",
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
        return { ok: true, status: 201, json: async () => order };
    }
    return { ok: false, status: 404, json: async () => ({ message: "Rota MP não encontrada " + u }) };
};

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

/* Extrai e executa o formatarReais REAL do index.html (código de produção). */
function carregarFormatarReais() {
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const m = html.match(/function formatarReais\(cents\) \{[\s\S]*?\n\}/);
    if (!m) {
        throw new Error("formatarReais não encontrado no index.html");
    }
    const fn = new Function("Math", "return " + m[0])(Math);
    return fn;
}

async function main() {
    await sleep(4500);

    const cpfValido = "12345678909";
    const email = "money-test-" + Date.now() + "@teste.com";

    const reg = await reqJson(BASE + "/api/auth/registrar",
        json("POST", null, { nome: "Money Test", email, senha: "senha-teste-123" }));
    const userTok = (reg.body && reg.body.token) || "";
    t("registro usuário", !!userTok);

    /* Cria um checkout e retorna o corpo. Espaços livres e distintos. */
    let idx = 0;
    async function comprar(qtd, plano) {
        const ids = [];
        const base = 400000 + idx * 2000;
        for (let i = 0; i < qtd; i++) {
            ids.push(base + i);
        }
        idx++;
        const r = await reqJson(BASE + "/api/checkout",
            json("POST", userTok, {
                spaces: ids,
                aceiteRegras: true,
                name: "Money Test",
                email,
                cpfCnpj: cpfValido,
                paymentMethod: "pix",
                licensePlan: plano
            }));
        return r;
    }

    /* 1) 9 espaços / 1 ano: 9.00 (sem taxa) */
    let r = await comprar(9, "1_year");
    t("1) 9 espaços 1 ano -> 200", r.r.status === 200, "status=" + r.r.status + " err=" + (r.body && r.body.error));
    if (r.r.status === 200) {
        t("1) 1 ano: value=9.00 valueCents=900",
            r.body.value === 9.00 && r.body.valueCents === 900,
            "value=" + r.body.value + " cents=" + r.body.valueCents);
        t("1) 1 ano: licenseFee=0", r.body.licenseFee === 0, "fee=" + r.body.licenseFee);
    }

    /* 2) 9 espaços / 3 anos: 9.00 + 20.00 = 29.00 */
    r = await comprar(9, "3_years");
    if (r.r.status === 200) {
        t("2) 3 anos: value=29.00 valueCents=2900 (9 + 20)",
            r.body.value === 29.00 && r.body.valueCents === 2900,
            "value=" + r.body.value + " cents=" + r.body.valueCents);
        t("2) 3 anos: licenseFee=20", r.body.licenseFee === 20, "fee=" + r.body.licenseFee);
    }

    /* 3) 9 espaços / 5 anos: 9.00 + 40.00 = 49.00 */
    r = await comprar(9, "5_years");
    if (r.r.status === 200) {
        t("3) 5 anos: value=49.00 valueCents=4900 (9 + 40)",
            r.body.value === 49.00 && r.body.valueCents === 4900,
            "value=" + r.body.value + " cents=" + r.body.valueCents);
        t("3) 5 anos: licenseFee=40", r.body.licenseFee === 40, "fee=" + r.body.licenseFee);
    }

    /* 4) 1 -> 3 -> 5 anos nunca soma a taxa por cima:
       5 anos = base + 40 (NÃO base + 20 + 40). Já coberto acima,
       reforçado aqui: totalAmountCents = baseCents + 4000. */
    r = await comprar(9, "5_years");
    if (r.r.status === 200) {
        t("4) 5 anos NÃO acumula a taxa de 3 anos",
            r.body.license.totalAmountCents === r.body.license.baseAmountCents + 4000,
            "base=" + r.body.license.baseAmountCents +
            " total=" + r.body.license.totalAmountCents);
    }

    /* 5) desconto progressivo incide apenas sobre o base:
       10 espaços/5 anos -> base 10.00, 10% = 9.00 + 40.00 = 49.00 */
    r = await comprar(10, "5_years");
    if (r.r.status === 200) {
        t("5) 10 espaços 5 anos: desconto 10% só no base -> 49.00 (9+40)",
            r.body.value === 49.00 && r.body.valueCents === 4900 &&
            r.body.discountPercent === 10 &&
            r.body.discountCents === 100,
            "value=" + r.body.value + " cents=" + r.body.valueCents +
            " pct=" + r.body.discountPercent + " desc=" + r.body.discountCents);
    }

    /* 5b) 20 espaços/5 anos -> base 20.00, desconto 10% (a partir de 10)
       = 18.00 + 40.00 = 58.00 */
    r = await comprar(20, "5_years");
    if (r.r.status === 200) {
        t("5b) 20 espaços 5 anos -> 58.00 (18+40)",
            r.body.value === 58.00 && r.body.valueCents === 5800 &&
            r.body.discountPercent === 10 &&
            r.body.discountCents === 200,
            "value=" + r.body.value + " cents=" + r.body.valueCents +
            " pct=" + r.body.discountPercent + " desc=" + r.body.discountCents);
    }

    /* 5c) 100 espaços/5 anos -> base 100.00, 20% = 80.00 + 40 = 120.00 */
    r = await comprar(100, "5_years");
    if (r.r.status === 200) {
        t("5c) 100 espaços 5 anos -> 120.00 (80+40)",
            r.body.value === 120.00 && r.body.valueCents === 12000,
            "value=" + r.body.value + " cents=" + r.body.valueCents);
    }

    /* 5d) 1000 espaços/5 anos -> base 1000.00, 30% = 700 + 40 = 740.00 */
    r = await comprar(1000, "5_years");
    if (r.r.status === 200) {
        t("5d) 1000 espaços 5 anos -> 740.00 (700+40)",
            r.body.value === 740.00 && r.body.valueCents === 74000,
            "value=" + r.body.value + " cents=" + r.body.valueCents);
    }

    /* 6) sem erro decimal em toda a matriz: valueCents inteiro e
       value * 100 === valueCents exatamente. */
    const matriz = [
        [1, "1_year"], [2, "1_year"], [9, "1_year"], [10, "1_year"],
        [33, "1_year"], [99, "1_year"], [101, "1_year"], [999, "1_year"],
        [7, "3_years"], [25, "3_years"], [150, "3_years"],
        [8, "5_years"], [40, "5_years"], [500, "5_years"]
    ];
    let decimalOk = true;
    let decimalDetalhe = "";
    for (const [qtd, plano] of matriz) {
        const rr = await comprar(qtd, plano);
        if (rr.r.status !== 200) {
            decimalOk = false;
            decimalDetalhe += qtd + "/" + plano + " HTTP " + rr.r.status + "; ";
            continue;
        }
        const v = rr.body;
        const cents = v.valueCents;
        if (!Number.isInteger(cents) || cents < 0) {
            decimalOk = false;
            decimalDetalhe += qtd + "/" + plano + " cents=" + cents + "; ";
            continue;
        }
        if (Math.abs(v.value * 100 - cents) > 1e-9) {
            decimalOk = false;
            decimalDetalhe += qtd + "/" + plano +
                " value=" + v.value + " cents=" + cents + "; ";
        }
        if (v.subtotalCents !== v.license.baseAmountCents) {
            decimalOk = false;
            decimalDetalhe += qtd + "/" + plano + " subtotal inconsistente; ";
        }
    }
    t("6) matriz decimal sem drift (value*100 === valueCents)", decimalOk,
        decimalDetalhe || (matriz.length + " combinações"));

    /* 7) formatação BRL do index.html (código de produção) */
    const fmt = carregarFormatarReais();
    const casos = [
        [2250, "R$ 22,50"],
        [225, "R$ 2,25"],
        [1672, "R$ 16,72"],
        [2000, "R$ 20,00"],
        [4000, "R$ 40,00"],
        [100000, "R$ 1.000,00"],
        [74000, "R$ 740,00"],
        [0, "R$ 0,00"]
    ];
    let fmtOk = true;
    let fmtDetalhe = "";
    for (const [c, esperado] of casos) {
        const obtido = fmt(c);
        if (obtido !== esperado) {
            fmtOk = false;
            fmtDetalhe += c + "->" + obtido + " (esperado " + esperado + "); ";
        }
    }
    t("7) formatarReais BRL exato (22,50 / 16,72 / 1.000,00)", fmtOk, fmtDetalhe);

    /* resultado */
    const falhas = log.filter(l => l.startsWith("FAIL"));
    console.log("\n=== RESULTADO test-col-money ===");
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
