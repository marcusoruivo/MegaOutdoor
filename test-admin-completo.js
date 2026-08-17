/* Testes de administração completa */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3205";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "admin-completo-" + Date.now());
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

const BASE = "http://localhost:3205";
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
async function loginAdmin() {
    const { r, body } = await reqJson(BASE + "/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario: "admin", senha: "senha123" })
    });
    return { r, body };
}

async function main() {
    await sleep(4500);
    
    const e1 = "admin1-" + Date.now() + "@teste.com";
    const e2 = "admin2-" + Date.now() + "@teste.com";
    const r1 = await registrar("User Admin 1", e1);
    const r2 = await registrar("User Admin 2", e2);
    const h1 = { "Authorization": "Bearer " + r1.body.token, "Content-Type": "application/json" };
    const h2 = { "Authorization": "Bearer " + r2.body.token, "Content-Type": "application/json" };
    const u1Id = r1.body.usuario?.id;
    const u2Id = r2.body.usuario?.id;
    
    t("registro de 2 usuários", !!u1Id && !!u2Id);

    // Login admin
    const adminResp = await loginAdmin();
    t("login admin", adminResp.r.status === 200 && adminResp.body.ok === true, "status=" + adminResp.r.status);
    const adminToken = adminResp.body.token;
    const hAdmin = { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" };

    /* === ADMINISTRAÇÃO DE USUÁRIOS === */
    
    // Editar usuário
    let resp = await reqJson(BASE + "/api/admin/usuarios/" + u1Id, {
        method: "PUT", headers: hAdmin,
        body: JSON.stringify({ nome: "Nome Editado", email: "novo@email.com" })
    });
    t("Admin edita usuário", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // Usuário comum não pode editar
    resp = await reqJson(BASE + "/api/admin/usuarios/" + u2Id, {
        method: "PUT", headers: h1,
        body: JSON.stringify({ nome: "Tentativa de hack" })
    });
    t("Usuário comum não edita usuário", resp.r.status === 401, "status=" + resp.r.status);

    // Resetar senha
    resp = await reqJson(BASE + "/api/admin/usuarios/" + u1Id + "/reset-senha", {
        method: "POST", headers: hAdmin,
        body: JSON.stringify({ novaSenha: "nova-senha-456" })
    });
    t("Admin reseta senha", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // Bloquear usuário
    resp = await reqJson(BASE + "/api/admin/usuarios/" + u2Id + "/bloquear", {
        method: "POST", headers: hAdmin,
        body: JSON.stringify({ bloqueado: true })
    });
    t("Admin bloqueia usuário", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // Desbloquear usuário
    resp = await reqJson(BASE + "/api/admin/usuarios/" + u2Id + "/bloquear", {
        method: "POST", headers: hAdmin,
        body: JSON.stringify({ bloqueado: false })
    });
    t("Admin desbloqueia usuário", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // Excluir usuário (soft delete)
    const e3 = "admin3-" + Date.now() + "@teste.com";
    const r3 = await registrar("User Admin 3", e3);
    const u3Id = r3.body.usuario?.id;
    
    resp = await reqJson(BASE + "/api/admin/usuarios/" + u3Id, {
        method: "DELETE", headers: hAdmin
    });
    t("Admin exclui usuário (soft delete)", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    /* === ADMINISTRAÇÃO DE STORIES === */
    
    // Listar stories
    resp = await reqJson(BASE + "/api/admin/stories", { headers: hAdmin });
    t("Admin lista stories", resp.r.status === 200 && Array.isArray(resp.body.stories), "status=" + resp.r.status);

    // Listar stories com filtro
    resp = await reqJson(BASE + "/api/admin/stories?status=ativo", { headers: hAdmin });
    t("Admin lista stories com filtro", resp.r.status === 200 && Array.isArray(resp.body.stories), "status=" + resp.r.status);

    /* === ADMINISTRAÇÃO DE ÚLTIMAS COMPRAS === */
    
    // Listar últimas compras
    resp = await reqJson(BASE + "/api/admin/ultimas-compras", { headers: hAdmin });
    t("Admin lista últimas compras", resp.r.status === 200 && Array.isArray(resp.body.compras), "status=" + resp.r.status);

    // Ocultar compra (criar compra primeiro via webhook simulado)
    // Como não temos compra real, vamos testar com ID inexistente
    resp = await reqJson(BASE + "/api/admin/ultimas-compras/999999/ocultar", {
        method: "POST", headers: hAdmin
    });
    t("Admin tenta ocultar compra inexistente -> 404", resp.r.status === 404, "status=" + resp.r.status);

    // Remover compra inexistente
    resp = await reqJson(BASE + "/api/admin/ultimas-compras/999999", {
        method: "DELETE", headers: hAdmin
    });
    t("Admin tenta remover compra inexistente -> 404", resp.r.status === 404, "status=" + resp.r.status);

    /* === SEGURANÇA === */
    
    // Endpoint sem auth
    resp = await reqJson(BASE + "/api/admin/usuarios/" + u1Id, {
        method: "PUT",
        body: JSON.stringify({ nome: "Hack" })
    });
    t("Endpoint admin sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    // Listar stories sem auth
    resp = await reqJson(BASE + "/api/admin/stories", {});
    t("Listar stories sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    // Listar últimas compras sem auth
    resp = await reqJson(BASE + "/api/admin/ultimas-compras", {});
    t("Listar últimas compras sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    /* === ÚLTIMAS COMPRAS — MOSTRAR NOVAMENTE === */

    resp = await reqJson(BASE + "/api/admin/ultimas-compras/999999/mostrar", {
        method: "POST", headers: hAdmin
    });
    t("Mostrar compra inexistente -> 404", resp.r.status === 404, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/ultimas-compras/abc/mostrar", {
        method: "POST", headers: hAdmin
    });
    t("Mostrar compra com ID inválido -> 400", resp.r.status === 400, "status=" + resp.r.status);

    /* === CONFIGURAÇÃO DE PREÇOS DE STORIES === */

    // Listar pricing
    resp = await reqJson(BASE + "/api/admin/stories/pricing", { headers: hAdmin });
    t("Admin lista pricing de stories", resp.r.status === 200 && Array.isArray(resp.body.config), "status=" + resp.r.status);
    const configInicial = resp.body.config;
    t("Pricing tem 4 durações", configInicial.length === 4, "count=" + configInicial.length);

    // Atualizar pricing
    resp = await reqJson(BASE + "/api/admin/stories/pricing", {
        method: "PUT", headers: hAdmin,
        body: JSON.stringify({ itens: [
            { duracao: "3h", precoCents: 600, ativo: true, popular: false },
            { duracao: "6h", precoCents: 900, ativo: true, popular: true },
            { duracao: "12h", precoCents: 1400, ativo: true, popular: false },
            { duracao: "24h", precoCents: 2200, ativo: true, popular: false }
        ] })
    });
    t("Admin atualiza pricing", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);
    t("Pricing retornado na resposta", Array.isArray(resp.body.config), "config_ok=" + !!resp.body.config);

    // Preço negativo deve ser rejeitado
    resp = await reqJson(BASE + "/api/admin/stories/pricing", {
        method: "PUT", headers: hAdmin,
        body: JSON.stringify({ itens: [
            { duracao: "3h", precoCents: -100, ativo: true, popular: false }
        ] })
    });
    t("Preço negativo rejeitado", resp.r.status === 400, "status=" + resp.r.status);

    // Duração inválida deve ser rejeitada
    resp = await reqJson(BASE + "/api/admin/stories/pricing", {
        method: "PUT", headers: hAdmin,
        body: JSON.stringify({ itens: [
            { duracao: "50h", precoCents: 500, ativo: true, popular: false }
        ] })
    });
    t("Duração inválida rejeitada", resp.r.status === 400, "status=" + resp.r.status);

    // Duas POPULAR deve ser rejeitado
    resp = await reqJson(BASE + "/api/admin/stories/pricing", {
        method: "PUT", headers: hAdmin,
        body: JSON.stringify({ itens: [
            { duracao: "3h", precoCents: 500, ativo: true, popular: true },
            { duracao: "6h", precoCents: 800, ativo: true, popular: true }
        ] })
    });
    t("Duas durações POPULAR rejeitado", resp.r.status === 400, "status=" + resp.r.status);

    // Marcar popular separadamente
    resp = await reqJson(BASE + "/api/admin/stories/pricing/popular", {
        method: "POST", headers: hAdmin,
        body: JSON.stringify({ duracao: "12h" })
    });
    t("Marcar popular atualizado", resp.r.status === 200 && resp.body.ok === true, "status=" + resp.r.status);

    // Popular sem auth
    resp = await reqJson(BASE + "/api/admin/stories/pricing/popular", {
        method: "POST",
        body: JSON.stringify({ duracao: "3h" })
    });
    t("Marcar popular sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    // Pricing sem auth
    resp = await reqJson(BASE + "/api/admin/stories/pricing", {});
    t("Pricing sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    /* === PAGINAÇÃO === */

    resp = await reqJson(BASE + "/api/admin/usuarios?pagina=1&limite=1", { headers: hAdmin });
    t("Usuários com paginação", resp.r.status === 200 && resp.body.pagina === 1, "pagina=" + resp.body.pagina);

    resp = await reqJson(BASE + "/api/admin/usuarios?busca=naoexiste999", { headers: hAdmin });
    t("Usuários com busca vazia retorna vazio", resp.r.status === 200 && resp.body.usuarios.length === 0, "total=" + resp.body.total);

    resp = await reqJson(BASE + "/api/admin/stories?pagina=1&limite=1", { headers: hAdmin });
    t("Stories com paginação", resp.r.status === 200 && resp.body.pagina === 1, "pagina=" + resp.body.pagina);

    resp = await reqJson(BASE + "/api/admin/ultimas-compras?pagina=1&limite=1", { headers: hAdmin });
    t("Últimas compras com paginação", resp.r.status === 200 && resp.body.pagina === 1, "pagina=" + resp.body.pagina);

    resp = await reqJson(BASE + "/api/admin/ultimas-compras?visivel=true", { headers: hAdmin });
    t("Últimas compras com filtro visível", resp.r.status === 200 && Array.isArray(resp.body.compras), "status=" + resp.r.status);

    /* === EXPORTAÇÃO CSV === */

    resp = await reqJson(BASE + "/api/admin/export/usuarios", { headers: hAdmin });
    t("Export CSV usuários", resp.r.status === 200 && (resp.r.headers.get("content-type") || "").includes("text/csv"), "ct=" + (resp.r.headers.get("content-type") || ""));

    resp = await reqJson(BASE + "/api/admin/export/transacoes", { headers: hAdmin });
    t("Export CSV transações", resp.r.status === 200, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/export/stories", { headers: hAdmin });
    t("Export CSV stories", resp.r.status === 200, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/export/ultimas-compras", { headers: hAdmin });
    t("Export CSV últimas compras", resp.r.status === 200, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/export/espacos", { headers: hAdmin });
    t("Export CSV espaços", resp.r.status === 200, "status=" + resp.r.status);

    // CSV sem auth
    resp = await reqJson(BASE + "/api/admin/export/usuarios", {});
    t("Export CSV sem auth -> 401", resp.r.status === 401, "status=" + resp.r.status);

    /* === DASHBOARD COM NOVAS MÉTRICAS === */

    resp = await reqJson(BASE + "/api/admin/resumo", { headers: hAdmin });
    t("Resumo tem storiesAtivos", resp.body.storiesAtivos !== undefined, "storiesAtivos=" + resp.body.storiesAtivos);
    t("Resumo tem usuariosBloqueados", resp.body.usuariosBloqueados !== undefined, "bloqueados=" + resp.body.usuariosBloqueados);
    t("Resumo tem comprasVisiveis", resp.body.comprasVisiveis !== undefined, "comprasVisiveis=" + resp.body.comprasVisiveis);

    /* === USUÁRIO COMUM NÃO ACESSA ADMIN === */

    resp = await reqJson(BASE + "/api/admin/usuarios", { headers: h1 });
    t("Usuário comum não lista usuários -> 401", resp.r.status === 401, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/resumo", { headers: h1 });
    t("Usuário comum não vê resumo -> 401", resp.r.status === 401, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/stories/pricing", { headers: h1 });
    t("Usuário comum não vê pricing -> 401", resp.r.status === 401, "status=" + resp.r.status);

    resp = await reqJson(BASE + "/api/admin/export/usuarios", { headers: h1 });
    t("Usuário comum não exporta -> 401", resp.r.status === 401, "status=" + resp.r.status);

    // Reseta pricing para valores padrão
    resp = await reqJson(BASE + "/api/admin/stories/pricing", {
        method: "PUT", headers: hAdmin,
        body: JSON.stringify({ itens: [
            { duracao: "3h", precoCents: 500, ativo: true, popular: false },
            { duracao: "6h", precoCents: 800, ativo: true, popular: true },
            { duracao: "12h", precoCents: 1200, ativo: true, popular: false },
            { duracao: "24h", precoCents: 2000, ativo: true, popular: false }
        ] })
    });
    t("Pricing restaurado para padrão", resp.r.status === 200, "status=" + resp.r.status);

    finalizar();
}

function finalizar() {
    const failed = log.filter(l => l.startsWith("FAIL"));
    log.forEach(l => console.log(l));
    console.log("---------------------------------");
    console.log("ADMIN COMPLETO: " + (log.length - failed.length) + "/" + log.length);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });
