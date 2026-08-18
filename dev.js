/* =========================================================
   MODO DE DESENVOLVIMENTO / TESTE LOCAL
   Roda o site inteiro SEM banco de dados externo (usa pg-mem
   em memória) e SEM pagamento real (ALLOW_TEST_MODE).

   Como usar:
     node dev.js
   Depois abra:   http://localhost:3000
   Painel admin:  http://localhost:3000/admin.html

   Login do admin (default, se não houver ADMIN_USER/PASSWORD):
     usuário: admin
     senha:   senha123

   No site: selecione espaços, vá em GERAR PIX e use o botão
   "🧪 TESTAR SEM PAGAMENTO" para marcar blocos como pagos.

   ATENÇÃO: nunca use este modo em produção.
========================================================= */

if (process.env.DATABASE_URL && !/^postgres(?:ql)?:\/\/memoria(?:[-\w]*)$/i.test(process.env.DATABASE_URL)) {
    throw new Error("Modo dev bloqueado: DATABASE_URL real detectada. Use pg-mem.");
}
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.MERCADOPAGO_SANDBOX = process.env.MERCADOPAGO_SANDBOX || "true";
process.env.PORT = process.env.PORT || "3000";

require("dotenv").config();

if (!process.env.ADMIN_USER) process.env.ADMIN_USER = "admin";
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "senha123";

const path = require("path");
const fs = require("fs");

const dirBase =
    process.env.DATA_DIR ||
    path.join(process.env.TEMP || "/tmp", "opencode", "mega-dev-data");

fs.mkdirSync(path.join(dirBase, "data"), { recursive: true });
fs.mkdirSync(path.join(dirBase, "uploads"), { recursive: true });

if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(dirBase, "data");
if (!process.env.UPLOAD_DIR) process.env.UPLOAD_DIR = path.join(dirBase, "uploads");

const dbFile = path.join(process.env.DATA_DIR, "spaces.json");
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, "{}");

const { newDb } = require("pg-mem");
const db = newDb();
const adapter = db.adapters.createPg();

const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) pgReal.types = adapter.types;

require(path.join(__dirname, "server.js"));

console.log("");
console.log("==============================================");
console.log("  MODO DEV (sem banco externo, sem pagamento)");
console.log("  Site:      http://localhost:" + process.env.PORT);
console.log("  Admin:     http://localhost:" + process.env.PORT + "/admin.html");
console.log("  Admin user: " + process.env.ADMIN_USER);
console.log("  Admin pass: " + process.env.ADMIN_PASSWORD);
console.log("  Use o botão '🧪 TESTAR SEM PAGAMENTO' no site.");
console.log("==============================================");
