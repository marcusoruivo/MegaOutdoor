/*
 * RESET CONTROLADO DE PRODUCAO
 *
 * Uso somente no ambiente do banco publicado:
 *   RESET_PRODUCTION=true node reset-producao.js --confirm=RESET-PRODUCAO
 *
 * Preserva catalogo de espacos, colecionaveis, pacotes, conquistas,
 * kits, precos e estrutura. Remove somente dados de usuarios, vendas,
 * pagamentos, blocos publicados e arquivos enviados por usuarios.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const confirmacao = process.argv.find(arg => arg.startsWith("--confirm="))?.split("=")[1];
const databaseUrl = String(process.env.DATABASE_URL || "");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

if (process.env.RESET_PRODUCTION !== "true" || confirmacao !== "RESET-PRODUCAO") {
    throw new Error("Reset bloqueado. Use RESET_PRODUCTION=true e --confirm=RESET-PRODUCAO.");
}
if (!databaseUrl || /localhost|127\.0\.0\.1|memoria/i.test(databaseUrl)) {
    throw new Error("DATABASE_URL de producao nao configurada.");
}

const tables = [
    "transacoes", "usuarios", "indicacoes", "beneficios_indicacao",
    "concessoes_administrativas", "ultimas_compras", "story_events", "destaques",
    "marketplace_accounts", "marketplace_oauth_states", "usuario_chaves",
    "senha_recuperacoes", "notificacoes", "bugs_sugestoes", "sticker_pack_purchases",
    "sticker_pack_inventory", "user_stickers", "sticker_listings",
    "sticker_listing_messages", "sticker_listing_conversations", "sticker_auctions",
    "sticker_auction_bids", "sticker_auction_reservations", "sticker_auction_orders",
    "sticker_orders", "sticker_trades", "sticker_trade_items", "sticker_trade_messages",
    "sticker_transactions", "sticker_user_achievements", "sticker_monthly_rewards",
    "sticker_offers", "sticker_offer_reservations", "sticker_completions",
    "album_listings", "album_orders", "album_offers", "kit_compras"
];

function limparArquivos(dir) {
    if (!fs.existsSync(dir)) return;
    for (const nome of fs.readdirSync(dir)) {
        const alvo = path.join(dir, nome);
        const stat = fs.statSync(alvo);
        if (stat.isDirectory()) fs.rmSync(alvo, { recursive: true, force: true });
        else fs.rmSync(alvo, { force: true });
    }
}

async function main() {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const existentes = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
            [tables]
        );
        const nomes = existentes.rows.map(row => `"${row.table_name.replace(/"/g, '""')}"`);
        if (nomes.length) await client.query(`TRUNCATE TABLE ${nomes.join(", ")} RESTART IDENTITY CASCADE`);
        await client.query("COMMIT");

        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, "spaces.json"), "{}\n", "utf8");
        limparArquivos(uploadDir);
        console.log(`Reset concluido: ${nomes.length} tabelas limpas.`);
        console.log("Catalogo, colecionaveis, kits e estrutura foram preservados.");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error("RESET NAO EXECUTADO:", error.message);
    process.exitCode = 1;
});
