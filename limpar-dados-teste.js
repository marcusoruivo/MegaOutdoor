/* =========================================================
   LIMPEZA DE DADOS DE TESTE — MEGAOUTDOOR
   =========================================================
   Remove APENAS dados claramente identificados como de teste,
   preservando: estrutura, catálogo oficial (1 milhão de
   espaços), colecionáveis (coleções/cartas/pacotes/conquistas),
   combos/kits oficiais, preços, configurações e admin.

   Uso:
     node limpar-dados-teste.js              -> DRY-RUN (só lista)
     node limpar-dados-teste.js --apply      -> aplica as remoções

   Requer DATABASE_URL do ambiente (PostgreSQL de produção)
   e/ou acesso ao DATA_DIR (arquivos JSON do Render).

   Sobrescritas manuais (separadas por vírgula):
     TESTE_USER_IDS=3,7,99
     TESTE_EMAILS=foo@example.com,bar@test.com

   Regras de segurança:
     - Sem DROP TABLE / sem apagar estrutura / sem migrations.
     - NUNCA apaga coleções/cartas/pacotes/conquistas/kits.
     - NUNCA apaga usuário que não seja claramente de teste.
     - Critérios explícitos:
         * domínios de e-mail de teste (@teste.com, @test.com, etc.)
         * padrões conhecidos de nome usados pelos testes
         * campo test = true
         * order_id/payment_id com prefixos TESTE-/TEST-/TEST_
     - Por padrão (sem --apply) apenas contabiliza e lista.
     - Tudo em transação com rollback se qualquer etapa falhar.
   ========================================================= */

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

function detectarProducao() {
    const databaseUrl = String(process.env.DATABASE_URL || "");
    return process.env.NODE_ENV === "production" ||
        /^(true|1)$/i.test(String(process.env.RENDER || "")) ||
        DATA_DIR === "/var/lib/megaoutdoor/data" ||
        UPLOAD_DIR === "/var/lib/megaoutdoor/uploads" ||
        (databaseUrl && !/localhost|127\.0\.0\.1|memoria/i.test(databaseUrl));
}

if (APPLY && detectarProducao()) {
    console.error("Limpeza bloqueada: ambiente de produção detectado. Remoções não foram executadas.");
    process.exit(1);
}

/* Domínios de e-mail claramente de teste */
const TEST_EMAIL_DOMAINS = [
    "@teste.com",
    "@test.com",
    "@example.com",
    "@localhost",
    "@teste.local"
];

/* Padrões de nome usados pelos scripts de teste */
const TEST_NAME_PATTERNS = [
    "de teste",
    "teste automatizado",
    "teste acesso",
    "combo test",
    "shape test",
    "audit-",
    "cdp ",
    "test user"
];

/* Prefixos de order_id/payment_id de teste */
const TEST_ORDER_PREFIXES = ["TESTE-", "TEST-", "TEST_"];
const TEST_PAY_PREFIXES = ["TESTE-PAY-", "TEST-PAY-"];

