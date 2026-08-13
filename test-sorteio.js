/* =========================================================
   TESTE DE HOMOLOGAÇÃO — SORTEIO SEMANAL
   Participantes (blocos paid/published sem test, com e-mail)
   -> Sorteio -> Aviso (e-mail + banner) -> Histórico

   Self-contained: roda o servidor em processo com pg-mem.
   Uso:
     node test-sorteio.js
========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3187";
process.env.DEBUG_PG = "1";

const path = require("path");
const fs = require("fs");

const tmpDir = path.join(
    process.env.TEMP || "/tmp", "opencode", "td-sor-" + Date.now()
);
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");

const DB_FILE = path.join(process.env.DATA_DIR, "spaces.json");

const seed = {
    "1": { id: 1, status: "paid", name: "Ana", email: "ana@teste.com", createdAt: "2026-01-01T00:00:00.000Z" },
    "2": { id: 2, status: "published", name: "Bruno", email: "bruno@teste.com", createdAt: "2026-01-01T00:00:00.000Z" },
    "3": { id: 3, status: "paid", name: "Carla", email: "carla@teste.com", createdAt: "2026-01-01T00:00:00.000Z" },
    "4": { id: 4, status: "paid", name: "Teste", email: "teste@teste.com", test: true, createdAt: "2026-01-01T00:00:00.000Z" },
    "5": { id: 5, status: "paid", name: "SemEmail", email: "", createdAt: "2026-01-01T00:00:00.000Z" },
    "6": { id: 6, status: "reserved", name: "Reserva", email: "reserva@teste.com", createdAt: "2026-01-01T00:00:00.000Z" }
};

fs.writeFileSync(DB_FILE, JSON.stringify(seed));

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();

const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;

require(path.join(__dirname, "server.js"));

const BASE = "http://localhost:" + process.env.PORT;
const log = [];

function t(nome, cond, extra) {
    log.push(
        (cond ? "PASS" : "FAIL") +
        " | " + nome +
        (extra ? " | " + extra : "")
    );
}

async function reqJson(url, opts) {
    const r = await fetch(url, opts);
    const texto = await r.text();
    let body = null;
    try {
        body = JSON.parse(texto);
    } catch (e) {
        body = { raw: texto.slice(0, 120) };
    }
    return { r, body };
}

function jsonOpts(method, token, payload) {
    return {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { "Authorization": "Bearer " + token } : {})
        },
        ...(payload !== undefined
            ? { body: JSON.stringify(payload) }
            : {})
    };
}

async function esperarServidor() {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(BASE + "/");
            if (r.ok) return true;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

(async () => {

    const pronto = await esperarServidor();
    t("servidor iniciou", pronto);
    if (!pronto) {
        return finalizar();
    }

    const login = await reqJson(
        BASE + "/api/admin/login",
        jsonOpts("POST", null, {
            usuario: "admin",
            senha: "senha123"
        })
    );
    t("login admin ok", login.r.status === 200 && login.body.token);
    const token = login.body.token || "";

    const publico = await reqJson(BASE + "/api/sorteio");
    t(
        "api publica: 3 participantes e 3 bilhetes",
        publico.body.ok &&
            publico.body.totalParticipantes === 3 &&
            publico.body.totalBilhetes === 3,
        "participantes=" + publico.body.totalParticipantes +
            " bilhetes=" + publico.body.totalBilhetes
    );

    const semAuth = await reqJson(
        BASE + "/api/admin/sorteio/sortear",
        jsonOpts("POST", null, { valor: "R$ 500" })
    );
    t("sortear sem token -> 401", semAuth.r.status === 401);

    const semValor = await reqJson(
        BASE + "/api/admin/sorteio/sortear",
        jsonOpts("POST", token, {})
    );
    t("sortear sem valor -> 400", semValor.r.status === 400);

    const sort1 = await reqJson(
        BASE + "/api/admin/sorteio/sortear",
        jsonOpts("POST", token, { valor: "R$ 500" })
    );
    const emailsValidos = ["ana@teste.com", "bruno@teste.com", "carla@teste.com"];
    t(
        "sorteio 1: ganhador valido",
        sort1.r.status === 200 &&
            sort1.body.registro &&
            emailsValidos.includes(sort1.body.registro.email) &&
            sort1.body.registro.totalBilhetes === 3,
        "ganhador=" + (sort1.body.registro && sort1.body.registro.email) +
            " valor=" + (sort1.body.registro && sort1.body.registro.valor)
    );

    const aviso = await reqJson(
        BASE + "/api/admin/sorteio/aviso",
        jsonOpts("POST", token, { valor: "R$ 500", mensagem: "Mega sorteio!" })
    );
    t(
        "aviso salvo com mensagem",
        aviso.r.status === 200 &&
            aviso.body.aviso &&
            aviso.body.aviso.valor === "R$ 500" &&
            aviso.body.aviso.mensagem === "Mega sorteio!" &&
            aviso.body.destinatarios === 3,
        "destinatarios=" + aviso.body.destinatarios +
            " enviados=" + aviso.body.enviados
    );

    const publico2 = await reqJson(BASE + "/api/sorteio");
    t(
        "api publica com aviso + ultimo ganhador",
        publico2.body.aviso &&
            publico2.body.aviso.valor === "R$ 500" &&
            publico2.body.ultimoGanhador &&
            publico2.body.ultimoGanhador.valor === "R$ 500"
    );
    t(
        "api publica esconde email do ganhador",
        !publico2.body.ultimoGanhador.email
    );

    const adminGet = await reqJson(
        BASE + "/api/admin/sorteio",
        jsonOpts("GET", token)
    );
    t(
        "admin: historico com 1 registro",
        adminGet.r.status === 200 &&
            adminGet.body.historico.length === 1
    );

    const limpaAviso = await reqJson(
        BASE + "/api/admin/sorteio/aviso",
        jsonOpts("DELETE", token)
    );
    const publico3 = await reqJson(BASE + "/api/sorteio");
    t(
        "aviso removido do banner",
        limpaAviso.r.status === 200 &&
            publico3.body.aviso === null
    );

    const delUltimo = await reqJson(
        BASE + "/api/admin/sorteio",
        jsonOpts("DELETE", token)
    );
    const adminGet2 = await reqJson(
        BASE + "/api/admin/sorteio",
        jsonOpts("GET", token)
    );
    t(
        "ultimo sorteio apagado do historico",
        delUltimo.r.status === 200 &&
            adminGet2.body.historico.length === 0
    );

    fs.writeFileSync(DB_FILE, "{}");

    const semBlocos = await reqJson(
        BASE + "/api/admin/sorteio/sortear",
        jsonOpts("POST", token, { valor: "R$ 500" })
    );
    t(
        "sortear sem blocos -> 400",
        semBlocos.r.status === 400
    );

    finalizar();

})().catch(err => {
    log.push("FAIL | excecao | " + (err && err.stack || err));
    finalizar();
});

function finalizar() {
    const pass = log.filter(l => l.startsWith("PASS")).length;
    const fail = log.filter(l => l.startsWith("FAIL")).length;
    console.log(log.join("\n"));
    console.log("-----------------------------");
    console.log("SORTEIO: " + pass + "/" + (pass + fail));
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) { }
    process.exit(fail > 0 ? 1 : 0);
}
