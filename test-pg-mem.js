/* Harness de teste com instrumentação do pool (diagnóstico). */
process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.PORT = process.env.PORT || "3000";
process.env.DEBUG_PG = "1";

const path = require("path");
const fs = require("fs");

const tmpDir = path.join(
    process.env.TEMP || "/tmp", "opencode", "td-mem-" + Date.now()
);
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();

const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;

require(path.join(__dirname, "server.js"));

process.on("exit", () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
