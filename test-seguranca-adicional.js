/* Testes adicionais de segurança e funcionalidade */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3202";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "seguranca-" + Date.now());
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

const BASE = "http://localhost:3202";
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
    const e1 = "seg1-" + Date.now() + "@teste.com";
    const e2 = "seg2-" + Date.now() + "@teste.com";
    const r1 = await registrar("User A", e1);
    const r2 = await registrar("User B", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    t("registro de 2 usuários", !!u1Id && !!u2Id);

    /* --- SEGURANÇA: Tentar editar outro usuário --- */
    // Tenta editar perfil de u2 usando h1 (u1)
    let resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ bio: "Tentativa de hack via sessão", usuario_id: u2Id })
    });
    t("PUT /api/perfil com usuario_id no body é ignorado", resp.r.status === 200 && resp.body.perfil.bio === "Tentativa de hack via sessão", "status=" + resp.r.status);
    
    // Verifica que u2 não foi alterado
    resp = await reqJson(BASE + "/api/auth/me", { headers: h2 });
    t("u2 não foi alterado por u1", resp.body.usuario.bio !== "Tentativa de hack via sessão", "bio=" + (resp.body.usuario && resp.body.usuario.bio));

    /* --- SEGURANÇA: Tentar manipular indicador --- */
    // Gera código para u1
    resp = await reqJson(BASE + "/api/indicacao/gerar-codigo", {
        method: "POST", headers: h1, body: "{}"
    });
    const codigoU1 = resp.body.codigo;
    
    // u2 tenta registrar indicação com indicador_id manipulado
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1, indicador_id: 999999 })
    });
    t("POST /api/indicacao/registrar ignora indicador_id do body", resp.r.status === 200, "status=" + resp.r.status);

    /* --- SEGURANÇA: Tentar manipular percentual --- */
    // Tenta criar benefício com percentual diferente
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" },
        body: JSON.stringify({ codigo: codigoU1, percentual: 50 })
    });
    t("POST /api/indicacao/registrar ignora percentual do body", resp.r.status === 400, "status=" + resp.r.status);

    /* --- SEGURANÇA: Tentar manipular valor --- */
    // Tenta registrar indicação com valor manipulado
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1, valor_original: 999999 })
    });
    t("POST /api/indicacao/registrar ignora valor_original do body", resp.r.status === 400, "status=" + resp.r.status);

    /* --- INDICAÇÃO: Múltiplos códigos --- */
    // Gera código para u2
    resp = await reqJson(BASE + "/api/indicacao/gerar-codigo", {
        method: "POST", headers: h2, body: "{}"
    });
    const codigoU2 = resp.body.codigo;
    
    // Cria u3
    const e3 = "seg3-" + Date.now() + "@teste.com";
    const r3 = await registrar("User C", e3);
    const h3 = { "Authorization": "Bearer " + r3.body.token, "Content-Type": "application/json" };
    
    // u3 usa código de u1
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h3,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("u3 usa código de u1", resp.r.status === 200, "status=" + resp.r.status);
    
    // u3 tenta usar código de u2 (segundo código)
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h3,
        body: JSON.stringify({ codigo: codigoU2 })
    });
    t("u3 bloqueado ao tentar segundo código", resp.r.status === 400, "status=" + resp.r.status);

    /* --- BISBILHOTAR: Teste funcional completo --- */
    // u1 público, u2 privado
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ album_publico: true, apelido: "user_a_publico" })
    });
    t("u1 torna álbum público", resp.r.status === 200, "status=" + resp.r.status);
    
    resp = await reqJson(BASE + "/api/perfis/publicos", {});
    t("u1 aparece em perfis públicos", resp.body.perfis.some(p => p.apelido === "user_a_publico"), "n=" + (resp.body.perfis || []).length);
    
    // u1 altera para privado
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ album_publico: false })
    });
    t("u1 altera para privado", resp.r.status === 200, "status=" + resp.r.status);
    
    resp = await reqJson(BASE + "/api/perfis/publicos", {});
    t("u1 não aparece mais em perfis públicos", !resp.body.perfis.some(p => p.apelido === "user_a_publico"), "n=" + (resp.body.perfis || []).length);
    
    // u1 volta para público
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ album_publico: true })
    });
    t("u1 volta para público", resp.r.status === 200, "status=" + resp.r.status);
    
    resp = await reqJson(BASE + "/api/perfis/publicos", {});
    t("u1 aparece novamente em perfis públicos", resp.body.perfis.some(p => p.apelido === "user_a_publico"), "n=" + (resp.body.perfis || []).length);

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("SEGURANÇA/ADICIONAIS: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
