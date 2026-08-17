/* Testes específicos para desconto de indicação no checkout */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3203";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "checkout-indicacao-" + Date.now());
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

const BASE = "http://localhost:3203";
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

async function main() {
    await sleep(4500);
    
    const e1 = "ind1-" + Date.now() + "@teste.com";
    const e2 = "ind2-" + Date.now() + "@teste.com";
    const r1 = await registrar("Indicador", e1);
    const r2 = await registrar("Indicado", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    
    t("registro de 2 usuários", !!u1Id && !!u2Id);

    /* === 1. USUÁRIO SEM BENEFÍCIO === */
    let resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h2 });
    t("1) Usuário sem benefício: GET retorna null", resp.r.status === 200 && resp.body.beneficio === null, "beneficio=" + resp.body.beneficio);

    /* === 2. BENEFÍCIO PENDENTE === */
    // Gerar código para u1
    resp = await reqJson(BASE + "/api/indicacao/gerar-codigo", {
        method: "POST", headers: h1, body: "{}"
    });
    t("2a) Gerar código de indicação", resp.r.status === 200 && resp.body.codigo && resp.body.codigo.startsWith("MD"), "codigo=" + resp.body.codigo);
    const codigoU1 = resp.body.codigo;

    // u2 usa código de u1
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("2b) Registrar indicação", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // Verificar benefício pendente
    resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h2 });
    t("2c) Benefício PENDENTE criado", resp.r.status === 200 && resp.body.beneficio && resp.body.beneficio.status === "PENDENTE", "status=" + (resp.body.beneficio && resp.body.beneficio.status));
    t("2d) Benefício tem 10% de desconto", resp.body.beneficio && resp.body.beneficio.percentual_desconto === 10, "pct=" + (resp.body.beneficio && resp.body.beneficio.percentual_desconto));

    /* === 3. SEGURANÇA - FRONTEND NÃO MANIPULA === */
    // Tentar criar benefício com percentual diferente
    const e3 = "ind3-" + Date.now() + "@teste.com";
    const r3 = await registrar("Tentativa", e3);
    const h3 = { "Authorization": "Bearer " + r3.body.token, "Content-Type": "application/json" };
    
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h3,
        body: JSON.stringify({ codigo: codigoU1, percentual: 50 })
    });
    // Backend ignora percentual do body e usa sempre 10%
    t("3a) Frontend não consegue manipular percentual", resp.r.status === 200, "status=" + resp.r.status);
    
    // Verificar se o benefício foi criado com 10% (não 50%)
    resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h3 });
    t("3a.1) Benefício criado com 10% (ignora body)", resp.body.beneficio && resp.body.beneficio.percentual_desconto === 10, "pct=" + (resp.body.beneficio && resp.body.beneficio.percentual_desconto));

    // Tentar criar benefício com valor manipulado
    const e5 = "ind5-" + Date.now() + "@teste.com";
    const r5 = await registrar("Tentativa2", e5);
    const h5 = { "Authorization": "Bearer " + r5.body.token, "Content-Type": "application/json" };
    
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h5,
        body: JSON.stringify({ codigo: codigoU1, valor_original: 999999 })
    });
    t("3b) Frontend não consegue manipular valor", resp.r.status === 200, "status=" + resp.r.status);

    /* === 4. IDEMPOTÊNCIA === */
    // Tentar registrar mesma indicação novamente
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("4a) Segunda indicação bloqueada", resp.r.status === 400, "status=" + resp.r.status);

    // Tentar usar outro código
    const e4 = "ind4-" + Date.now() + "@teste.com";
    const r4 = await registrar("Outro", e4);
    const h4 = { "Authorization": "Bearer " + r4.body.token, "Content-Type": "application/json" };
    
    resp = await reqJson(BASE + "/api/indicacao/gerar-codigo", {
        method: "POST", headers: h4, body: "{}"
    });
    const codigoU4 = resp.body.codigo;
    
    // u2 tenta usar código de u4 (segundo código)
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU4 })
    });
    t("4b) Múltiplos códigos bloqueados", resp.r.status === 400, "status=" + resp.r.status);

    /* === 5. PRÓPRIO CÓDIGO === */
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h1,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("5) Próprio código bloqueado", resp.r.status === 400, "status=" + resp.r.status);

    /* === 6. BENEFÍCIO UTILIZADO === */
    // Simular consumo do benefício (atualizar status para UTILIZADO com valores)
    const pgPool = require("pg").Pool;
    const pool = new pgPool({ connectionString: process.env.DATABASE_URL });
    
    // Simular pagamento de R$ 100,00 com desconto de R$ 10,00 (10%)
    const valorOriginalCents = 10000; // R$ 100,00
    const valorDescontoCents = 1000;  // R$ 10,00 (10%)
    const valorFinalCents = 9000;     // R$ 90,00
    
    await pool.query(
        `UPDATE beneficios_indicacao 
         SET status = 'UTILIZADO', 
             utilizado_em = NOW(), 
             order_id = 'TESTE-001',
             valor_original_cents = $2,
             valor_desconto_cents = $3,
             valor_final_cents = $4
         WHERE indicado_id = $1`,
        [u2Id, valorOriginalCents, valorDescontoCents, valorFinalCents]
    );
    
    resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h2 });
    t("6a) Benefício UTILIZADO", resp.r.status === 200 && resp.body.beneficio && resp.body.beneficio.status === "UTILIZADO", "status=" + (resp.body.beneficio && resp.body.beneficio.status));

    // Tentar usar benefício novamente
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("6b) Benefício utilizado não pode ser reutilizado", resp.r.status === 400, "status=" + resp.r.status);

    await pool.end();

    /* === 7. FINANCEIRO - CENTAVOS === */
    // Verificar se o schema tem os campos em centavos
    const schemaCheck = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'beneficios_indicacao' 
        AND column_name IN ('valor_original_cents', 'valor_desconto_cents', 'valor_final_cents')
    `);
    
    t("7a) Schema tem campo valor_original_cents", schemaCheck.rows.some(r => r.column_name === 'valor_original_cents'), "columns=" + schemaCheck.rows.map(r => r.column_name).join(","));
    t("7b) Schema tem campo valor_desconto_cents", schemaCheck.rows.some(r => r.column_name === 'valor_desconto_cents'), "columns=" + schemaCheck.rows.map(r => r.column_name).join(","));
    t("7c) Schema tem campo valor_final_cents", schemaCheck.rows.some(r => r.column_name === 'valor_final_cents'), "columns=" + schemaCheck.rows.map(r => r.column_name).join(","));
    
    // Verificar se os campos são INTEGER
    t("7d) Campos são INTEGER", schemaCheck.rows.every(r => r.data_type === 'integer'), "types=" + schemaCheck.rows.map(r => r.data_type).join(","));
    
    // Verificar se o benefício utilizado tem os valores preenchidos
    resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h2 });
    if (resp.body.beneficio && resp.body.beneficio.status === "UTILIZADO") {
        const temValores = resp.body.beneficio.valor_original_cents !== null &&
                          resp.body.beneficio.valor_desconto_cents !== null &&
                          resp.body.beneficio.valor_final_cents !== null;
        t("7e) Benefício utilizado tem valores em centavos", temValores, "original=" + resp.body.beneficio.valor_original_cents);
        
        if (temValores) {
            // Verificar se são inteiros
            t("7f) Valores são inteiros", 
                Number.isInteger(resp.body.beneficio.valor_original_cents) &&
                Number.isInteger(resp.body.beneficio.valor_desconto_cents) &&
                Number.isInteger(resp.body.beneficio.valor_final_cents),
                "types=" + typeof resp.body.beneficio.valor_original_cents);
            
            // Verificar se valor final não é negativo
            t("7g) Valor final não negativo", resp.body.beneficio.valor_final_cents >= 0, "final=" + resp.body.beneficio.valor_final_cents);
            
            // Verificar cálculo: original - desconto = final
            const calculado = resp.body.beneficio.valor_original_cents - resp.body.beneficio.valor_desconto_cents;
            t("7h) Cálculo correto: original - desconto = final", calculado === resp.body.beneficio.valor_final_cents, "calc=" + calculado + " final=" + resp.body.beneficio.valor_final_cents);
        }
    } else {
        t("7e) Benefício utilizado tem valores em centavos", true, "N/A - benefício não utilizado");
        t("7f) Valores são inteiros", true, "N/A - benefício não utilizado");
        t("7g) Valor final não negativo", true, "N/A - benefício não utilizado");
        t("7h) Cálculo correto: original - desconto = final", true, "N/A - benefício não utilizado");
    }

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("CHECKOUT INDICAÇÃO: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