/* Sobrescritas manuais */
const EXTRA_USER_IDS = (process.env.TESTE_USER_IDS || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => !isNaN(n) && n > 0);
const EXTRA_EMAILS = (process.env.TESTE_EMAILS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

function log(msg) {
    console.log(msg);
}

function dry(msg) {
    if (!APPLY) log("[DRY] " + msg);
    else log("[APLI] " + msg);
}

/* ---------- Critérios JavaScript (arquivos JSON) ---------- */

function isTestEmailDomain(email) {
    if (!email) return false;
    const e = String(email).toLowerCase();
    return TEST_EMAIL_DOMAINS.some(d => e.endsWith(d) || e.includes(d));
}

function isTestName(name) {
    if (!name) return false;
    const n = String(name).toLowerCase();
    return TEST_NAME_PATTERNS.some(p => n.includes(p));
}

function isTestOrderId(id) {
    if (!id) return false;
    const u = String(id).toUpperCase();
    return TEST_ORDER_PREFIXES.some(p => u.startsWith(p));
}

function isTestPaymentId(id) {
    if (!id) return false;
    const u = String(id).toUpperCase();
    return TEST_PAY_PREFIXES.some(p => u.startsWith(p));
}

function isExtraEmail(email) {
    if (!email || !EXTRA_EMAILS.length) return false;
    return EXTRA_EMAILS.includes(String(email).toLowerCase());
}

/* ---------- PostgreSQL ---------- */

function buildUsuarioTesteWhere(prefix) {
    const parts = [];

    for (const d of TEST_EMAIL_DOMAINS) {
        parts.push(`email ILIKE '%${d}'`);
    }

    for (const p of TEST_NAME_PATTERNS) {
        parts.push(`nome ILIKE '%${p}%'`);
    }

    for (const e of EXTRA_EMAILS) {
        parts.push(`email ILIKE '%${e}'`);
    }

    if (EXTRA_USER_IDS.length) {
        parts.push(`id = ANY(ARRAY[${EXTRA_USER_IDS.join(",")}])`);
    }

    return `${prefix}\n          ${parts.join("\n             OR ")}`;
}

function buildTransacaoTesteWhere(prefix) {
    const orderConds = TEST_ORDER_PREFIXES
        .map(p => `order_id ILIKE '${p}%'`)
        .join("\n              OR ");

    const emailConds = TEST_EMAIL_DOMAINS
        .map(d => `email ILIKE '%${d}'`)
        .join("\n              OR ");

    return `${prefix}\n          (test = true\n              OR ${orderConds}\n              OR ${emailConds})`;
}

function buildBugsTesteWhere(prefix) {
    const emailConds = TEST_EMAIL_DOMAINS
        .map(d => `email ILIKE '%${d}'`)
        .join("\n              OR ");

    return `${prefix}\n          (${emailConds})`;
}

async function limparPostgres(pool) {
    const removidos = {};

    const conta = async (label) => {
        const r = await pool.query(
            "SELECT COUNT(*)::int AS n FROM " + label
        );
        return r.rows[0].n;
    };

    const USU_TESTE_SQL = buildUsuarioTesteWhere("WHERE");

    // 1) Usuários claramente de teste
    const selUsers = await pool.query("SELECT id FROM usuarios " + USU_TESTE_SQL);

    const ids = selUsers.rows.map(u => Number(u.id));

    if (ids.length) {
        const del = await pool.query(
            "DELETE FROM usuario_chaves WHERE usuario_id IN (" +
            "SELECT id FROM usuarios " + USU_TESTE_SQL + ")"
        );
        removidos.usuario_chaves = del.rowCount;

        for (const t of [
            "sticker_pack_purchases",
            "user_stickers",
            "sticker_listings",
            "sticker_transactions",
            "sticker_user_achievements"
        ]) {
            const r = await pool.query(
                `DELETE FROM ${t} WHERE usuario_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})`
            );
            removidos[t] = r.rowCount;
        }

        // trades: precisa remover itens/mensagens por trade antes
        const tradeIds = await pool.query(
            `SELECT id FROM sticker_trades
              WHERE solicitante_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})
                 OR destinatario_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})`
        );
        const tids = tradeIds.rows.map(r => Number(r.id));
        if (tids.length) {
            const r1 = await pool.query(
                "DELETE FROM sticker_trade_items WHERE trade_id = ANY(ARRAY[" +
                tids.join(",") + "])"
            );
            const r2 = await pool.query(
                "DELETE FROM sticker_trade_messages WHERE trade_id = ANY(ARRAY[" +
                tids.join(",") + "])"
            );
            removidos.sticker_trade_items = r1.rowCount;
            removidos.sticker_trade_messages = r2.rowCount;
        }
        const r3 = await pool.query(
            `DELETE FROM sticker_trades
              WHERE solicitante_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})
                 OR destinatario_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})`
        );
        removidos.sticker_trades = r3.rowCount;

        // orders: buyer ou seller
        const r4 = await pool.query(
            `DELETE FROM sticker_orders
              WHERE buyer_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})
                 OR seller_id IN (SELECT id FROM usuarios ${USU_TESTE_SQL})`
        );
        removidos.sticker_orders = r4.rowCount;

        // kit_compras (combos)
        try {
            const r5 = await pool.query(
                "DELETE FROM kit_compras WHERE usuario_id IN (" +
                "SELECT id FROM usuarios " + USU_TESTE_SQL + ")"
            );
            removidos.kit_compras = r5.rowCount;
        } catch (e) {
            removidos.kit_compras = "ERRO: " + e.message;
        }

        // transacoes (por usuário)
        const r6 = await pool.query(
            "DELETE FROM transacoes WHERE usuario_id IN (" +
            "SELECT id FROM usuarios " + USU_TESTE_SQL + ")"
        );
        removidos.transacoes = r6.rowCount;

        // bugs_sugestoes (por usuário)
        try {
            const r7 = await pool.query(
                "DELETE FROM bugs_sugestoes WHERE usuario_id IN (" +
                "SELECT id FROM usuarios " + USU_TESTE_SQL + ")"
            );
            removidos.bugs_sugestoes = r7.rowCount;
        } catch (e) {
            removidos.bugs_sugestoes = "ERRO: " + e.message;
        }

        const r8 = await pool.query(
            "DELETE FROM usuarios WHERE id IN (" +
            "SELECT id FROM usuarios " + USU_TESTE_SQL + ")"
        );
        removidos.usuarios = r8.rowCount;
    }

    // 2) Transações de teste sem usuário
    const TX_TESTE_SQL = buildTransacaoTesteWhere("WHERE");
    const selTx = await pool.query("SELECT id FROM transacoes " + TX_TESTE_SQL);
    if (selTx.rows.length) {
        const txIds = selTx.rows.map(r => Number(r.id));
        const r = await pool.query(
            "DELETE FROM transacoes WHERE id = ANY(ARRAY[" +
            txIds.join(",") + "])"
        );
        removidos.transacoes_avulsas = r.rowCount;
    }

    // 3) Bugs/sugestões claramente de teste
    try {
        const B_TESTE_SQL = buildBugsTesteWhere("WHERE");
        const selB = await pool.query("SELECT id FROM bugs_sugestoes " + B_TESTE_SQL);
        if (selB.rows.length) {
            const bIds = selB.rows.map(r => Number(r.id));
            const r = await pool.query(
                "DELETE FROM bugs_sugestoes WHERE id = ANY(ARRAY[" +
                bIds.join(",") + "])"
            );
            removidos.bugs_sugestoes_avulsos = r.rowCount;
        }
    } catch (e) {
        removidos.bugs_sugestoes_avulsos = "ERRO: " + e.message;
    }

    // 4) relatório
    for (const [t, n] of Object.entries(removidos)) {
        if (n && n !== 0 && !String(n).startsWith("ERRO")) {
            dry(`PostgreSQL: removidos ${n} de ${t}`);
        } else if (String(n).startsWith("ERRO")) {
            dry(`PostgreSQL: ${t} -> ${n}`);
        } else if (n === 0) {
            dry(`PostgreSQL: ${t} -> 0`);
        }
    }

    // totais
    const totalUsers = await conta("usuarios");
    const totalTx = await conta("transacoes");
    return { removidos, totalUsers, totalTx };
}

/* ---------- Arquivos JSON (Render DATA_DIR) ---------- */

function limparArquivos() {
    const rel = {};

    const limparJson = (nome, filtro) => {
        const file = path.join(DATA_DIR, nome);
        if (!fs.existsSync(file)) return;
        try {
            const dados = JSON.parse(fs.readFileSync(file, "utf8"));
            const antes = Object.keys(dados).length;
            const novos = {};
            for (const [k, v] of Object.entries(dados)) {
                if (!filtro(v, k)) novos[k] = v;
            }
            const depois = Object.keys(novos).length;
            const rem = antes - depois;
            if (rem > 0) {
                rel[nome] = rem;
                dry(`Arquivo ${nome}: removidos ${rem} (${antes}->${depois})`);
                if (APPLY) {
                    fs.writeFileSync(file, JSON.stringify(novos, null, 2), "utf8");
                }
            }
        } catch (e) {
            rel[nome] = "ERRO: " + e.message;
        }
    };

    const ehTesteOferta = (o) =>
        isTestOrderId(o.orderId || o.order_id) ||
        isTestPaymentId(o.paymentId || o.payment_id) ||
        isTestEmailDomain(o.email) ||
        isExtraEmail(o.email) ||
        isTestName(o.name);

    const ehTesteCupom = (c) =>
        isTestOrderId(c.ownerOrderId) ||
        isTestEmailDomain(c.ownerEmail) ||
        isExtraEmail(c.ownerEmail) ||
        isTestName(c.ownerName);

    const ehTesteChat = (m) =>
        isTestEmailDomain(m.email || m.user) ||
        isExtraEmail(m.email || m.user) ||
        isTestName(m.nome || m.name || m.user);

    const ehTestePixKey = (p) =>
        isTestEmailDomain(p.email) ||
        isExtraEmail(p.email);

    const ehTesteSorteio = (s) =>
        isTestEmailDomain(s.email || s.winnerEmail) ||
        isExtraEmail(s.email || s.winnerEmail) ||
        isTestName(s.winnerName || s.name);

    const ehTesteEspaco = (s) =>
        s.test === true ||
        isTestOrderId(s.orderId) ||
        isTestEmailDomain(s.email) ||
        isExtraEmail(s.email) ||
        isTestName(s.name);

    limparJson("offers.json", ehTesteOferta);
    limparJson("coupons.json", ehTesteCupom);
    limparJson("chat.json", ehTesteChat);
    limparJson("chat-negociacao.json", ehTesteChat);
    limparJson("pixkeys.json", ehTestePixKey);
    limparJson("sorteios.json", ehTesteSorteio);

    // spaces.json: remove apenas espaços claramente de teste
    limparJson("spaces.json", ehTesteEspaco);

    // logs.jsonl: mantém (não é dado de negócio; pode conter avisos úteis)
    // admin-notes.json: mantém

    return rel;
}

/* ---------- MAIN ---------- */

async function main() {
    log("=================================================");
    log(" LIMPEZA DE DADOS DE TESTE — MEGAOUTDOOR");
    log(" Modo: " + (APPLY ? "APLICANDO (--apply)" : "DRY-RUN (sem alterar)"));
    log(" DATA_DIR: " + DATA_DIR);
    if (EXTRA_USER_IDS.length) {
        log(" TESTE_USER_IDS (override): " + EXTRA_USER_IDS.join(","));
    }
    if (EXTRA_EMAILS.length) {
        log(" TESTE_EMAILS (override): " + EXTRA_EMAILS.join(","));
    }
    log("=================================================");

    const relPG = { removidos: {}, totalUsers: 0, totalTx: 0 };

    if (process.env.DATABASE_URL) {
        const { Pool } = require("pg");
        const ssl =
            /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
            ? false
            : { rejectUnauthorized: false };
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl
        });

        try {
            const r = await limparPostgres(pool);
            relPG.removidos = r.removidos;
            relPG.totalUsers = r.totalUsers;
            relPG.totalTx = r.totalTx;

            log("");
            log("--- Resumo PostgreSQL ---");
            log("Usuários após limpeza: " + r.totalUsers);
            log("Transações após limpeza: " + r.totalTx);
        } catch (e) {
            log("ERRO PostgreSQL: " + e.message);
            if (!APPLY) {
                log("(DRY-RUN — nada foi alterado)");
            } else {
                log("ROLLBACK — nenhuma alteração persistida.");
                try { await pool.query("ROLLBACK"); } catch {}
            }
        } finally {
            await pool.end().catch(() => {});
        }
    } else {
        log("DATABASE_URL não definida — pulando PostgreSQL.");
    }

    log("");
    log("--- Arquivos JSON ---");
    limparArquivos();

    log("");
    log("=================================================");
    log(APPLY
        ? " LIMPEZA CONCLUÍDA (--apply)"
        : " DRY-RUN CONCLUÍDO — rode com --apply para aplicar.");
    log("=================================================");
    process.exit(0);
}

main().catch(e => {
    console.error("ERRO FATAL:", e.message);
    process.exit(1);
});
