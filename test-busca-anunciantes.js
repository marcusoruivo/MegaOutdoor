/* Testes da BUSCA DE ANUNCIANTES (OUTDOOR DIGITAL PESQUISÁVEL):
   - GET /api/busca: títulos, segmentos, palavras-chave, nomes, links,
     números de bloco, sem acentos, case-insensitive, filtro de categoria
     e segmento, agrupamento por orderToken, blocos contíguos.
   - Privacidade: só espaços "published"; links privados (publico:false)
     excluídos; espaços paid/free não aparecem.
   - POST /api/anuncio/dados/:id: solo e bloco, autorização, validações.
   NÃO faz commit/push/deploy.
*/
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = "3198";

const path = require("path");
const fs = require("fs");
const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "busca-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;

const USUARIO_ID = 90001;
const ESPACOS_FIXTURE = {
    "450001": {
        title: "Academia Shape",
        name: "João Silva",
        categoria: "EMPRESAS",
        segmento: "Manutenção de equipamentos fitness",
        descricao: "Manutenção de esteiras e aparelhos de academia.",
        palavras_chave: ["academia", "esteira", "manutenção", "fitness"],
        links: [
            { url: "https://instagram.com/academiashape", tipo: "instagram", rotulo: "Instagram", publico: true },
            { url: "https://api-interna.example.com", tipo: "outro", rotulo: "Painel interno", publico: false }
        ],
        status: "published",
        orderToken: "ORD-A",
        usuarioId: USUARIO_ID
    },
    "450002": {
        title: "Academia Shape",
        name: "João Silva",
        categoria: "EMPRESAS",
        segmento: "Manutenção de equipamentos fitness",
        palavras_chave: ["academia", "fitness"],
        status: "published",
        orderToken: "ORD-A",
        usuarioId: USUARIO_ID
    },
    "450003": {
        title: "Dra. Maria Odonto",
        name: "Maria Souza",
        categoria: "PESSOAS",
        segmento: "Odontologia",
        palavras_chave: ["dentista", "clínica"],
        link: "https://www.odontomaria.com.br",
        status: "published",
        orderToken: "ORD-B",
        usuarioId: USUARIO_ID
    },
    "451000": {
        title: "Pinturas do Zé",
        name: "José Alves",
        categoria: "SERVIÇOS",
        segmento: "Pintura residencial e predial",
        palavras_chave: ["pintor", "tinta"],
        status: "published",
        orderToken: "ORD-C"
    },
    "451001": {
        title: "Pinturas do Zé",
        name: "José Alves",
        categoria: "SERVIÇOS",
        segmento: "Pintura residencial e predial",
        palavras_chave: ["pintor"],
        status: "published",
        orderToken: "ORD-C"
    },
    "455000": {
        title: "Loja de Roupas Premium",
        name: "Carlos Lima",
        categoria: "EMPRESAS",
        segmento: "Vestuário",
        status: "paid",
        orderToken: "ORD-D"
    },
    "459999": {
        title: "Espaço Livre",
        name: "Sem dono",
        status: "free"
    }
};
fs.writeFileSync(
    path.join(process.env.DATA_DIR, "spaces.json"),
    JSON.stringify(ESPACOS_FIXTURE, null, 2)
);

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

    /* ===== Registro de usuário (dono) ===== */
    const email = "busca-dono-" + Date.now() + "@teste.com";
    const reg = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Dono Busca", email, senha: "senha-teste-123" }));
    const userTok = reg.body.token || "";
    t("registro usuário dono", !!userTok);

    /* ===== Busca por título ===== */
    let r = await reqJson(BASE + "/api/busca?q=academia", json("GET", null));
    t("q=academia ok", r.body.ok === true, "total=" + (r.body.total));
    const academia = (r.body.resultados || []).find(x => x.titulo === "Academia Shape");
    t("academia encontrada por título", !!academia);
    t("agrupado por orderToken (1 resultado, 2 espaços)", academia && academia.qtdEspacos === 2,
        academia ? "qtd=" + academia.qtdEspacos : "n/a");
    t("blocos contíguos [450001,450002]", academia && academia.blocos && academia.blocos.length === 1 &&
        academia.blocos[0][0] === 450001 && academia.blocos[0][1] === 450002,
        academia ? JSON.stringify(academia.blocos) : "n/a");

    /* ===== Palavra-chave ===== */
    r = await reqJson(BASE + "/api/busca?q=esteira", json("GET", null));
    t("q=esteira (palavra-chave) acha academia", (r.body.resultados || []).some(x => x.titulo === "Academia Shape"));

    /* ===== Segmento (sem acento na busca) ===== */
    r = await reqJson(BASE + "/api/busca?q=manutencao", json("GET", null));
    t("q=manutencao (segmento sem acento) acha academia", (r.body.resultados || []).some(x => x.titulo === "Academia Shape"));

    /* ===== Nome do dono (busca sem acento "Joao") ===== */
    r = await reqJson(BASE + "/api/busca?q=joao", json("GET", null));
    t("q=joao (nome sem acento) acha academia", (r.body.resultados || []).some(x => x.titulo === "Academia Shape"));

    /* ===== Case-insensitive ===== */
    r = await reqJson(BASE + "/api/busca?q=ACADEMIA", json("GET", null));
    t("q=ACADEMIA (maiúsculo) acha academia", (r.body.resultados || []).some(x => x.titulo === "Academia Shape"));

    /* ===== Segmento parcial "odonto" ===== */
    r = await reqJson(BASE + "/api/busca?q=odonto", json("GET", null));
    const odonto = (r.body.resultados || []).find(x => x.titulo === "Dra. Maria Odonto");
    t("q=odonto acha Dra. Maria", !!odonto);

    /* ===== Link social (instagram) ===== */
    r = await reqJson(BASE + "/api/busca?q=instagram", json("GET", null));
    t("q=instagram acha academia pelo link", (r.body.resultados || []).some(x => x.titulo === "Academia Shape"));

    /* ===== Domínio (site via campo link) ===== */
    r = await reqJson(BASE + "/api/busca?q=odontomaria", json("GET", null));
    t("q=odontomaria (domínio do link) acha Dra. Maria", (r.body.resultados || []).some(x => x.titulo === "Dra. Maria Odonto"));

    /* ===== Número de bloco ===== */
    r = await reqJson(BASE + "/api/busca?q=450002", json("GET", null));
    const porBloco = (r.body.resultados || []).find(x => x.titulo === "Academia Shape");
    t("q=450002 acha academia por número de bloco", !!porBloco);
    r = await reqJson(BASE + "/api/busca?q=%23451000", json("GET", null));
    t("q=#451000 acha pinturas", (r.body.resultados || []).some(x => x.titulo === "Pinturas do Zé"));
    r = await reqJson(BASE + "/api/busca?q=bloco+451001", json("GET", null));
    t("q='bloco 451001' acha pinturas", (r.body.resultados || []).some(x => x.titulo === "Pinturas do Zé"));

    /* ===== Privacidade: link privado excluído ===== */
    const academias = (await reqJson(BASE + "/api/busca?q=academia", json("GET", null))).body.resultados || [];
    const acadLinks = academias.find(x => x.titulo === "Academia Shape").links || [];
    t("link privado (publico:false) não aparece", acadLinks.every(l => !l.url.includes("api-interna")));

    /* ===== Privacidade: paid e free não aparecem ===== */
    r = await reqJson(BASE + "/api/busca?q=roupas", json("GET", null));
    t("q=roupas não acha espaço paid", r.body.total === 0);
    r = await reqJson(BASE + "/api/busca?q=Espa%C3%A7o+Livre", json("GET", null));
    t("q='Espaço Livre' não acha espaço free", r.body.total === 0);

    /* ===== Filtro por categoria ===== */
    r = await reqJson(BASE + "/api/busca?categoria=EMPRESAS&q=academia", json("GET", null));
    t("categoria=EMPRESAS filtra corretamente", (r.body.resultados || []).every(x => x.categoria === "EMPRESAS"));
    r = await reqJson(BASE + "/api/busca?categoria=PESSOAS", json("GET", null));
    t("categoria=PESSOAS só traz pessoas", (r.body.resultados || []).every(x => x.categoria === "PESSOAS") &&
        (r.body.resultados || []).length === 1);
    r = await reqJson(BASE + "/api/busca?categoria=EMPRESAS", json("GET", null));
    t("categoria=EMPRESAS sem q lista todas", (r.body.resultados || []).length === 1, "n=" + (r.body.resultados || []).length);

    /* ===== Filtro por segmento ===== */
    r = await reqJson(BASE + "/api/busca?segmento=Odonto", json("GET", null));
    t("segmento=Odonto filtra", (r.body.resultados || []).every(x => x.segmento === "Odontologia"));

    /* ===== Categoria inválida na busca não quebra ===== */
    r = await reqJson(BASE + "/api/busca?categoria=NAO_EXISTE", json("GET", null));
    t("categoria inválida retorna vazio (ok)", r.body.ok === true && r.body.total === 0);

    /* ===== Paginação ===== */
    r = await reqJson(BASE + "/api/busca?limite=1&offset=0", json("GET", null));
    t("limite=1 retorna 1 resultado", (r.body.resultados || []).length === 1 && r.body.total === 3, "total=" + r.body.total);
    r = await reqJson(BASE + "/api/busca?limite=1&offset=1", json("GET", null));
    t("offset=1 pula o primeiro", (r.body.resultados || []).length === 1);

    /* ===== POST /api/anuncio/dados/:id — sem token ===== */
    r = await reqJson(BASE + "/api/anuncio/dados/450001", json("POST", null, { categoria: "EMPRESAS", segmento: "X", escopo: "solo" }));
    t("POST sem token -> 403", r.r.status === 403, "status=" + r.r.status);

    /* ===== Não é dono (outro usuário) ===== */
    const email2 = "busca-outro-" + Date.now() + "@teste.com";
    const reg2 = await reqJson(BASE + "/api/auth/registrar", json("POST", null, { nome: "Outro Usuário", email: email2, senha: "senha-teste-123" }));
    const userTok2 = reg2.body.token || "";
    r = await reqJson(BASE + "/api/anuncio/dados/450001", json("POST", userTok2, { categoria: "EMPRESAS", segmento: "X", escopo: "solo" }));
    t("POST outro usuário -> 403", r.r.status === 403, "status=" + r.r.status);

    /* ===== Dono (via orderToken no corpo) aplica solo ===== */
    r = await reqJson(BASE + "/api/anuncio/dados/450003", json("POST", userTok, {
        orderToken: "ORD-B",
        categoria: "PESSOAS",
        segmento: "Odontologia estética",
        descricao: "Clínica com atendimento humanizado.",
        palavras_chave: "dentista, estética dental",
        escopo: "solo",
        links: [{ url: "https://instagram.com/mariaodonto", tipo: "instagram", rotulo: "Instagram", publico: true }]
    }));
    t("POST dono solo -> ok", r.body.ok === true && r.body.spaces && r.body.spaces.length === 1, JSON.stringify(r.body));
    r = await reqJson(BASE + "/api/busca?q=estetica+dental", json("GET", null));
    t("dados novos (palavra-chave) refletem na busca", (r.body.resultados || []).some(x => x.titulo === "Dra. Maria Odonto"));
    r = await reqJson(BASE + "/api/busca?q=mariaodonto", json("GET", null));
    const linkNovo = (r.body.resultados || []).find(x => x.titulo === "Dra. Maria Odonto");
    t("novo link instagram salvo aparece", !!linkNovo && (linkNovo.links || []).some(l => l.url.includes("mariaodonto")));

    /* ===== Escopo bloco aplica nos vizinhos do mesmo token ===== */
    r = await reqJson(BASE + "/api/anuncio/dados/450001", json("POST", userTok, {
        orderToken: "ORD-A",
        categoria: "EMPRESAS",
        segmento: "Manutenção de equipamentos fitness",
        palavras_chave: "esteira, correia, motor",
        escopo: "bloco"
    }));
    t("POST dono bloco -> ok (2 espaços)", r.body.ok === true && r.body.spaces && r.body.spaces.length === 2,
        r.body.spaces ? JSON.stringify(r.body.spaces) : "n/a");
    r = await reqJson(BASE + "/api/busca?q=correia", json("GET", null));
    t("palavra-chave do bloco reflete na busca", (r.body.resultados || []).some(x => x.titulo === "Academia Shape"));

    /* ===== Categoria inválida -> 400 ===== */
    r = await reqJson(BASE + "/api/anuncio/dados/450003", json("POST", userTok, { orderToken: "ORD-B", categoria: "INVENTADA", escopo: "solo" }));
    t("categoria inválida -> 400", r.r.status === 400, "status=" + r.r.status);

    /* ===== Espaço inexistente -> 404 ===== */
    r = await reqJson(BASE + "/api/anuncio/dados/999999", json("POST", userTok, { categoria: "EMPRESAS", escopo: "solo" }));
    t("espaço inexistente -> 404", r.r.status === 404, "status=" + r.r.status);

    /* ===== Espaço free não pode salvar dados -> 403 ===== */
    r = await reqJson(BASE + "/api/anuncio/dados/459999", json("POST", userTok, { categoria: "EMPRESAS", escopo: "solo" }));
    t("espaço free -> 403", r.r.status === 403, "status=" + r.r.status);

    const fails = log.filter(l => l.startsWith("FAIL"));
    console.log(log.join("\n"));
    console.log("\nRESULTADO: " + (log.length - fails.length) + "/" + log.length + " passaram");
    if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
}

main().catch(e => { console.error("ERRO FATAL:", e); process.exit(1); });