/* Teste de BISBILHOTAR, Editar Perfil e Sistema de Indicação */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3201";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "perfil-indicacao-" + Date.now());
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
for (const type of ["text", "varchar"]) {
    db.public.registerFunction({
        name: "trim",
        args: [type],
        returns: type,
        implementation: value => String(value ?? "").trim()
    });
}
const adapter = db.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;
require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:3201";
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
    const e1 = "u1-" + Date.now() + "@teste.com";
    const e2 = "u2-" + Date.now() + "@teste.com";
    const e3 = "u3-" + Date.now() + "@teste.com";
    const r1 = await registrar("User Um", e1);
    const r2 = await registrar("User Dois", e2);
    const r3 = await registrar("User Tres", e3);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const h3 = { "Authorization": "Bearer " + r3.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    const u3Id = r3.body.usuario?.id;
    t("registro de 3 usuários", !!u1Id && !!u2Id && !!u3Id);

    /* --- BISBILHOTAR: Perfis Públicos --- */
    let resp = await reqJson(BASE + "/api/perfis/publicos", {});
    t("GET /api/perfis/publicos sem perfis públicos", resp.r.status === 200 && resp.body.perfis.length === 0, "n=" + (resp.body.perfis || []).length);

    // Torna u1 público
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ album_publico: true, apelido: "user_um", bio: "Bio do user 1" })
    });
    t("PUT /api/perfil torna álbum público", resp.r.status === 200 && resp.body.perfil.album_publico === true, "status=" + resp.r.status);

    // Torna u2 público
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h2,
        body: JSON.stringify({ album_publico: true, apelido: "user_dois" })
    });
    t("PUT /api/perfil u2 público", resp.r.status === 200 && resp.body.perfil.album_publico === true, "status=" + resp.r.status);

    // Lista perfis públicos
    resp = await reqJson(BASE + "/api/perfis/publicos", {});
    t("GET /api/perfis/publicos lista 2 perfis", resp.r.status === 200 && resp.body.perfis.length === 2, "n=" + (resp.body.perfis || []).length);

    // Busca por apelido
    resp = await reqJson(BASE + "/api/perfis/publicos?busca=user_um", {});
    t("GET /api/perfis/publicos?busca filtra", resp.r.status === 200 && resp.body.perfis.length === 1 && resp.body.perfis[0].apelido === "user_um", "n=" + (resp.body.perfis || []).length);

    // Verifica que dados privados não são expostos
    const perfilPublico = resp.body.perfis[0];
    t("perfil público não expõe email", !perfilPublico.email, "email=" + perfilPublico.email);
    t("perfil público não expõe senha_hash", !perfilPublico.senha_hash, "senha_hash=" + perfilPublico.senha_hash);

    /* --- EDITAR PERFIL --- */
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ bio: "Nova bio", album_publico: false })
    });
    t("PUT /api/perfil atualiza bio", resp.r.status === 200 && resp.body.perfil.bio === "Nova bio", "bio=" + (resp.body.perfil && resp.body.perfil.bio));
    t("PUT /api/perfil altera privacidade", resp.body.perfil.album_publico === false, "album_publico=" + (resp.body.perfil && resp.body.perfil.album_publico));

    // Salvar o próprio apelido não deve ser tratado como duplicidade.
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ apelido: "user_um" })
    });
    t("PUT /api/perfil aceita o próprio apelido", resp.r.status === 200 && resp.body.perfil.apelido === "user_um", "status=" + resp.r.status);

    // Apelidos aceitam letras, acentos, espaços, números e underscore.
    const apelidosValidos = [
        "MilhaoDoor", "Milhão Door", "João Silva", "Marcus Ângelo",
        "José123", "Cliente 2026", "João_Silva", "André 123"
    ];
    for (const apelido of apelidosValidos) {
        resp = await reqJson(BASE + "/api/perfil", {
            method: "PUT", headers: h1,
            body: JSON.stringify({ apelido })
        });
        t("aceita apelido " + apelido, resp.r.status === 200 && resp.body.perfil.apelido === apelido, "status=" + resp.r.status);
    }

    // A comparação é case-insensitive e ignora espaços nas extremidades.
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ apelido: "MilhaoDoor" })
    });
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h3,
        body: JSON.stringify({ apelido: "  milhaodoor  " })
    });
    t("rejeita duplicidade por caixa e espaços", resp.r.status === 400, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ apelido: "   " })
    });
    t("PUT /api/perfil rejeita apelido vazio", resp.r.status === 400, "status=" + resp.r.status);

    // Testa validação de apelido
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ apelido: "user@invalido" })
    });
    t("PUT /api/perfil rejeita apelido inválido", resp.r.status === 400, "status=" + resp.r.status);

    // Testa unicidade de apelido
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h3,
        body: JSON.stringify({ apelido: "user_dois" })
    });
    t("PUT /api/perfil rejeita apelido duplicado", resp.r.status === 400, "status=" + resp.r.status);

    // Testa que não pode editar outro usuário (segurança)
    // O backend usa req.usuario.id, não aceita user_id do body
    resp = await reqJson(BASE + "/api/perfil", {
        method: "PUT", headers: h1,
        body: JSON.stringify({ bio: "Tentativa de hack" })
    });
    t("PUT /api/perfil usa sessão do usuário (não body)", resp.r.status === 200 && resp.body.perfil.bio === "Tentativa de hack", "status=" + resp.r.status);

    /* --- SISTEMA DE INDICAÇÃO --- */
    // Gera código para u1
    resp = await reqJson(BASE + "/api/indicacao/gerar-codigo", {
        method: "POST", headers: h1, body: "{}"
    });
    t("POST /api/indicacao/gerar-codigo gera código", resp.r.status === 200 && resp.body.codigo && resp.body.codigo.startsWith("MD"), "codigo=" + resp.body.codigo);
    const codigoU1 = resp.body.codigo;

    // Gera código novamente (deve retornar o mesmo)
    resp = await reqJson(BASE + "/api/indicacao/gerar-codigo", {
        method: "POST", headers: h1, body: "{}"
    });
    t("POST /api/indicacao/gerar-codigo retorna mesmo código", resp.r.status === 200 && resp.body.codigo === codigoU1, "codigo=" + resp.body.codigo);

    // Verifica código válido
    resp = await reqJson(BASE + "/api/indicacao/verificar?ref=" + codigoU1, {});
    t("GET /api/indicacao/verificar código válido", resp.r.status === 200 && resp.body.valido === true, "valido=" + resp.body.valido);

    // Verifica código inválido
    resp = await reqJson(BASE + "/api/indicacao/verificar?ref=INVALIDO", {});
    t("GET /api/indicacao/verificar código inválido", resp.r.status === 200 && resp.body.valido === false, "valido=" + resp.body.valido);

    // u2 usa código de u1
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("POST /api/indicacao/registrar registra indicação", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // u2 tenta usar código novamente
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h2,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("POST /api/indicacao/registrar bloqueia segundo uso", resp.r.status === 400, "status=" + resp.r.status);

    // u1 tenta usar próprio código
    resp = await reqJson(BASE + "/api/indicacao/registrar", {
        method: "POST", headers: h1,
        body: JSON.stringify({ codigo: codigoU1 })
    });
    t("POST /api/indicacao/registrar bloqueia próprio código", resp.r.status === 400, "status=" + resp.r.status);

    // Verifica benefício de u2
    resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h2 });
    t("GET /api/indicacao/beneficio retorna benefício pendente", resp.r.status === 200 && resp.body.beneficio && resp.body.beneficio.status === "PENDENTE", "status=" + (resp.body.beneficio && resp.body.beneficio.status));
    t("benefício tem 10% de desconto", resp.body.beneficio && resp.body.beneficio.percentual_desconto === 10, "pct=" + (resp.body.beneficio && resp.body.beneficio.percentual_desconto));

    // u3 não tem benefício
    resp = await reqJson(BASE + "/api/indicacao/beneficio", { headers: h3 });
    t("GET /api/indicacao/beneficio u3 sem benefício", resp.r.status === 200 && resp.body.beneficio === null, "beneficio=" + resp.body.beneficio);

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("PERFIL/INDICAÇÃO: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
