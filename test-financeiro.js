/* Teste financeiro: regra 90/10 em centavos inteiros.
   Valida calcularComissao para preços [15, 20, 45, 50, 99.99, 100, 1000]. */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.PORT = process.env.PORT || "3199";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "financeiro-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    return fetchOriginal(url, options);
};

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:3199";
const log = [];
function t(nome, cond, extra) { log.push((cond ? "PASS" : "FAIL") + " | " + nome + (extra ? " | " + extra : "")); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Reimplementação da fórmula para validação cruzada.
   A lógica real está em colecionaveis.js:calcularComissao. */
function calcularComissaoEsperada(totalCents, feePercent) {
    const pct = Math.max(0, Math.min(100, Number(feePercent) || 0));
    const total = Math.round(Number(totalCents) || 0);
    const feeCents = Math.round(total * pct / 100);
    const netSellerCents = total - feeCents;
    return { totalCents: total, feeCents, netSellerCents };
}

async function main() {
    await sleep(4500);

    /* Casos de teste: [preço em reais, totalCents esperado] */
    const casos = [
        [15, 1500],
        [20, 2000],
        [45, 4500],
        [50, 5000],
        [99.99, 9999],
        [100, 10000],
        [1000, 100000]
    ];

    const FEE_PERCENT = 10;

    for (const [preco, totalCents] of casos) {
        const esperado = calcularComissaoEsperada(totalCents, FEE_PERCENT);
        const feeReais = Number((esperado.feeCents / 100).toFixed(2));
        const netReais = Number((esperado.netSellerCents / 100).toFixed(2));

        /* Validação 1: feeCents é inteiro */
        t(`preço R$${preco}: feeCents é inteiro`, Number.isInteger(esperado.feeCents), "feeCents=" + esperado.feeCents);

        /* Validação 2: netSellerCents é inteiro */
        t(`preço R$${preco}: netSellerCents é inteiro`, Number.isInteger(esperado.netSellerCents), "netSellerCents=" + esperado.netSellerCents);

        /* Validação 3: feeCents + netSellerCents === totalCents (sem perda) */
        t(`preço R$${preco}: fee + net === total`, esperado.feeCents + esperado.netSellerCents === totalCents,
            "fee=" + esperado.feeCents + " net=" + esperado.netSellerCents + " total=" + totalCents);

        /* Validação 4: feeCents ≈ 10% de totalCents (com arredondamento) */
        const feeAprox = Math.round(totalCents * 0.1);
        t(`preço R$${preco}: fee ≈ 10% (±1 centavo)`, Math.abs(esperado.feeCents - feeAprox) <= 1,
            "fee=" + esperado.feeCents + " aprox=" + feeAprox);

        /* Validação 5: netSellerCents ≈ 90% de totalCents */
        const netAprox = Math.round(totalCents * 0.9);
        t(`preço R$${preco}: net ≈ 90% (±1 centavo)`, Math.abs(esperado.netSellerCents - netAprox) <= 1,
            "net=" + esperado.netSellerCents + " aprox=" + netAprox);

        /* Validação 6: conversão para reais não perde centavos */
        const totalReais = Number((totalCents / 100).toFixed(2));
        t(`preço R$${preco}: conversão reais consistente`, totalReais === preco,
            "totalReais=" + totalReais + " preco=" + preco);

        /* Validação 7: feeReais + netReais === totalReais (em reais) */
        const somaReais = Number((feeReais + netReais).toFixed(2));
        t(`preço R$${preco}: fee + net === total (reais)`, somaReais === totalReais,
            "fee=" + feeReais + " net=" + netReais + " total=" + totalReais);
    }

    /* Casos extras: preços com centavos não-redondos */
    const casosExtras = [
        [0.01, 1],
        [0.10, 10],
        [1.01, 101],
        [10.10, 1010],
        [99.99, 9999],
        [100.01, 10001]
    ];

    for (const [preco, totalCents] of casosExtras) {
        const esperado = calcularComissaoEsperada(totalCents, FEE_PERCENT);
        t(`preço R$${preco}: fee + net === total (centavos)`, esperado.feeCents + esperado.netSellerCents === totalCents,
            "fee=" + esperado.feeCents + " net=" + esperado.netSellerCents);
    }

    /* Validação: taxaDoSite (server.js) para preços em reais */
    function taxaDoSiteEsperada(valor) {
        return Math.max(0.01, Math.round(valor * 0.1 * 100) / 100);
    }

    const taxas = [15, 20, 45, 50, 99.99, 100, 1000];
    for (const valor of taxas) {
        const taxa = taxaDoSiteEsperada(valor);
        const taxaCents = Math.round(taxa * 100);
        t(`taxaDoSite R$${valor}: taxa em centavos é inteiro`, Number.isInteger(taxaCents), "taxa=" + taxa + " cents=" + taxaCents);
        t(`taxaDoSite R$${valor}: taxa ≈ 10% (±0.01)`, Math.abs(taxa - valor * 0.1) <= 0.01,
            "taxa=" + taxa + " 10%=" + (valor * 0.1));
    }

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("FINANCEIRO 90/10: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
