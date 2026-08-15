require("dotenv").config();

const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pdfkit = require("pdfkit");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

if (
    process.env.RENDER ||
    process.env.TRUST_PROXY === "true"
) {
    app.set("trust proxy", 1);
}

const PRODUCAO =
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.RENDER);

const ALLOW_TEST_MODE =
    process.env.ALLOW_TEST_MODE === "true";

const MAX_CREDITOS_INDICACAO = 4;

const limiterGlobal = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitas requisições. Tente novamente em alguns minutos."
    }
});

const limiterSensivel = rateLimit({
    windowMs: 60 * 1000,
    limit: ALLOW_TEST_MODE ? 300 : 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitas tentativas. Aguarde um pouco e tente novamente."
    }
});

/* Login/cadastro: limite menor, proteção contra força bruta.
   O uso legítimo faz poucas tentativas por minuto. */
const limiterLogin = rateLimit({
    windowMs: 60 * 1000,
    limit: ALLOW_TEST_MODE ? 100 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitas tentativas de login. Aguarde um pouco e tente novamente."
    }
});

/* Leituras da conta (auth/me, extrato): limite maior, pois a
   navegação no painel faz várias consultas legítimas. */
const limiterLeitura = rateLimit({
    windowMs: 60 * 1000,
    limit: ALLOW_TEST_MODE ? 500 : 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitas requisições. Aguarde um instante e tente novamente."
    }
});

const limiterChat = rateLimit({
    windowMs: 10 * 1000,
    limit: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Aguarde alguns segundos antes de enviar outra mensagem."
    }
});

const limiterOfertas = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitas tentativas. Aguarde um pouco e tente novamente."
    }
});

const limiterUpload = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitos envios. Aguarde um pouco."
    }
});

/* Relatos de bug/sugestão: limite por usuário/IP para
   evitar spam, mas generoso para uso legítimo. */
const limiterBugs = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: ALLOW_TEST_MODE ? 500 : 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Você já enviou muitos relatos. Aguarde alguns minutos e tente novamente."
    }
});

/* =========================
   MERCADO PAGO (Orders API)
   Documentação: https://www.mercadopago.com.br/developers
========================= */

const MERCADOPAGO_ACCESS_TOKEN =
    process.env.MERCADOPAGO_ACCESS_TOKEN || "";

const MERCADOPAGO_PUBLIC_KEY =
    process.env.MERCADOPAGO_PUBLIC_KEY || "";

const MERCADOPAGO_WEBHOOK_SECRET =
    process.env.MERCADOPAGO_WEBHOOK_SECRET || "";

const MERCADOPAGO_SANDBOX =
    process.env.MERCADOPAGO_SANDBOX === "true";

const MERCADOPAGO_API = "https://api.mercadopago.com";

const SEED_DIR = path.join(__dirname, "data");
const DEFAULT_UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = process.env.DATA_DIR || SEED_DIR;
const UPLOAD_DIR = process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR;
const DB_FILE = path.join(DATA_DIR, "spaces.json");
const OFFERS_FILE = path.join(DATA_DIR, "offers.json");
const COUPONS_FILE = path.join(DATA_DIR, "coupons.json");
const PIXKEYS_FILE = path.join(DATA_DIR, "pixkeys.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");
const CHAT_NEGOC_FILE = path.join(DATA_DIR, "chat-negociacao.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.jsonl");
const SORTEIOS_FILE = path.join(DATA_DIR, "sorteios.json");
const ADMIN_NOTES_FILE =
    path.join(DATA_DIR, "admin-notes.json");
const RESERVAS_LIBERADAS_FILE =
    path.join(DATA_DIR, "reservas-liberadas.json");

/* Tempo máximo que um espaço fica "reserved" aguardando
   o pagamento do PIX. Após isso, o espaço é liberado.
   Configurável via RESERVA_TTL_MINUTOS (padrão: 10).
   A reserva também expira no prazo do QR Code do PIX
   (expiration_date da Order do Mercado Pago), o que vier antes. */
const RESERVA_TTL_MINUTOS =
    Math.max(1, Number(process.env.RESERVA_TTL_MINUTOS) || 10);
const RESERVA_TTL_MS =
    RESERVA_TTL_MINUTOS * 60 * 1000;

/* =========================
   PLANOS DE LICENÇA
   Preço base: R$1,00 por bloco.
   Taxa adicional cobrada UMA ÚNICA VEZ por pedido.
========================= */

const BASE_PRICE_PER_BLOCK = 1.00;

const LICENSE_PLANS = {
    "1_year": {
        label: "1 ANO",
        months: 12,
        fee: 0,
        recommended: false,
        tagline: ""
    },
    "3_years": {
        label: "3 ANOS",
        months: 36,
        fee: 20,
        recommended: true,
        tagline: "RECOMENDADO"
    },
    "5_years": {
        label: "5 ANOS",
        months: 60,
        fee: 40,
        recommended: false,
        tagline: "MELHOR CUSTO-BENEFÍCIO"
    }
};

/* =========================
   VALORES MONETÁRIOS — CENTAVOS
   Todo cálculo financeiro é feito em centavos (inteiros),
   nunca com Number/float diretamente.
   R$ 22,50 = 2250 centavos. NUNCA usar 22.5 / 22.5000001.
========================= */

function paraCentavos(valor) {
    if (valor === undefined || valor === null || valor === "") {
        return 0;
    }
    if (typeof valor === "number") {
        if (!isFinite(valor)) {
            return 0;
        }
        return Math.round(valor * 100);
    }
    let s = String(valor).trim();
    if (!s) {
        return 0;
    }
    const negativo = s.startsWith("-");
    s = s.replace(/[^\d.,]/g, "");
    if (!s) {
        return 0;
    }
    const sep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
    let inteiros, decimais = "00";
    if (sep !== -1) {
        inteiros = s.slice(0, sep).replace(/[.,]/g, "") || "0";
        decimais = s.slice(sep + 1).replace(/[.,]/g, "");
    } else {
        inteiros = s.replace(/[.,]/g, "") || "0";
    }
    decimais = (decimais + "00").slice(0, 2);
    const cents = parseInt(inteiros, 10) * 100 + parseInt(decimais, 10);
    return negativo ? -cents : cents;
}

function reaisDeCentavos(cents) {
    return (Number(cents) || 0) / 100;
}

/* R$ 22,50 (exatamente 2 casas decimais). */
function formatarReais(cents) {
    const c = Math.round(Number(cents) || 0);
    const neg = c < 0;
    const abs = Math.abs(c);
    return (
        (neg ? "-" : "") +
        "R$ " + Math.floor(abs / 100).toLocaleString("pt-BR") +
        "," + String(abs % 100).padStart(2, "0")
    );
}

/* Valor no formato esperado pela API do Mercado Pago (string "22.50"). */
function reaisParaMercadoPago(cents) {
    const c = Math.round(Number(cents) || 0);
    return String((c / 100).toFixed(2));
}

/* Desconto percentual sobre um valor em centavos (arredondado). */
function descontoEmCentavos(valorCents, pct) {
    const p = Number(pct) || 0;
    if (p <= 0) {
        return 0;
    }
    if (p >= 100) {
        return Math.round(Number(valorCents) || 0);
    }
    return Math.round((Number(valorCents) || 0) * p / 100);
}

function calcularLicenca(quantidade, planoKey) {

    const plano =
        LICENSE_PLANS[planoKey] ||
        LICENSE_PLANS["1_year"];

    const baseAmountCents =
        Math.round(Number(quantidade) || 0) *
        paraCentavos(BASE_PRICE_PER_BLOCK);

    const feeCents =
        paraCentavos(plano.fee);

    const totalAmountCents =
        baseAmountCents + feeCents;

    return {
        plan: planoKey,
        label: plano.label,
        months: plano.months,
        fee: plano.fee,
        baseAmount: reaisDeCentavos(baseAmountCents),
        totalAmount: reaisDeCentavos(totalAmountCents),
        baseAmountCents,
        feeCents,
        totalAmountCents,
        basePricePerBlock: BASE_PRICE_PER_BLOCK
    };
}

function adicionarMeses(data, meses) {

    const d = new Date(data);
    const diaOriginal = d.getDate();

    d.setMonth(d.getMonth() + meses);

    /* Se o dia mudou (ex: 31/01 + 1 mês = 28/02),
       mantemos o último dia do mês de destino. */
    if (d.getDate() !== diaOriginal) {
        d.setDate(0);
    }

    return d;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* =========================
   SEGREDO DO JWT
   Usa JWT_SECRET do ambiente se existir;
   senão, gera e persiste um segredo local.
========================= */

let JWT_SECRET = process.env.JWT_SECRET || "";

if (!JWT_SECRET) {
    const f = path.join(DATA_DIR, ".jwt-secret");

    if (fs.existsSync(f)) {
        JWT_SECRET = fs.readFileSync(f, "utf8").trim();
    } else {
        JWT_SECRET = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(f, JWT_SECRET, "utf8");
    }
}

/* =========================
   LOG DO SITE
   Registra eventos em um arquivo JSONL
   (visíveis no painel do admin).
========================= */

function registrarLog(evento, detalhes = {}) {
    const linha = JSON.stringify({
        ts: new Date().toISOString(),
        evento,
        ...detalhes
    });

    try {
        fs.appendFileSync(LOGS_FILE, linha + "\n", "utf8");
    } catch (error) {
        console.error("ERRO ao gravar log:", error.message);
    }
}

/* =========================
   SEMEAR DADOS INICIAIS
   Em produção (Render), o DATA_DIR aponta para
   o disco persistente, que nasce vazio. Na primeira
   subida copiamos os dados iniciais do repositório.
   Em desenvolvimento (sem DATA_DIR), nada é copiado.
========================= */

function semearDadosIniciais() {

    const RESET_FILE = path.join(DATA_DIR, ".reset-feito");

    if (
        process.env.RESET_DATA === "true" &&
        !fs.existsSync(RESET_FILE)
    ) {

        const arquivosDados = [
            "spaces.json",
            "offers.json",
            "coupons.json",
            "pixkeys.json",
            "chat.json",
            "chat-negociacao.json"
        ];

        for (const nome of arquivosDados) {

            const caminho = path.join(DATA_DIR, nome);

            if (fs.existsSync(caminho)) {
                fs.unlinkSync(caminho);
            }
        }

        for (const nome of fs.readdirSync(UPLOAD_DIR)) {

            const caminho = path.join(UPLOAD_DIR, nome);

            if (fs.statSync(caminho).isFile()) {
                fs.unlinkSync(caminho);
            }
        }

        fs.writeFileSync(
            RESET_FILE,
            new Date().toISOString()
        );
    }

    if (DATA_DIR !== SEED_DIR) {

        const arquivos = [
            "spaces.json",
            "offers.json",
            "coupons.json",
            "pixkeys.json"
        ];

        for (const nome of arquivos) {

            const origem = path.join(SEED_DIR, nome);
            const destino = path.join(DATA_DIR, nome);

            if (
                fs.existsSync(origem) &&
                !fs.existsSync(destino)
            ) {
                fs.copyFileSync(origem, destino);
            }
        }
    }

    if (UPLOAD_DIR !== DEFAULT_UPLOAD_DIR) {

        const seedUploads =
            path.join(SEED_DIR, "seed-uploads");

        if (fs.existsSync(seedUploads)) {

            for (const nome of fs.readdirSync(seedUploads)) {

                const destino = path.join(UPLOAD_DIR, nome);

                if (!fs.existsSync(destino)) {
                    fs.copyFileSync(
                        path.join(seedUploads, nome),
                        destino
                    );
                }
            }
        }
    }
}

semearDadosIniciais();

/* =========================
   BANCO DE DADOS (PostgreSQL)
   Histórico de compras e vendas dos
   proprietários. Usa DATABASE_URL do
   Render. Sem o banco, o site continua
   funcionando (o histórico fica indisponível).
========================= */

let pgPool = null;
let pgDisponivel = false;

async function initBanco() {

    const url = process.env.DATABASE_URL;

    if (!url) {
        console.log(
            "DATABASE_URL não definido — " +
            "histórico de transações desativado."
        );
        return;
    }

    try {

        const ssl =
            /localhost|127\.0\.0\.1/.test(url)
            ? false
            : { rejectUnauthorized: false };

        pgPool = new Pool({
            connectionString: url,
            ssl
        });

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS transacoes (
                id               SERIAL PRIMARY KEY,
                tipo             VARCHAR(10) NOT NULL,
                access_code      VARCHAR(30) NOT NULL,
                token            VARCHAR(64),
                order_id         VARCHAR(60) NOT NULL,
                mp_order_id      VARCHAR(60),
                customer_id      VARCHAR(60),
                payment_id       VARCHAR(60),
                metodo_pagamento VARCHAR(20),
                usuario_id       INTEGER,
                nome             VARCHAR(200),
                email            VARCHAR(200),
                espacos          INTEGER[] NOT NULL,
                quantidade       INTEGER NOT NULL,
                valor_total      NUMERIC(12,2) NOT NULL,
                comissao         NUMERIC(12,2) NOT NULL DEFAULT 0,
                status           VARCHAR(20) NOT NULL DEFAULT 'pendente',
                test             BOOLEAN NOT NULL DEFAULT FALSE,
                criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                pago_em          TIMESTAMPTZ
            )
        `);

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id          SERIAL PRIMARY KEY,
                nome        VARCHAR(200) NOT NULL,
                email       VARCHAR(200) NOT NULL UNIQUE,
                senha_hash  VARCHAR(300) NOT NULL,
                criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ultimo_login TIMESTAMPTZ
            )
        `);

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS usuario_chaves (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL
                            REFERENCES usuarios(id)
                            ON DELETE CASCADE,
                tipo        VARCHAR(10) NOT NULL,
                valor       VARCHAR(64) NOT NULL,
                criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS usuario_id INTEGER"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS mp_order_id VARCHAR(60)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS metodo_pagamento VARCHAR(20)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS license_plan VARCHAR(20)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS license_duration_months INTEGER"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS license_fee NUMERIC(12,2)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS base_amount NUMERIC(12,2)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS original_license_plan VARCHAR(20)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS original_license_duration_months INTEGER"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS original_base_price_per_block NUMERIC(12,2)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS original_license_fee NUMERIC(12,2)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS operation_type VARCHAR(20)"
        );

        await pgPool.query(
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS aceite_regras BOOLEAN NOT NULL DEFAULT FALSE"
        );

        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS " +
            "idx_transacoes_token ON transacoes(token)"
        );

        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS " +
            "idx_transacoes_access ON transacoes(access_code)"
        );

        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS " +
            "idx_transacoes_usuario ON transacoes(usuario_id)"
        );

        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS " +
            "idx_uchaves_usuario ON usuario_chaves(usuario_id)"
        );

        await pgPool.query(
            "CREATE UNIQUE INDEX IF NOT EXISTS " +
            "idx_uchaves_valor ON usuario_chaves(tipo, valor)"
        );

        /* Módulo de colecionáveis: cria as tabelas sticker_*
           de forma segura (IF NOT EXISTS, sem DROP). */
        try {
            if (typeof colecionaveis?.migrar === "function") {
                await colecionaveis.migrar();
            }
        } catch (eMigracao) {
            console.error(
                "ERRO ao migrar tabelas de colecionáveis:",
                eMigracao.message
            );
        }

        /* Combos & Kits: tabelas `kits` e `kit_compras` são
           criadas pelo próprio módulo (combos.migrar()). */
        try {
            if (typeof combos?.migrar === "function") {
                await combos.migrar();
            }
        } catch (eMigracaoCombos) {
            console.error(
                "ERRO ao migrar tabelas de combos/kits:",
                eMigracaoCombos.message
            );
        }

        /* Bugs e sugestões enviados pelo site. */
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS bugs_sugestoes (
                    id            SERIAL PRIMARY KEY,
                    tipo          VARCHAR(20) NOT NULL,
                    assunto       VARCHAR(120) NOT NULL,
                    descricao     TEXT NOT NULL,
                    pagina        VARCHAR(120),
                    espaco        INTEGER,
                    email         VARCHAR(200),
                    usuario_id    INTEGER,
                    anexo_url     VARCHAR(400),
                    status        VARCHAR(30) NOT NULL DEFAULT 'novo',
                    observacao    TEXT,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);

            await pgPool.query(
                "CREATE INDEX IF NOT EXISTS idx_bugs_status " +
                "ON bugs_sugestoes(status)"
            );
        } catch (eBugs) {
            console.error(
                "ERRO ao migrar tabela de bugs/sugestões:",
                eBugs.message
            );
        }

        pgDisponivel = true;

        console.log(
            "PostgreSQL conectado — " +
            "tabela 'transacoes' pronta."
        );

    } catch (error) {

        pgDisponivel = false;
        pgPool = null;

        console.error(
            "Falha ao conectar PostgreSQL:",
            error.message
        );
    }
}

function registrarTransacao({
    tipo,
    accessCode,
    token,
    orderId,
    mpOrderId,
    customerId,
    paymentId,
    metodoPagamento,
    usuarioId,
    nome,
    email,
    espacos,
    valorTotal,
    comissao = 0,
    status,
    test = false,
    licensePlan,
    licenseDurationMonths,
    licenseFee,
    baseAmount,
    totalAmount,
    purchasedAt,
    expiresAt,
    originalLicensePlan,
    originalLicenseDurationMonths,
    originalBasePricePerBlock,
    originalLicenseFee,
    operationType,
    aceiteRegras = false
}) {

    if (!pgDisponivel) {
        return Promise.resolve(false);
    }

    return pgPool.query(
        `INSERT INTO transacoes
            (tipo, access_code, token, order_id, mp_order_id,
             customer_id, payment_id, metodo_pagamento, usuario_id, nome, email,
             espacos, quantidade, valor_total,
             comissao, status, test,
             license_plan, license_duration_months, license_fee,
             base_amount, total_amount,
             purchased_at, expires_at,
             original_license_plan, original_license_duration_months,
             original_base_price_per_block, original_license_fee,
             operation_type, aceite_regras)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
        [
            tipo,
            accessCode,
            token || null,
            orderId,
            mpOrderId || null,
            customerId || null,
            paymentId || null,
            metodoPagamento || null,
            usuarioId || null,
            nome || null,
            email || null,
            espacos,
            espacos.length,
            valorTotal,
            comissao,
            status,
            test,
            licensePlan || null,
            licenseDurationMonths || null,
            licenseFee || 0,
            baseAmount || valorTotal,
            totalAmount || valorTotal,
            purchasedAt || null,
            expiresAt || null,
            originalLicensePlan || null,
            originalLicenseDurationMonths || null,
            originalBasePricePerBlock || null,
            originalLicenseFee || null,
            operationType || "purchase",
            aceiteRegras === true || aceiteRegras === "true"
        ]
    ).catch((err) => {
        console.error("ERRO ao registrar transação:", err.message);
        return false;
    });
}

function pgPagamentoPago({ paymentId, mpOrderId } = {}) {

    if (!pgDisponivel) {
        return Promise.resolve(false);
    }

    const whereClause = paymentId
        ? "payment_id = $1"
        : "mp_order_id = $1";

    const param = paymentId || mpOrderId;

    if (!param) {
        return Promise.resolve(false);
    }

    return pgPool.query(
        `UPDATE transacoes
            SET status = 'pago',
                pago_em = NOW(),
                purchased_at = COALESCE(purchased_at, NOW()),
                expires_at = CASE
                    WHEN license_duration_months IS NOT NULL
                    THEN NOW() + (license_duration_months || ' months')::INTERVAL
                    ELSE NULL
                END
          WHERE ${whereClause}
            AND status = 'pendente'`,
        [param]
    ).catch((err) => {
        console.error("ERRO ao atualizar transação:", err.message);
        return false;
    });
}

async function usuarioPossuiOrder(usuarioId, orderId) {

    if (!orderId) {
        return false;
    }

    if (!pgDisponivel) {
        const db = readDB();
        return Object.values(db).some(s =>
            (s.mpOrderId === orderId || s.paymentId === orderId) &&
            s.usuarioId === usuarioId
        );
    }

    const result = await pgPool.query(
        `SELECT 1 FROM transacoes
          WHERE mp_order_id = $1
            AND usuario_id = $2
          LIMIT 1`,
        [orderId, usuarioId]
    ).catch((err) => {
        console.error("ERRO ao verificar propriedade do pedido:", err.message);
        return { rowCount: 0 };
    });

    return result.rowCount > 0;
}

/* initBanco() é chamado em background após o app.listen, no final. */

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.json({
    limit: "2mb"
}));

app.use("/api", limiterGlobal);
app.use("/api/checkout", limiterSensivel);
app.use("/api/restore", limiterSensivel);
app.use("/api/historico", limiterSensivel);
app.use("/api/auth", limiterSensivel);
app.use("/api/admin", limiterSensivel);
app.use("/api/extrato", limiterSensivel);
app.use("/api/test", limiterSensivel);
app.use("/api/offers", limiterOfertas);
app.use("/api/pix-key", limiterSensivel);
app.use("/api/upload", limiterUpload);
app.use("/api/chat", limiterChat);
app.use("/webhooks/mercadopago", limiterSensivel);

/* Limites específicos por rota (após o rate limit geral).
   Login/cadastro têm limite mais rígido contra força bruta;
   leituras da conta têm limite maior para uso legítimo. */
app.use("/api/auth/login", limiterLogin);
app.use("/api/auth/registrar", limiterLogin);
app.use("/api/auth/me", limiterLeitura);
app.use("/api/extrato", limiterLeitura);

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR, {
    dotfiles: "deny",
    index: false,
    setHeaders: (res) => {
        res.setHeader(
            "X-Content-Type-Options",
            "nosniff"
        );
    }
}));

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        const id =
            String(req.params.id || "")
                .replace(/\D/g, "");

        const segura = id
            ? `space-${id}`
            : `space-${Date.now()}`;

        const ext =
            (path.extname(file.originalname) || "")
                .toLowerCase()
                .replace(/[^a-z0-9.]/g, "");

        cb(null, `${segura}${ext}`);
    }
});

const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".gif"
]);

const IMAGE_MAGIC = [
    { magic: [0xFF, 0xD8, 0xFF], ext: ".jpg" },
    { magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], ext: ".png" },
    { magic: [0x52, 0x49, 0x46, 0x46], ext: ".webp" },
    { magic: [0x47, 0x49, 0x46, 0x38], ext: ".gif" }
];

function ehImagemValida(buf) {

    if (!buf || buf.length < 12) {
        return false;
    }

    return IMAGE_MAGIC.some(({ magic }) =>
        magic.every((b, i) => buf[i] === b)
    );
}

const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {

        const ext =
            path.extname(file.originalname)
                .toLowerCase();

        const mime =
            String(file.mimetype || "").toLowerCase();

        const mimeOk =
            mime.startsWith("image/");

        if (
            !IMAGE_EXTENSIONS.has(ext) ||
            !mimeOk
        ) {
            return cb(
                new Error(
                    "Formato de imagem inválido. " +
                    "Use JPG, PNG, WEBP ou GIF."
                )
            );
        }

        cb(null, true);
    }
});

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        return {};
    }

    try {
        return JSON.parse(
            fs.readFileSync(DB_FILE, "utf8")
        );
    } catch {
        return {};
    }
}

function writeDB(data) {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

function readJsonFile(file, fallback) {
    if (!fs.existsSync(file)) {
        return fallback;
    }

    try {
        return JSON.parse(
            fs.readFileSync(file, "utf8")
        );
    } catch {
        return fallback;
    }
}

function writeJsonFile(file, data) {
    fs.writeFileSync(
        file,
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

/* =========================
   RESERVAS COM VALIDADE
   Espaços "reserved" são liberados após
   RESERVA_TTL_MINUTOS sem pagamento.
========================= */

function readReservasLiberadas() {
    return readJsonFile(RESERVAS_LIBERADAS_FILE, {});
}

function writeReservasLiberadas(data) {
    writeJsonFile(RESERVAS_LIBERADAS_FILE, data);
}

function limparReservasExpiradas() {

    const db = readDB();
    const agora = Date.now();
    const liberadas = readReservasLiberadas();
    const expiradas = [];

    for (const [id, s] of Object.entries(db)) {

        if (
            s.status !== "reserved" ||
            !s.reservedAt
        ) {
            continue;
        }

        const limite =
            s.expiresAt
                ? new Date(s.expiresAt).getTime()
                : new Date(s.reservedAt).getTime() + RESERVA_TTL_MS;

        if (agora > limite) {

            if (s.paymentId) {
                liberadas[s.paymentId] = s;
            }

            delete db[id];
            expiradas.push(id);
        }
    }

    if (!expiradas.length) {
        return false;
    }

    const chaves = Object.keys(liberadas);

    if (chaves.length > 500) {
        const excedente = chaves.length - 500;
        for (const k of chaves.slice(0, excedente)) {
            delete liberadas[k];
        }
    }

    writeDB(db);
    writeReservasLiberadas(liberadas);

    registrarLog("reservas_expiraram", {
        qtd: expiradas.length,
        ttlMinutos: RESERVA_TTL_MINUTOS
    });

    console.log(
        `[RESERVA] ${expiradas.length} espaço(s) liberados ` +
        `após ${RESERVA_TTL_MINUTOS} min sem pagamento.`
    );

    return true;
}

/* Remove das reservas liberadas os blocos que foram
   comprados novamente (evita pagamento tardio pegar
   o espaço de um novo dono). */
function limparLiberadasOcupadas(ids) {

    const liberadas = readReservasLiberadas();
    const idsSet = new Set(ids);
    let alterado = false;

    for (const [paymentId, s] of Object.entries(liberadas)) {
        if (idsSet.has(s.id)) {
            delete liberadas[paymentId];
            alterado = true;
        }
    }

    if (alterado) {
        writeReservasLiberadas(liberadas);
    }
}

function readOffers() {
    return readJsonFile(OFFERS_FILE, {});
}

function writeOffers(data) {
    writeJsonFile(OFFERS_FILE, data);
}

function readCoupons() {
    return readJsonFile(COUPONS_FILE, {});
}

function writeCoupons(data) {
    writeJsonFile(COUPONS_FILE, data);
}

function readPixKeys() {
    return readJsonFile(PIXKEYS_FILE, {});
}

function writePixKeys(data) {
    writeJsonFile(PIXKEYS_FILE, data);
}

/* =========================
   SORTEIO SEMANAL
========================= */

function readSorteios() {
    return readJsonFile(SORTEIOS_FILE, {
        aviso: null,
        historico: []
    });
}

function writeSorteios(data) {
    writeJsonFile(SORTEIOS_FILE, data);
}

function blocosParticipantesSorteio() {
    const db = readDB();

    return Object.values(db).filter(b =>
        (b.status === "paid" ||
            b.status === "published") &&
        !b.test &&
        typeof b.email === "string" &&
        b.email.includes("@")
    );
}

function gerarToken() {
    return crypto.randomBytes(16).toString("hex");
}

function gerarAccessCode() {

    const h = crypto.randomBytes(8)
        .toString("hex")
        .toUpperCase();

    return `MEGA-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12)}`;
}

/* =========================
   CONTAS DE USUÁRIO
   Cadastro/login com e-mail e senha.
   Cada conta administra seus blocos,
   compras e extratos.
========================= */

function hashSenha(senha) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

function verificarSenha(senha, armazenada) {
    const [salt, hash] = String(armazenada || "").split(":");

    if (!salt || !hash) {
        return false;
    }

    try {
        const calculado = crypto.scryptSync(senha, salt, 64);
        const esperado = Buffer.from(hash, "hex");
        return (
            calculado.length === esperado.length &&
            crypto.timingSafeEqual(calculado, esperado)
        );
    } catch {
        return false;
    }
}

function gerarTokenJwt(payload) {
    return jwt.sign(
        { ...payload, jti: crypto.randomUUID() },
        JWT_SECRET,
        { expiresIn: "30d" }
    );
}

function extrairBearer(req) {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return null;
    }

    return auth.slice(7).trim();
}

function hashToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

async function tokenFoiRevogado(token) {
    if (!pgPool) return false;
    try {
        const payload = jwt.decode(token);
        const jti = payload && payload.jti;

        if (jti) {
            const r = await pgPool.query(
                "SELECT 1 FROM usuario_chaves WHERE tipo = $1 AND valor = $2 LIMIT 1",
                ["logout", jti]
            );
            if (r.rows.length > 0) return true;
        }

        const r2 = await pgPool.query(
            "SELECT 1 FROM usuario_chaves WHERE tipo = $1 AND valor = $2 LIMIT 1",
            ["logout", hashToken(token)]
        );
        return r2.rows.length > 0;
    } catch {
        return false;
    }
}

async function authUsuario(req, res, next) {
    const token = extrairBearer(req);

    if (!token) {
        return res.status(401).json({
            error: "Faça login para continuar."
        });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);

        if (!payload.usuarioId) {
            throw new Error("Token inválido.");
        }

        if (await tokenFoiRevogado(token)) {
            return res.status(401).json({
                error: "Sessão encerrada. Entre novamente."
            });
        }

        req.usuario = {
            id: payload.usuarioId,
            nome: payload.nome,
            email: payload.email
        };

        return next();
    } catch {
        return res.status(401).json({
            error: "Sessão inválida ou expirada. Entre novamente."
        });
    }
}

function authOpcional(req, res, next) {
    const token = extrairBearer(req);

    if (token) {
        try {
            const payload = jwt.verify(token, JWT_SECRET);

            if (payload.usuarioId) {
                req.usuario = {
                    id: payload.usuarioId,
                    nome: payload.nome,
                    email: payload.email
                };
            }
        } catch {
            /* ignora sessão inválida */
        }
    }

    return next();
}

function authAdmin(req, res, next) {
    const token = extrairBearer(req);

    if (!token) {
        return res.status(401).json({
            error: "Acesso restrito ao administrador."
        });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);

        const adminUser = process.env.ADMIN_USER || "";
        const adminPass = process.env.ADMIN_PASSWORD || "";

        if (
            payload.role !== "admin" ||
            !adminUser ||
            !adminPass ||
            payload.fp !==
                crypto.createHash("sha256")
                    .update(adminPass)
                    .digest("hex")
        ) {
            throw new Error("Credenciais de admin alteradas.");
        }

        req.admin = { usuario: adminUser };

        return next();
    } catch {
        return res.status(401).json({
            error: "Sessão de administrador inválida."
        });
    }
}

function usuarioSemSenha(u) {
    return {
        id: u.id,
        nome: u.nome,
        email: u.email,
        criadoEm: u.criado_em,
        ultimoLogin: u.ultimo_login
    };
}

async function criarUsuario(nome, email, senha) {
    const result = await pgPool.query(
        `INSERT INTO usuarios (nome, email, senha_hash)
         VALUES ($1, $2, $3)
         RETURNING id, nome, email, criado_em`,
        [nome, email.toLowerCase(), hashSenha(senha)]
    );

    return result.rows[0];
}

async function salvarChaveUsuario(usuarioId, tipo, valor) {
    return pgPool.query(
        `INSERT INTO usuario_chaves (usuario_id, tipo, valor)
         VALUES ($1, $2, $3)
         ON CONFLICT (tipo, valor) DO NOTHING`,
        [usuarioId, tipo, valor]
    ).catch((err) => {
        console.error("ERRO ao anexar chave:", err.message);
        return null;
    });
}

async function chavesDoUsuario(usuarioId) {
    const result = await pgPool.query(
        `SELECT tipo, valor FROM usuario_chaves
          WHERE usuario_id = $1`,
        [usuarioId]
    );

    return result.rows;
}

/* =========================
   TAXA DE SERVIÇO DO SITE
   10% sobre o valor negociado
   (somente nas negociações de oferta)
========================= */

const TAXA_SITE = 0.1;

function taxaDoSite(valor) {
    return Math.max(
        0.01,
        Math.round(valor * TAXA_SITE * 100) / 100
    );
}

/* =========================
   LINK DO SITE DO ANÚNCIO
   Normaliza e valida o link
   cadastrado pelo proprietário
   em cada espaço/bloco
========================= */

function normalizarLink(link) {

    const t = (link || "").trim();

    if (!t) {
        return null;
    }

    if (t.length > 300) {
        return null;
    }

    let url = t;

    if (!/^https?:\/\//i.test(url)) {
        url = "https://" + url;
    }

    try {

        const parsed = new URL(url);

        if (
            parsed.protocol !== "http:" &&
            parsed.protocol !== "https:"
        ) {
            return null;
        }

        const host = parsed.hostname || "";

        if (
            host !== "localhost" &&
            !host.includes(".")
        ) {
            return null;
        }

        return url;

    } catch {
        return null;
    }
}

/* =========================
   E-MAIL (RESEND)
========================= */

const RESEND_KEY =
    process.env.RESEND_API_KEY || "";

const EMAIL_FROM =
    process.env.EMAIL_FROM ||
    "MegaOutdoor <onboarding@resend.dev>";

/* Domínio público principal e alternativo.
   O principal (milhaodoor.com.br) é usado como preferência;
   o alternativo (Render) continua funcionando. */
const SITE_URL =
    process.env.SITE_URL ||
    "https://milhaodoor.com.br";

const DOMINIOS_PUBLICOS = [
    "milhaodoor.com.br",
    "www.milhaodoor.com.br",
    "megaoutdoor.onrender.com"
];

/* Retorna o domínio público da requisição (Host header),
   priorizando milhaodoor.com.br. Serve para gerar links
   absolutos (e-mail, webhook) sem hardcodar o domínio. */
function urlBase(req) {
    const host =
        (req && req.get && req.get("host")) || "";

    const ehConhecido =
        DOMINIOS_PUBLICOS.some(d =>
            host === d ||
            host.endsWith("." + d)
        );

    if (ehConhecido) {
        return "https://" + host;
    }

    return SITE_URL;
}

async function enviarEmail(to, subject, html) {

    if (!RESEND_KEY) {
        console.log(
            "[EMAIL] Sem RESEND_API_KEY configurada. " +
            `E-mail não enviado para ${to}: ${subject}`
        );
        return false;
    }

    try {

        const r = await fetch(
            "https://api.resend.com/emails",
            {
                method: "POST",
                headers: {
                    "Authorization":
                        `Bearer ${RESEND_KEY}`,
                    "Content-Type":
                        "application/json"
                },
                body: JSON.stringify({
                    from: EMAIL_FROM,
                    to,
                    subject,
                    html
                })
            }
        );

        if (!r.ok) {
            console.error(
                "[EMAIL] Resend retornou " +
                r.status + ":",
                (await r.text()).slice(0, 300)
            );
            return false;
        }

        return true;

    } catch (error) {

        console.error(
            "[EMAIL] Falha ao enviar:",
            error.message
        );

        return false;
    }
}

/* =========================
   E-MAIL UNIFICADO DE OFERTAS
   Agrupa ofertas de blocos do
   mesmo dono em um único e-mail
========================= */

const filaEmails = new Map();
const TEMPO_UNIFICAR_MS =
    Number(process.env.EMAIL_AGUARDO_MS) || 60000;

function agendarEmailUnificado(email, itemHtml) {

    const chave = email.trim().toLowerCase();

    if (!filaEmails.has(chave)) {

        filaEmails.set(chave, {
            items: [],
            timer: null
        });
    }

    const entrada = filaEmails.get(chave);

    entrada.items.push(itemHtml);

    if (entrada.timer) {
        clearTimeout(entrada.timer);
    }

    entrada.timer = setTimeout(
        () => flushEmailUnificado(chave),
        TEMPO_UNIFICAR_MS
    );
}

async function flushEmailUnificado(chave) {

    const entrada = filaEmails.get(chave);

    if (!entrada) return;

    filaEmails.delete(chave);

    if (entrada.timer) {
        clearTimeout(entrada.timer);
    }

    if (!entrada.items.length) return;

    const n = entrada.items.length;

    const corpo =
        entrada.items.map((item, i) =>
            `<div style="background:#f7f7f7;border-radius:8px;` +
            `padding:14px;margin-bottom:10px;font-size:14px;color:#333;">` +
            (n > 1
                ? `<div style="font-weight:700;color:#111;` +
                  `margin-bottom:6px;">Oferta ${i + 1} de ${n}</div>`
                : "") +
            item +
            `</div>`
        ).join("");

    await enviarEmail(
        chave,
        n > 1
            ? `Você recebeu ${n} novas ofertas`
            : `Você recebeu uma nova oferta`,
        htmlNotificacao(
            "💰 Novas ofertas de compra",
            corpo
        )
    );
}

function flushTodasEmails() {

    for (const chave of [...filaEmails.keys()]) {
        flushEmailUnificado(chave);
    }
}

process.on("SIGTERM", flushTodasEmails);
process.on("SIGINT", flushTodasEmails);

function htmlNotificacao(titulo, linhas) {

    return `
    <div style="font-family:Arial,sans-serif;max-width:520px;
                margin:0 auto;background:#fff;border-radius:12px;
                overflow:hidden;border:1px solid #eee;">
      <div style="background:#111;color:#ffd400;padding:20px;
                  font-size:20px;font-weight:800;">
        🏙️ Milhão Door
      </div>
      <div style="padding:24px;">
        <h2 style="margin:0 0 14px;color:#111;font-size:17px;">
          ${titulo}
        </h2>
        ${linhas}
        <p style="margin-top:22px;font-size:12px;color:#999;">
          Acesse <a href="${SITE_URL}" style="color:#ffd400;">
          ${SITE_URL}</a> para gerenciar.
        </p>
      </div>
    </div>`;
}

function gerarCupom(nome, email, orderId) {
    const codigo =
        "MEGA-" +
        crypto.randomBytes(4).toString("hex").toUpperCase();

    const cupons = readCoupons();

    cupons[codigo] = {
        codigo,
        tipo: "indicacao",
        ownerName: (nome || "").trim(),
        ownerEmail: (email || "").trim().toLowerCase(),
        ownerOrderId: orderId,
        discountPercent: 5,
        used: 0,
        credits: 0,
        maxUses: 100,
        active: true,
        createdAt: new Date().toISOString()
    };

    writeCoupons(cupons);

    return codigo;
}

function validarCupom(codigo) {
    if (!codigo) {
        return null;
    }

    const cupons = readCoupons();

    const cupom = cupons[codigo.trim().toUpperCase()];

    if (
        !cupom ||
        cupom.active === false ||
        cupom.used >= cupom.maxUses
    ) {
        return null;
    }

    return cupom;
}

function descontoProgressivo(quantidade) {
    if (quantidade >= 1000) {
        return 30;
    }
    if (quantidade >= 100) {
        return 20;
    }
    if (quantidade >= 10) {
        return 10;
    }
    return 0;
}

function validarCpf(cpf) {
    cpf = cpf.replace(/\D/g, "");

    if (cpf.length !== 11) {
        return false;
    }

    if (/^(\d)\1{10}$/.test(cpf)) {
        return false;
    }

    let soma = 0;

    for (let i = 0; i < 9; i++) {
        soma += Number(cpf[i]) * (10 - i);
    }

    let digito = (soma * 10) % 11 % 10;

    if (digito !== Number(cpf[9])) {
        return false;
    }

    soma = 0;

    for (let i = 0; i < 10; i++) {
        soma += Number(cpf[i]) * (11 - i);
    }

    digito = (soma * 10) % 11 % 10;

    return digito === Number(cpf[10]);
}

function validarCnpj(cnpj) {
    cnpj = cnpj.replace(/\D/g, "");

    if (cnpj.length !== 14) {
        return false;
    }

    if (/^(\d)\1{13}$/.test(cnpj)) {
        return false;
    }

    const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;

    for (let i = 0; i < 12; i++) {
        soma += Number(cnpj[i]) * pesos1[i];
    }

    let digito =
        soma % 11 < 2 ? 0 : 11 - (soma % 11);

    if (digito !== Number(cnpj[12])) {
        return false;
    }

    const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    soma = 0;

    for (let i = 0; i < 13; i++) {
        soma += Number(cnpj[i]) * pesos2[i];
    }

    digito =
        soma % 11 < 2 ? 0 : 11 - (soma % 11);

    return digito === Number(cnpj[13]);
}

function validarDocumento(doc) {
    const d = (doc || "").replace(/\D/g, "");
    return validarCpf(d) || validarCnpj(d);
}

function identificacaoMercadoPago(document) {

    const d = (document || "").replace(/\D/g, "");

    if (d.length === 11) {
        return { type: "CPF", number: d };
    }

    if (d.length === 14) {
        return { type: "CNPJ", number: d };
    }

    return null;
}

/* Normaliza os dados do comprador independentemente do nome dos campos
   usados em cada fluxo (spaces, kits, pacotes, trocas, mercado). */
function normalizarDadosComprador(body = {}) {
    const nome =
        body.name ||
        body.nome ||
        body.customerName ||
        "";
    const email =
        body.email ||
        body.customerEmail ||
        body.mail ||
        "";
    const cpfCnpj =
        body.cpfCnpj ||
        body.cpf_cnpj ||
        body.taxID ||
        body.taxId ||
        body.document ||
        body.documento ||
        "";
    return {
        nome: String(nome).trim(),
        email: String(email).trim().toLowerCase(),
        cpfCnpj: String(cpfCnpj).trim(),
        documento: String(cpfCnpj).replace(/\D/g, "")
    };
}

/* Converte erros técnicos do Mercado Pago (ou internos) em mensagens
   amigáveis para o usuário final, preservando o log técnico. */
function formatarErroPagamento(erro) {
    const msg = (erro && erro.message) || String(erro);
    const tecnicas = [
        { re: /properties? not supported/i, msg: "Não foi possível gerar o PIX agora. Tente novamente em alguns segundos." },
        { re: /X-Idempotency-Key/i, msg: "Erro de segurança na requisição. Tente novamente." },
        { re: /MERCADOPAGO_ACCESS_TOKEN/i, msg: "Pagamento temporariamente indisponível. Tente mais tarde." },
        { re: /token do cartão/i, msg: "Dados do cartão inválidos. Verifique e tente novamente." },
        { re: /NetworkError|fetch|ECONNREFUSED/i, msg: "Erro de conexão com a operadora de pagamento. Tente novamente." }
    ];
    const mapeada = tecnicas.find(t => t.re.test(msg));
    return mapeada ? mapeada.msg : msg;
}

/* Remove dados sensíveis (CPF/CNPJ, e-mail, tokens) de qualquer texto
   antes de gravar no log. Nunca logamos o corpo bruto da requisição. */
function mascararSensivel(texto) {
    return String(texto)
        .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "***.***.***-**")
        .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "**.***.***/****-**")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "***@***.***")
        .replace(/\b(APP_USR|TEST)-[A-Za-z0-9_-]+\b/g, "<TOKEN_MASCARADO>")
        .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "<JWT_MASCARADO>");
}

async function mercadoPagoRequest(endpoint, options = {}) {

    if (!MERCADOPAGO_ACCESS_TOKEN) {
        throw new Error("MERCADOPAGO_ACCESS_TOKEN não configurado.");
    }

    const response = await fetch(
        MERCADOPAGO_API + endpoint,
        {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
                ...(options.headers || {})
            }
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {

        const causa = Array.isArray(data.cause)
            ? data.cause
                .filter(c => c && (c.code || c.description))
                .map(c => ({
                    code: String(c.code || ""),
                    description: String(c.description || "")
                }))
            : [];

        const mensagem =
            (data.message && String(data.message)) ||
            (data.errors && data.errors.map(e => e.message).join(", ")) ||
            causa.map(c => c.description).filter(Boolean).join(", ") ||
            `Erro Mercado Pago HTTP ${response.status}`;

        const erro = new Error(mensagem);

        /* Preserva os dados estruturados do erro para quem chamar,
           sem expor o corpo bruto (que pode conter e-mail/CPF). */
        erro.status = response.status || 0;
        erro.code = String(data.error || (causa[0] && causa[0].code) || "");
        erro.cause = causa;
        erro.mpMessage = String(data.message || "");

        /* Log técnico seguro — sempre mascarado. */
        const detalheLog = {
            status: erro.status,
            code: erro.code,
            message: mascararSensivel(erro.mpMessage),
            cause: causa.map(c => ({
                code: c.code,
                description: mascararSensivel(c.description)
            }))
        };

        try {
            registrarLog("mercadopago_erro", { endpoint, ...detalheLog });
        } catch (eLog) {
            /* nunca deixa o log quebrar o fluxo */
        }

        console.error(
            "Mercado Pago erro:",
            endpoint,
            erro.status,
            JSON.stringify(detalheLog)
        );

        throw erro;
    }

    return data;
}

/* Busca o primeiro valor não vazio de um objeto seguindo caminhos
   "a.b.c" — aceita as estruturas atuais e as de formatos legados. */
function primeiroValorDe(objeto, caminhos) {
    for (const caminho of caminhos) {
        const valor = caminho
            .split(".")
            .reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), objeto);
        if (valor !== undefined && valor !== null && String(valor) !== "") {
            return String(valor);
        }
    }
    return "";
}

/* Extrai os dados de pagamento da resposta REAL da API Orders do
   Mercado Pago. A API atual devolve qr_code / qr_code_base64 /
   ticket_url diretamente dentro de transactions.payments[].payment_method.
   Mantemos fallbacks para formatos legados (transaction_data e
   point_of_interaction.transaction_data) para robustez. */
function extrairDadosPagamento(order) {

    const payment =
        order.transactions?.payments?.[0] ||
        order.payments?.[0] ||
        {};

    const method = payment.payment_method || {};

    const busca = caminhos => primeiroValorDe(method, caminhos);

    return {
        paymentId: String(payment.id || ""),
        status: payment.status || order.status || "",
        statusDetail: payment.status_detail || "",
        paymentMethodId: method.id || "",
        paymentMethodType: method.type || "",
        qrCodeBase64: busca([
            "qr_code_base64",
            "transaction_data.qr_code_base64",
            "point_of_interaction.transaction_data.qr_code_base64"
        ]),
        payload: busca([
            "qr_code",
            "transaction_data.qr_code",
            "point_of_interaction.transaction_data.qr_code"
        ]),
        ticketUrl: busca([
            "ticket_url",
            "transaction_data.ticket_url",
            "point_of_interaction.transaction_data.ticket_url"
        ]),
        installments: method.installments || 1
    };
}

async function criarOrderMercadoPago({
    idempotencyKey,
    externalReference,
    value,
    description,
    customer,
    paymentMethod,
    paymentMethodId,
    cardToken,
    installments = 1
}) {

    const id = externalReference || crypto.randomUUID();

    const finalIdempotencyKey =
        String(idempotencyKey || id || crypto.randomUUID()).trim();

    if (!finalIdempotencyKey) {
        throw new Error("X-Idempotency-Key inválido");
    }

    const taxID = customer && customer.taxID ? String(customer.taxID).trim() : "";
    const identificacao = identificacaoMercadoPago(taxID);

    const isPix = paymentMethod === "pix";

    const paymentBody = {
        amount: reaisParaMercadoPago(paraCentavos(value)),
        payment_method: {
            type: isPix ? "bank_transfer" : "credit_card"
        }
    };

    if (isPix) {
        paymentBody.payment_method.id = "pix";
    } else {
        paymentBody.payment_method.id = paymentMethodId || "credit_card";
    }

    if (!isPix && cardToken) {
        paymentBody.payment_method.token = cardToken;
        paymentBody.payment_method.installments = Number(installments) || 1;
    }

    /* O Orders API do Mercado Pago aceita apenas email e identification
       dentro do objeto payer. first_name/last_name geram
       "Properties not supported". */
    const payer = { email: customer && customer.email ? String(customer.email).trim() : "" };
    if (identificacao) {
        payer.identification = identificacao;
    }

    const body = {
        type: "online",
        processing_mode: "automatic",
        total_amount: reaisParaMercadoPago(paraCentavos(value)),
        external_reference: id,
        description: description || `Pedido ${id}`,
        payer,
        transactions: {
            payments: [paymentBody]
        }
    };

    /* O OrderRequest da API Orders NÃO aceita notification_url
       (gera o erro "unsupported_properties"). As notificações são
       configuradas no painel do Mercado Pago (Webhooks -> Order) e
       tratadas pelo endpoint /webhooks/mercadopago. */

    const order = await mercadoPagoRequest("/v1/orders", {
        method: "POST",
        headers: {
            "X-Idempotency-Key": finalIdempotencyKey
        },
        body: JSON.stringify(body)
    });

    const dados = extrairDadosPagamento(order);

    return {
        orderId: String(order.id),
        externalReference: id,
        status: order.status,
        paymentId: dados.paymentId,
        paymentStatus: dados.status,
        paymentMethodId: dados.paymentMethodId,
        paymentMethodType: dados.paymentMethodType,
        qrCodeBase64: dados.qrCodeBase64,
        payload: dados.payload,
        ticketUrl: dados.ticketUrl,
        installments: dados.installments,
        expirationDate: order.expiration_date || "",
        raw: order
    };
}

async function consultarOrderMercadoPago(orderId) {

    return mercadoPagoRequest(`/v1/orders/${encodeURIComponent(orderId)}`, {
        method: "GET"
    });
}

function statusOrderPago(status) {
    return status === "paid" || status === "approved";
}

/* Orders que NUNCA serão pagas: libera a reserva imediatamente
   (em vez de esperar o TTL) para o comprador poder tentar de novo. */
function statusOrderRejeitada(status) {
    return (
        status === "rejected" ||
        status === "declined" ||
        status === "cancelled" ||
        status === "expired"
    );
}

/* Libera na hora os espaços reservados de uma Order que foi
   rejeitada/cancelada/expirada, devolvendo-os ao mapa de venda.
   Se `externalReference` for informado (não vazio), exige que o
   orderId interno do espaço bata com ele — nunca libera um espaço
   de outra Order mesmo com assinatura HMAC válida. */
function liberarEspacosRejeitados(mpOrderId, status, externalReference) {
    const db = readDB();
    const liberados = [];

    for (const id of Object.keys(db)) {
        if (
            db[id].mpOrderId === mpOrderId &&
            db[id].status === "reserved" &&
            (!externalReference || db[id].orderId === externalReference)
        ) {
            delete db[id];
            liberados.push(id);
        }
    }

    if (!liberados.length) {
        return;
    }

    writeDB(db);

    registrarLog("pagamento_rejeitado_espacos_liberados", {
        mpOrderId,
        status,
        espacos: liberados
    });

    console.log(
        `[PAGAMENTO] Order ${mpOrderId} (${status}): ` +
        `${liberados.length} espaço(s) liberado(s) imediatamente.`
    );
}

/* Vínculo de ordem: espaços reservados de uma Order cujo
   external_reference retornado pelo Mercado Pago NÃO corresponde ao
   orderId interno gravado. Ordem alheia/forjada não pode liberar
   espaço de outra venda, mesmo com assinatura HMAC válida. */
function referenciasExternasDivergentes(orderId, externalReference, db) {
    const divergentes = [];
    for (const id of Object.keys(db)) {
        const space = db[id];
        if (
            space.mpOrderId === orderId &&
            space.status === "reserved" &&
            externalReference &&
            space.orderId !== externalReference
        ) {
            divergentes.push({
                espaco: id,
                interno: space.orderId,
                externo: externalReference
            });
        }
    }
    return divergentes;
}

function validarAssinaturaWebhook(req) {

    if (!MERCADOPAGO_WEBHOOK_SECRET) {
        console.warn("MERCADOPAGO_WEBHOOK_SECRET não configurado. Webhook não validado.");
        return false;
    }

    /* Implementação equivalente ao WebhookSignatureValidator oficial
       do Mercado Pago (sdk-nodejs/src/utils/webhook):
       - lê req.headers["x-signature"] e req.headers["x-request-id"];
       - para a API Orders, o id da Order chega no QUERY parameter
         data.id (ex.: POST /webhooks/mercadopago?data.id=...&type=order),
         NÃO no campo data.id do corpo da requisição;
       - manifesto assinado: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
         pares ausentes são omitidos;
       - compara o HMAC-SHA256 (hex) em tempo constante. */

    const normalizar = (valor) => {
        if (valor === undefined || valor === null) {
            return "";
        }
        const bruto = Array.isArray(valor) ? valor[0] : valor;
        if (bruto === undefined || bruto === null) {
            return "";
        }
        return String(bruto).trim();
    };

    const signatureHeader =
        normalizar(req.headers["x-signature"]) ||
        normalizar(req.headers["X-Signature"]);

    const requestId =
        normalizar(req.headers["x-request-id"]) ||
        normalizar(req.headers["X-Request-Id"]);

    if (!signatureHeader) {
        console.warn("Webhook Mercado Pago sem x-signature.");
        return false;
    }

    const query = req.query || {};
    const dataId =
        normalizar(query["data.id"]) ||
        normalizar(query.data?.id) ||
        normalizar(query["data_id"]) ||
        normalizar(query.id);

    const hashes = {};
    let ts = "";

    for (const part of signatureHeader.split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1) {
            continue;
        }
        const key = part.substring(0, eq).trim().toLowerCase();
        const value = part.substring(eq + 1).trim();
        if (!key || !value) {
            continue;
        }
        if (key === "ts") {
            ts = value;
        } else if (/^v\d+$/.test(key)) {
            hashes[key] = value;
        }
    }

    if (!ts || !/^\d+$/.test(ts)) {
        console.warn("Webhook Mercado Pago: x-signature malformado.");
        return false;
    }

    const v1 = hashes.v1;

    if (!v1) {
        console.warn("Webhook Mercado Pago: assinatura sem hash v1.");
        return false;
    }

    /* O Mercado Pago ENTREGA data.id em MAIÚSCULO (ex.: ORD01...) na query,
       mas ASSINA o manifesto com o data.id normalizado para MINÚSCULO.
       A normalização é aplicada SOMENTE ao data.id (nunca ao x-request-id,
       ao ts, ao segredo ou ao v1), conforme comprovado pelo diagnóstico. */
    const dataIdParaAssinatura = String(dataId || "").toLowerCase();

    const trechos = [];
    if (dataIdParaAssinatura) {
        trechos.push(`id:${dataIdParaAssinatura}`);
    }
    if (requestId) {
        trechos.push(`request-id:${requestId}`);
    }
    trechos.push(`ts:${ts}`);

    const manifest = trechos.join(";") + ";";

    const expected = crypto
        .createHmac("sha256", MERCADOPAGO_WEBHOOK_SECRET)
        .update(manifest)
        .digest("hex");

    if (
        Buffer.byteLength(expected) !== Buffer.byteLength(v1) ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
    ) {
        console.warn("Webhook Mercado Pago: assinatura inválida.");
        return false;
    }

    return true;
}

/* =========================
   ESPAÇOS
========================= */

/* =========================
   CONTAS — CADASTRO, LOGIN E MINHA CONTA
========================= */

const EMAIL_REGEX =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/auth/registrar", async (req, res) => {

    if (!pgDisponivel) {
        return res.status(503).json({
            error:
                "Cadastro indisponível no momento " +
                "(banco de dados não configurado)."
        });
    }

    const { nome, email, senha } = req.body;

    if (
        typeof nome !== "string" ||
        nome.trim().length < 2
    ) {
        return res.status(400).json({
            error: "Informe seu nome ou empresa (mínimo 2 letras)."
        });
    }

    if (
        typeof email !== "string" ||
        !EMAIL_REGEX.test(email.trim())
    ) {
        return res.status(400).json({
            error: "Informe um e-mail válido."
        });
    }

    if (
        typeof senha !== "string" ||
        senha.length < 6
    ) {
        return res.status(400).json({
            error: "A senha deve ter ao menos 6 caracteres."
        });
    }

    try {

        const existente = await pgPool.query(
            "SELECT id FROM usuarios WHERE email = $1",
            [email.trim().toLowerCase()]
        );

        if (existente.rowCount > 0) {
            return res.status(409).json({
                error: "Já existe uma conta com este e-mail."
            });
        }

        const usuario = await criarUsuario(
            nome.trim(),
            email.trim(),
            senha
        );

        registrarLog("usuario_cadastrado", {
            usuarioId: usuario.id,
            email: usuario.email
        });

        res.json({
            ok: true,
            token: gerarTokenJwt({
                usuarioId: usuario.id,
                nome: usuario.nome,
                email: usuario.email
            }),
            usuario: usuarioSemSenha(usuario)
        });

    } catch (error) {
        console.error("ERRO ao cadastrar usuário:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/auth/login", async (req, res) => {

    if (!pgDisponivel) {
        return res.status(503).json({
            error:
                "Login indisponível no momento " +
                "(banco de dados não configurado)."
        });
    }

    const { email, senha } = req.body;

    if (
        typeof email !== "string" ||
        !EMAIL_REGEX.test(email.trim())
    ) {
        return res.status(400).json({
            error: "Informe um e-mail válido."
        });
    }

    if (typeof senha !== "string" || !senha) {
        return res.status(400).json({
            error: "Informe sua senha."
        });
    }

    try {

        const result = await pgPool.query(
            `SELECT id, nome, email, senha_hash,
                    criado_em, ultimo_login
               FROM usuarios
              WHERE email = $1`,
            [email.trim().toLowerCase()]
        );

        const usuario = result.rows[0];

        if (
            !usuario ||
            !verificarSenha(senha, usuario.senha_hash)
        ) {
            return res.status(401).json({
                error: "E-mail ou senha incorretos."
            });
        }

        await pgPool.query(
            "UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1",
            [usuario.id]
        ).catch(() => {});

        registrarLog("usuario_login", {
            usuarioId: usuario.id,
            email: usuario.email
        });

        res.json({
            ok: true,
            token: gerarTokenJwt({
                usuarioId: usuario.id,
                nome: usuario.nome,
                email: usuario.email
            }),
            usuario: usuarioSemSenha(usuario)
        });

    } catch (error) {
        console.error("ERRO no login:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/auth/logout", authUsuario, async (req, res) => {

    try {

        const token = extrairBearer(req);

        if (token && pgPool) {
            const payload = jwt.decode(token);
            const chaveRevogacao = payload && payload.jti
                ? payload.jti
                : hashToken(token);

            await pgPool.query(
                `INSERT INTO usuario_chaves (usuario_id, tipo, valor)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (tipo, valor) DO NOTHING`,
                [req.usuario.id, "logout", chaveRevogacao]
            );
        }

        res.json({ ok: true });

    } catch (error) {
        console.error("ERRO no logout:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/auth/me", authUsuario, async (req, res) => {

    try {

        const result = await pgPool.query(
            `SELECT id, nome, email, criado_em, ultimo_login
               FROM usuarios WHERE id = $1`,
            [req.usuario.id]
        );

        const usuario = result.rows[0];

        if (!usuario) {
            return res.status(404).json({
                error: "Conta não encontrada."
            });
        }

        const chaves = await chavesDoUsuario(usuario.id);

        const tokens = new Set();
        const codigos = new Set();

        for (const c of chaves) {
            if (c.tipo === "token") {
                tokens.add(c.valor);
            } else {
                codigos.add(c.valor);
            }
        }

        const db = readDB();

        const meusEspacos = [];

        for (const s of Object.values(db)) {
            const meu =
                tokens.has(s.orderToken) ||
                codigos.has(s.accessCode);

            if (!meu) {
                continue;
            }

            meusEspacos.push({
                id: s.id,
                status: s.status,
                title: s.title || "",
                image: s.image || "",
                link: s.link || "",
                test: s.test === true,
                publishedAt: s.publishedAt || null
            });
        }

        const transacoes = await pgPool.query(
            "SELECT COUNT(*) AS total FROM transacoes " +
            "WHERE usuario_id = $1",
            [usuario.id]
        ).catch(() => null);

        res.json({
            ok: true,
            usuario: usuarioSemSenha(usuario),
            chaves: chaves.map(c => ({
                tipo: c.tipo,
                valor: c.valor
            })),
            espacos: meusEspacos,
            totalTransacoes:
                Number(transacoes?.rows?.[0]?.total || 0)
        });

    } catch (error) {
        console.error("ERRO ao carregar conta:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/auth/anexar", authUsuario, async (req, res) => {

    const { accessCode, token } = req.body;

    const valor = String(
        accessCode || token || ""
    ).trim();

    if (!valor) {
        return res.status(400).json({
            error: "Informe o código de acesso ou token do bloco."
        });
    }

    const codigo = valor.toUpperCase();
    const db = readDB();

    let achou = null;

    for (const s of Object.values(db)) {
        if (
            s.accessCode === codigo ||
            s.orderToken === valor
        ) {
            achou = s;
            break;
        }
    }

    if (!achou) {
        return res.status(404).json({
            error:
                "Nenhum bloco encontrado com esta identificação. " +
                "Confira o código de acesso (ex.: MEGA-XXXX-XXXX-XXXX-XXXX)."
        });
    }

    const ehToken =
        achou.orderToken === valor &&
        achou.accessCode !== codigo;

    const tipo = ehToken ? "token" : "access";

    await salvarChaveUsuario(
        req.usuario.id,
        tipo,
        tipo === "access" ? codigo : valor
    );

    if (!ehToken && achou.orderToken) {
        await salvarChaveUsuario(
            req.usuario.id,
            "token",
            achou.orderToken
        );
    }

    registrarLog("bloco_anexado", {
        usuarioId: req.usuario.id,
        espaco: achou.id,
        tipo
    });

    res.json({
        ok: true,
        espacos: [achou.id],
        mensagem: "Bloco anexado à sua conta com sucesso."
    });
});

app.post("/api/auth/senha", authUsuario, async (req, res) => {

    const { senhaAtual, novaSenha } = req.body;

    if (
        typeof novaSenha !== "string" ||
        novaSenha.length < 6
    ) {
        return res.status(400).json({
            error: "A nova senha deve ter ao menos 6 caracteres."
        });
    }

    try {

        const result = await pgPool.query(
            "SELECT senha_hash FROM usuarios WHERE id = $1",
            [req.usuario.id]
        );

        const atual = result.rows[0];

        if (
            !atual ||
            !verificarSenha(senhaAtual || "", atual.senha_hash)
        ) {
            return res.status(400).json({
                error: "Senha atual incorreta."
            });
        }

        await pgPool.query(
            "UPDATE usuarios SET senha_hash = $1 WHERE id = $2",
            [hashSenha(novaSenha), req.usuario.id]
        );

        registrarLog("senha_alterada", {
            usuarioId: req.usuario.id
        });

        res.json({ ok: true });

    } catch (error) {
        console.error("ERRO ao alterar senha:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/spaces", (req, res) => {

    limparReservasExpiradas();

    const db = readDB();

    const header =
        req.headers["x-owner-tokens"] || "";

    const meusTokens = new Set(
        header
            .split(",")
            .map(t => t.trim())
            .filter(Boolean)
    );

    const publico = {};

    for (const [id, s] of Object.entries(db)) {

        const pub = {
            id: s.id,
            status: s.status,
            image: s.image,
            title: s.title,
            link: s.link,
            displayMode: s.displayMode,
            imageGroupSpaces: s.imageGroupSpaces,
            test: s.test === true,
            publishedAt: s.publishedAt,
            paidAt: s.paidAt,
            transferredAt: s.transferredAt,
            licensePlan: s.licensePlan,
            licenseDurationMonths: s.licenseDurationMonths,
            licenseFee: s.licenseFee,
            baseAmount: s.baseAmount,
            totalAmount: s.totalAmount,
            purchasedAt: s.purchasedAt,
            expiresAt: s.expiresAt,
            operationType: s.operationType,
            usuarioId: s.usuarioId
        };

        if (
            s.orderToken &&
            meusTokens.has(s.orderToken)
        ) {
            pub.orderToken = s.orderToken;
        }

        publico[id] = pub;
    }

    res.json(publico);
});

app.get("/api/status", (req, res) => {

    limparReservasExpiradas();

    const db = readDB();

    let sold = 0;
    let reserved = 0;

    for (const space of Object.values(db)) {

        if (
            space.status === "published" ||
            space.status === "paid"
        ) {
            sold++;
        }

        if (space.status === "reserved") {
            reserved++;
        }
    }

    res.json({
        total: 1000000,
        sold,
        reserved,
        available: 1000000 - sold - reserved,
        revenue: sold
    });
});

/* =========================
   CONFIGURAÇÃO PÚBLICA
========================= */

app.get("/api/config", (req, res) => {

    res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    res.json({
        mercadoPagoPublicKey:
            MERCADOPAGO_PUBLIC_KEY || "",
        sandbox:
            MERCADOPAGO_SANDBOX === "true" ||
            MERCADOPAGO_SANDBOX === true,
        allowTestMode: ALLOW_TEST_MODE === true
    });
});

/* =========================
   CRIAR PEDIDO + PIX
========================= */

app.post("/api/checkout", authUsuario, async (req, res) => {

    try {

        if (!MERCADOPAGO_ACCESS_TOKEN) {
            return res.status(503).json({
                error:
                    "Pagamento temporariamente indisponível. " +
                    "MERCADOPAGO_ACCESS_TOKEN não configurado."
            });
        }

        const {
            spaces,
            name,
            email,
            cpfCnpj,
            coupon,
            paymentMethod,
            cardToken,
            installments,
            aceiteRegras
        } = req.body;

        /* Obrigatoriedade de aceite das regras da licença */
        if (aceiteRegras !== true && aceiteRegras !== "true") {
            return res.status(400).json({
                error:
                    "Você precisa ler e aceitar as regras da licença " +
                    "para continuar."
            });
        }

        const ids = [
            ...new Set(
                (spaces || []).map(Number)
            )
        ];

        if (!ids.length) {
            return res.status(400).json({
                error: "Nenhum espaço selecionado."
            });
        }

        if (ids.length > 1000) {
            return res.status(400).json({
                error: "Máximo de 1.000 espaços por compra."
            });
        }

        if (!name || name.trim().length < 3) {
            return res.status(400).json({
                error: "Informe o nome."
            });
        }

        if (!email || !email.includes("@")) {
            return res.status(400).json({
                error: "Informe um e-mail válido."
            });
        }

        if (!cpfCnpj) {
            return res.status(400).json({
                error: "Informe CPF ou CNPJ."
            });
        }

        const document = cpfCnpj.replace(/\D/g, "");

        if (!validarDocumento(document)) {
            return res.status(400).json({
                error: "CPF ou CNPJ inválido."
            });
        }

        const metodo =
            paymentMethod === "card" || paymentMethod === "credit_card"
            ? "credit_card"
            : "pix";

        if (metodo === "credit_card" && !cardToken) {
            return res.status(400).json({
                error: "Token do cartão não informado."
            });
        }

        /* =========================
           PLANO DE LICENÇA
        ========================= */

        const licensePlanKey =
            req.body.licensePlan || "1_year";

        if (!LICENSE_PLANS[licensePlanKey]) {
            return res.status(400).json({
                error: "Plano de licença inválido."
            });
        }

        /* Libera reservas expiradas antes de checar
           disponibilidade, para que o comprador possa
           reusar os próprios espaços da compra anterior. */

        limparReservasExpiradas();

        const db = readDB();

        /* Verifica se os espaços ainda estão livres */

        for (const id of ids) {

            if (
                !Number.isInteger(id) ||
                id < 1 ||
                id > 1000000
            ) {
                return res.status(400).json({
                    error: `Espaço inválido: ${id}`
                });
            }

            if (db[id]) {
                return res.status(409).json({
                    error:
                        `O espaço #${id.toLocaleString("pt-BR")} ` +
                        `já está ocupado ou reservado.`
                });
            }
        }

        const total = ids.length;

        /* =========================
           CUPOM DE INDICAÇÃO
        ========================= */

        const cupom = validarCupom(coupon);

        let desconto = null;
        let cupomCredito = null;

        if (coupon && !cupom) {
            return res.status(400).json({
                error: "Cupom de indicação inválido ou expirado."
            });
        }

        if (cupom && cupom.tipo === "indicacao") {
            if (
                cupom.ownerEmail &&
                cupom.ownerEmail === req.usuario.email
            ) {
                return res.status(400).json({
                    error:
                        "Você não pode usar o seu próprio cupom " +
                        "de indicação."
                });
            }

            if (total < 10) {
                return res.status(400).json({
                    error:
                        "Este cupom de indicação vale apenas para " +
                        "compras de 10 blocos ou mais " +
                        "(você selecionou " + total + ")."
                });
            }
        } else if (cupom && cupom.tipo !== "indicacao") {
            desconto = {
                value: cupom.discountPercent,
                dueDateLimitDays: 0,
                type: "PERCENTAGE"
            };
        }

        if (!desconto && req.usuario) {
            const meus = Object.values(readCoupons()).filter(
                c =>
                    c.tipo === "indicacao" &&
                    c.ownerEmail === req.usuario.email &&
                    (c.credits || 0) > 0
            );

            if (meus.length) {
                cupomCredito = meus[0];
                desconto = {
                    value: cupomCredito.discountPercent,
                    dueDateLimitDays: 0,
                    type: "PERCENTAGE"
                };
            }
        }

        const descontoProgressivoPct = descontoProgressivo(total);

        const descontoCupomPct =
            cupomCredito
                ? cupomCredito.discountPercent
                : (cupom && cupom.tipo !== "indicacao")
                    ? cupom.discountPercent
                    : 0;

        /* O cliente ganha o melhor desconto: progressivo ou cupom.
           O desconto é aplicado apenas sobre o valor base dos blocos;
           a taxa de licença é cobrada uma única vez por pedido. */
        const descontoPct =
            Math.max(descontoProgressivoPct, descontoCupomPct);

        const licenca = calcularLicenca(total, licensePlanKey);

        /* Regra do desconto: incide APENAS sobre o valor base dos blocos
           (produtos). A taxa única de licença é cobrada por pedido, sem
           desconto e sem duplicação. Tudo calculado em centavos. */
        const descontoCents =
            descontoEmCentavos(licenca.baseAmountCents, descontoPct);

        const baseComDescontoCents =
            licenca.baseAmountCents - descontoCents;

        const valorCobradoCents =
            baseComDescontoCents + licenca.feeCents;

        const valorCobrado =
            reaisDeCentavos(valorCobradoCents);

        /* =========================
           CRIA ORDER NO MERCADO PAGO
        ========================= */

        const orderId =
            `MEGA-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 7)}`;

        const orderToken =
            gerarToken();

        const accessCode =
            gerarAccessCode();

        const paymentId = crypto.randomUUID();

        const metodoPagamento = metodo;

        const reservedAt = new Date();

        let expiresAt =
            new Date(
                reservedAt.getTime() + RESERVA_TTL_MS
            );

        /* =========================
           RESERVA ANTES DE CRIAR A ORDER
           A checagem de disponibilidade acima e a gravação da reserva
           acontecem sem nenhum `await` entre elas, então dois pedidos
           concorrentes para o mesmo espaço não podem passar juntos
           (evita venda em dobro / cobrança duplicada). Se a criação
           da Order no Mercado Pago falhar, a reserva é desfeita
           (rollback) abaixo. O vencimento (menor prazo entre o TTL e
           o QR Code) é ajustado após a resposta do MP.
        ========================= */

        const valoresPedido = {
            chargedAmountCents: valorCobradoCents,
            chargedValue: valorCobrado
        };

        for (const id of ids) {

            db[id] = {
                id,
                status: "reserved",
                reservedAt:
                    reservedAt.toISOString(),
                expiresAt:
                    expiresAt.toISOString(),
                pixExpiresAt: undefined,
                orderId,
                mpOrderId: "",
                orderToken,
                accessCode,
                customerId: "",
                paymentId,
                paymentMethod: metodo,
                usuarioId: req.usuario.id,
                name: name.trim(),
                email: email.trim(),
                createdAt:
                    new Date().toISOString(),
                licensePlan: licenca.plan,
                licenseDurationMonths: licenca.months,
                licenseFee: licenca.fee,
                baseAmount: licenca.baseAmount,
                totalAmount: licenca.totalAmount,
                basePricePerBlock: licenca.basePricePerBlock,
                operationType: "purchase",
                originalLicensePlan: licenca.plan,
                originalLicenseDurationMonths: licenca.months,
                originalBasePricePerBlock: licenca.basePricePerBlock,
                originalLicenseFee: licenca.fee,
                ...valoresPedido
            };
        }

        writeDB(db);

        const rollbackReserva = () => {
            const dbAtual = readDB();
            let limpo = false;
            for (const id of ids) {
                if (
                    dbAtual[id] &&
                    dbAtual[id].orderId === orderId &&
                    dbAtual[id].status === "reserved" &&
                    !dbAtual[id].mpOrderId
                ) {
                    delete dbAtual[id];
                    limpo = true;
                }
            }
            if (limpo) {
                writeDB(dbAtual);
            }
        };

        let mp;

        try {

            mp = await criarOrderMercadoPago({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: valorCobrado,
                description: `Milhão Door - ${total} espaço(s)`,
                customer: {
                    name: name.trim(),
                    taxID: document,
                    email: email.trim()
                },
                paymentMethod: metodoPagamento,
                paymentMethodId: req.body.paymentMethodId,
                cardToken: metodo === "credit_card" ? cardToken : undefined,
                installments: metodo === "credit_card" ? installments : undefined
            });

        } catch (error) {

            rollbackReserva();
            throw error;
        }

        const qrCodeBase64 = mp.qrCodeBase64;
        const brCode = mp.payload;
        const expiresDate = mp.expirationDate;

        /* Ajusta o vencimento para o menor prazo entre o TTL
           e o vencimento do QR Code, e vincula a Order real. */

        if (expiresDate) {

            const pixExpiresAt =
                new Date(String(expiresDate).replace(" ", "T"));

            if (
                !isNaN(pixExpiresAt.getTime()) &&
                pixExpiresAt.getTime() < expiresAt.getTime()
            ) {
                expiresAt = pixExpiresAt;
            }
        }

        for (const id of ids) {
            if (db[id] && db[id].orderId === orderId) {
                db[id].mpOrderId = mp.orderId;
                db[id].paymentId = mp.paymentId || paymentId;
                db[id].expiresAt = expiresAt.toISOString();
                if (expiresDate) {
                    db[id].pixExpiresAt = String(expiresDate);
                }
            }
        }

        writeDB(db);

        limparLiberadasOcupadas(ids);

        registrarTransacao({
            tipo: "compra",
            accessCode,
            token: orderToken,
            orderId,
            mpOrderId: mp.orderId,
            customerId: "",
            paymentId: mp.paymentId || paymentId,
            metodoPagamento: metodo,
            usuarioId: req.usuario.id,
            nome: name.trim(),
            email: email.trim(),
            espacos: ids,
            valorTotal: valorCobrado,
            comissao: 0,
            status: metodo === "credit_card" && mp.paymentStatus === "approved" ? "pago" : "pendente",
            test: false,
            licensePlan: licenca.plan,
            licenseDurationMonths: licenca.months,
            licenseFee: licenca.fee,
            baseAmount: licenca.baseAmount,
            totalAmount: licenca.totalAmount,
            originalLicensePlan: licenca.plan,
            originalLicenseDurationMonths: licenca.months,
            originalBasePricePerBlock: licenca.basePricePerBlock,
            originalLicenseFee: licenca.fee,
            operationType: "purchase",
            aceiteRegras
        });

        await salvarChaveUsuario(
            req.usuario.id,
            "token",
            orderToken
        );

        await salvarChaveUsuario(
            req.usuario.id,
            "access",
            accessCode
        );

        registrarLog("pedido_criado", {
            usuarioId: req.usuario.id,
            orderId,
            espacos: ids.length,
            valor: valorCobrado
        });

        if (cupom && cupom.tipo === "indicacao") {
            const cupons = readCoupons();
            const c = cupons[cupom.codigo];
            if (c) {
                c.used = (c.used || 0) + 1;

                const totais = Object.values(cupons)
                    .filter(x =>
                        x.ownerEmail === cupom.ownerEmail
                    )
                    .reduce(
                        (s, x) => s + (x.credits || 0),
                        0
                    );

                if (totais < MAX_CREDITOS_INDICACAO) {
                    c.credits = (c.credits || 0) + 1;
                }

                writeCoupons(cupons);
            }
        }

        if (cupomCredito) {
            const cupons = readCoupons();
            const c = cupons[cupomCredito.codigo];
            if (c) {
                c.credits = Math.max(
                    0,
                    (c.credits || 1) - 1
                );
                writeCoupons(cupons);
            }
        }

        const meuCupom =
            gerarCupom(name, req.usuario.email, orderId);

        enviarEmail(
            email.trim(),
            "Seu código de acesso Milhão Door",
            htmlNotificacao(
                "🎟️ Guarde seu código de acesso",
                `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
                `Olá, <b>${name.trim()}</b>! Você reservou ` +
                `<b>${ids.length.toLocaleString("pt-BR")}</b> espaço(s) ` +
                `(pedido ${orderId}).</p>` +
                `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
                `Este código serve para <b>recuperar o acesso aos seus ` +
                `espaços</b> caso você troque de aparelho, limpe o ` +
                `navegador ou perca a sessão:</p>` +
                `<div style="background:#111;border:1px solid #ffd400;` +
                `border-radius:8px;padding:12px;text-align:center;` +
                `font-size:18px;font-weight:800;color:#ffd400;` +
                `letter-spacing:1px;margin:10px 0;">${accessCode}</div>` +
                `<p style="margin:0;color:#666;font-size:13px;">` +
                `O acesso também é liberado automaticamente no ` +
                `navegador após a confirmação do pagamento. ` +
                `Guarde este código em um lugar seguro.</p>`
            )
        );

        const pagoInstantaneo =
            metodo === "credit_card" &&
            statusOrderPago(mp.paymentStatus);

        if (pagoInstantaneo) {
            const paidAt = new Date();
            for (const id of ids) {
                if (db[id] && db[id].status === "reserved") {
                    db[id].status = "paid";
                    db[id].paidAt = paidAt.toISOString();
                    db[id].purchasedAt = paidAt.toISOString();
                    db[id].expiresAt =
                        adicionarMeses(
                            paidAt,
                            db[id].licenseDurationMonths || 12
                        ).toISOString();
                }
            }
            writeDB(db);
            confirmarPagamentoOferta(mp.orderId);
            pgPagamentoPago({ mpOrderId: mp.orderId });
            limparLiberadasOcupadas(ids);
        }

        res.json({
            ok: true,
            orderId,
            mpOrderId: mp.orderId,
            orderToken,
            accessCode: pagoInstantaneo ? accessCode : null,
            paymentId: mp.paymentId || paymentId,
            spaces: ids,
            total,
            subtotal: licenca.baseAmount,
            subtotalCents: licenca.baseAmountCents,
            discountPercent: descontoPct,
            discountCents: descontoCents,
            licenseFee: licenca.fee,
            licenseFeeCents: licenca.feeCents,
            value: valorCobrado,
            valueCents: valorCobradoCents,
            license: licenca,
            paymentMethod: metodo,
            paymentStatus: mp.paymentStatus,
            paid: pagoInstantaneo,
            creditoUsado: !!cupomCredito,
            indicacaoRegistrada:
                !!(cupom && cupom.tipo === "indicacao"),
            creditos: Object.values(readCoupons())
                .filter(c =>
                    c.tipo === "indicacao" &&
                    c.ownerEmail === req.usuario.email
                )
                .reduce(
                    (s, c) => s + (c.credits || 0),
                    0
                ),
            qrCode: qrCodeBase64 || "",
            payload: brCode,
            ticketUrl: mp.ticketUrl || "",
            meuCupom,
            expirationDate:
                expiresDate
        });

    } catch (error) {

        console.error("ERRO CHECKOUT:", mascararSensivel(error.message));

        res.status(500).json({
            error: formatarErroPagamento(error)
        });
    }
});

/* =========================
   RENOVAÇÃO DE LICENÇA
   O proprietário pode renovar seus espaços
   por 1, 3 ou 5 anos. A renovação só é
   efetivada após confirmação do pagamento.
========================= */

app.post("/api/renew", authUsuario, async (req, res) => {

    try {

        if (!MERCADOPAGO_ACCESS_TOKEN) {
            return res.status(503).json({
                error:
                    "Pagamento temporariamente indisponível. " +
                    "MERCADOPAGO_ACCESS_TOKEN não configurado."
            });
        }

        const {
            spaceId,
            licensePlan,
            name,
            email,
            cpfCnpj,
            paymentMethod,
            cardToken,
            installments
        } = req.body;

        const id = Number(spaceId);

        if (!Number.isInteger(id) || id < 1 || id > 1000000) {
            return res.status(400).json({
                error: "Espaço inválido."
            });
        }

        if (!LICENSE_PLANS[licensePlan]) {
            return res.status(400).json({
                error: "Plano de licença inválido."
            });
        }

        if (!name || name.trim().length < 3) {
            return res.status(400).json({
                error: "Informe o nome."
            });
        }

        if (!email || !email.includes("@")) {
            return res.status(400).json({
                error: "Informe um e-mail válido."
            });
        }

        if (!cpfCnpj) {
            return res.status(400).json({
                error: "Informe CPF ou CNPJ."
            });
        }

        const document = cpfCnpj.replace(/\D/g, "");

        if (!validarDocumento(document)) {
            return res.status(400).json({
                error: "CPF ou CNPJ inválido."
            });
        }

        const metodo =
            paymentMethod === "card" || paymentMethod === "credit_card"
            ? "credit_card"
            : "pix";

        if (metodo === "credit_card" && !cardToken) {
            return res.status(400).json({
                error: "Token do cartão não informado."
            });
        }

        const db = readDB();
        const space = db[id];

        if (!space) {
            return res.status(404).json({
                error: "Espaço não encontrado."
            });
        }

        /* Validação de propriedade: só permite renovar
           espaços que pertencem ao usuário autenticado. */
        const chaves = await chavesDoUsuario(req.usuario.id);
        const tokensDoUsuario = new Set(
            chaves
                .filter(c => c.tipo === "token")
                .map(c => c.valor)
        );

        const ehProprietario =
            space.usuarioId === req.usuario.id ||
            (space.orderToken && tokensDoUsuario.has(space.orderToken));

        if (!ehProprietario) {
            return res.status(403).json({
                error: "Você não é o proprietário deste espaço."
            });
        }

        const licenca = calcularLicenca(1, licensePlan);

        const orderId =
            `MEGA-RENEW-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 7)}`;

        const orderToken = gerarToken();
        const accessCode = gerarAccessCode();
        const paymentId = crypto.randomUUID();

        const mp = await criarOrderMercadoPago({
            idempotencyKey: orderId,
            externalReference: orderId,
            value: licenca.totalAmount,
            description: `Milhão Door - Renovação espaço #${id.toLocaleString("pt-BR")} (${licenca.label})`,
            customer: {
                name: name.trim(),
                taxID: document,
                email: email.trim()
            },
            paymentMethod: metodo,
            paymentMethodId: req.body.paymentMethodId,
            cardToken: metodo === "credit_card" ? cardToken : undefined,
            installments: metodo === "credit_card" ? installments : undefined
        });

        const qrCodeBase64 = mp.qrCodeBase64;
        const brCode = mp.payload;
        const expiresDate = mp.expirationDate;

        registrarTransacao({
            tipo: "renovacao",
            accessCode,
            token: orderToken,
            orderId,
            mpOrderId: mp.orderId,
            customerId: "",
            paymentId: mp.paymentId || paymentId,
            metodoPagamento: metodo,
            usuarioId: req.usuario.id,
            nome: name.trim(),
            email: email.trim(),
            espacos: [id],
            valorTotal: licenca.totalAmount,
            comissao: 0,
            status: metodo === "credit_card" && mp.paymentStatus === "approved" ? "pago" : "pendente",
            test: false,
            licensePlan: licenca.plan,
            licenseDurationMonths: licenca.months,
            licenseFee: licenca.fee,
            baseAmount: licenca.baseAmount,
            totalAmount: licenca.totalAmount,
            originalLicensePlan: space.licensePlan,
            originalLicenseDurationMonths: space.licenseDurationMonths,
            originalBasePricePerBlock: space.basePricePerBlock,
            originalLicenseFee: space.licenseFee,
            operationType: "renewal"
        });

        await salvarChaveUsuario(req.usuario.id, "token", orderToken);
        await salvarChaveUsuario(req.usuario.id, "access", accessCode);

        registrarLog("renovacao_criada", {
            usuarioId: req.usuario.id,
            orderId,
            spaceId: id,
            valor: licenca.totalAmount
        });

        const pagoInstantaneo =
            metodo === "credit_card" &&
            statusOrderPago(mp.paymentStatus);

        if (pagoInstantaneo) {
            const paidAt = new Date();
            const mesesAnteriores =
                space.licenseDurationMonths || 12;
            const dataBase =
                space.expiresAt && new Date(space.expiresAt) > paidAt
                    ? new Date(space.expiresAt)
                    : paidAt;

            db[id].licensePlan = licenca.plan;
            db[id].licenseDurationMonths = licenca.months;
            db[id].licenseFee = licenca.fee;
            db[id].baseAmount = licenca.baseAmount;
            db[id].totalAmount = licenca.totalAmount;
            db[id].basePricePerBlock = licenca.basePricePerBlock;
            db[id].operationType = "renewal";
            db[id].purchasedAt = paidAt.toISOString();
            db[id].expiresAt =
                adicionarMeses(dataBase, licenca.months).toISOString();
            db[id].paidAt = paidAt.toISOString();
            db[id].renewalOrderId = orderId;
            db[id].renewalMpOrderId = mp.orderId;

            writeDB(db);
            pgPagamentoPago({ mpOrderId: mp.orderId });
        }

        res.json({
            ok: true,
            orderId,
            mpOrderId: mp.orderId,
            orderToken,
            accessCode,
            paymentId: mp.paymentId || paymentId,
            spaceId: id,
            value: licenca.totalAmount,
            license: licenca,
            paymentMethod: metodo,
            paymentStatus: mp.paymentStatus,
            paid: pagoInstantaneo,
            qrCode: qrCodeBase64 || "",
            payload: brCode,
            ticketUrl: mp.ticketUrl || "",
            expirationDate: expiresDate
        });

    } catch (error) {

        console.error("ERRO RENOVAÇÃO:", mascararSensivel(error.message));

        res.status(500).json({
            error: formatarErroPagamento(error)
        });
    }
});

/* =========================
   MODO TESTE - RESERVAR ESPAÇOS
   USADO PELO BOTÃO "TESTAR SEM PAGAMENTO"
========================= */

app.post("/api/test/reserve", authUsuario, async (req, res) => {

    if (PRODUCAO && !ALLOW_TEST_MODE) {
        return res.status(403).json({
            error:
                "Modo de teste está desativado nesta " +
                "versão do site."
        });
    }

    try {

        const name = (req.body?.name || "").trim();
        const email = (req.body?.email || "").trim();
        const coupon = (req.body?.coupon || "").trim();
        const spaces = [
            ...new Set(
                (req.body?.spaces || []).map(Number)
            )
        ];

        if (!spaces.length) {
            return res.status(400).json({
                error: "Nenhum espaço selecionado."
            });
        }

        if (spaces.length > 1000) {
            return res.status(400).json({
                error: "Máximo de 1.000 espaços por compra."
            });
        }

        const cupom = validarCupom(coupon);

        let cupomCredito = null;

        if (coupon && !cupom) {
            return res.status(400).json({
                error: "Cupom de indicação inválido ou expirado."
            });
        }

        if (cupom && cupom.tipo === "indicacao") {
            if (
                cupom.ownerEmail &&
                cupom.ownerEmail === req.usuario.email
            ) {
                return res.status(400).json({
                    error:
                        "Você não pode usar o seu próprio cupom " +
                        "de indicação."
                });
            }

            if (spaces.length < 10) {
                return res.status(400).json({
                    error:
                        "Este cupom de indicação vale apenas para " +
                        "compras de 10 blocos ou mais " +
                        "(você selecionou " + spaces.length + ")."
                });
            }
        }

        if (!cupom && req.usuario) {
            const meus = Object.values(readCoupons()).filter(
                c =>
                    c.tipo === "indicacao" &&
                    c.ownerEmail === req.usuario.email &&
                    (c.credits || 0) > 0
            );

            if (meus.length) {
                cupomCredito = meus[0];
            }
        }

        const db = readDB();

        for (const id of spaces) {

            if (
                !Number.isInteger(id) ||
                id < 1 ||
                id > 1000000
            ) {
                return res.status(400).json({
                    error: `Espaço inválido: ${id}`
                });
            }

            if (db[id]) {
                return res.status(409).json({
                    error:
                        `O espaço #${id.toLocaleString("pt-BR")} ` +
                        `já está ocupado ou reservado.`
                });
            }
        }

        const now =
            new Date().toISOString();

        const orderId =
            `TESTE-${Date.now()}`;

        const orderToken =
            gerarToken();

        const accessCode =
            gerarAccessCode();

        const licencaTeste = calcularLicenca(spaces.length, "1_year");
        const paidAt = new Date();

        for (const id of spaces) {

            db[id] = {
                id,
                status: "paid",
                test: true,
                orderId,
                orderToken,
                accessCode,
                name: name || "Anunciante",
                email: email || "",
                createdAt: now,
                licensePlan: licencaTeste.plan,
                licenseDurationMonths: licencaTeste.months,
                licenseFee: licencaTeste.fee,
                baseAmount: licencaTeste.baseAmount,
                totalAmount: licencaTeste.totalAmount,
                basePricePerBlock: licencaTeste.basePricePerBlock,
                operationType: "purchase",
                purchasedAt: paidAt.toISOString(),
                expiresAt:
                    adicionarMeses(paidAt, licencaTeste.months)
                        .toISOString()
            };
        }

        writeDB(db);

        const descontoPct =
            cupomCredito
                ? cupomCredito.discountPercent
                : (cupom && cupom.tipo !== "indicacao")
                    ? cupom.discountPercent
                    : 0;

        const valorTotal =
            Math.round(
                spaces.length *
                (1 - descontoPct / 100) * 100
            ) / 100;

        registrarTransacao({
            tipo: "compra",
            accessCode,
            token: orderToken,
            orderId,
            usuarioId: req.usuario.id,
            nome: name || "Anunciante",
            email: email || "",
            espacos: spaces,
            valorTotal,
            comissao: 0,
            status: "pago",
            test: true,
            licensePlan: licencaTeste.plan,
            licenseDurationMonths: licencaTeste.months,
            licenseFee: licencaTeste.fee,
            baseAmount: licencaTeste.baseAmount,
            totalAmount: licencaTeste.totalAmount,
            purchasedAt: paidAt.toISOString(),
            expiresAt:
                adicionarMeses(paidAt, licencaTeste.months)
                    .toISOString(),
            originalLicensePlan: licencaTeste.plan,
            originalLicenseDurationMonths: licencaTeste.months,
            originalBasePricePerBlock: licencaTeste.basePricePerBlock,
            originalLicenseFee: licencaTeste.fee,
            operationType: "purchase"
        });

        await salvarChaveUsuario(
            req.usuario.id,
            "token",
            orderToken
        );

        await salvarChaveUsuario(
            req.usuario.id,
            "access",
            accessCode
        );

        registrarLog("pedido_teste_criado", {
            usuarioId: req.usuario.id,
            orderId,
            espacos: spaces.length
        });

        const meuCupom =
            gerarCupom(name, req.usuario.email, orderId);

        if (cupom && cupom.tipo === "indicacao") {
            const cupons = readCoupons();
            const c = cupons[cupom.codigo];
            if (c) {
                c.used = (c.used || 0) + 1;

                const totais = Object.values(cupons)
                    .filter(x =>
                        x.ownerEmail === cupom.ownerEmail
                    )
                    .reduce(
                        (s, x) => s + (x.credits || 0),
                        0
                    );

                if (totais < MAX_CREDITOS_INDICACAO) {
                    c.credits = (c.credits || 0) + 1;
                }

                writeCoupons(cupons);
            }
        }

        if (cupomCredito) {
            const cupons = readCoupons();
            const c = cupons[cupomCredito.codigo];
            if (c) {
                c.credits = Math.max(
                    0,
                    (c.credits || 1) - 1
                );
                writeCoupons(cupons);
            }
        }

        res.json({
            ok: true,
            spaces,
            test: true,
            orderToken,
            accessCode,
            meuCupom,
            discountPercent:
                cupomCredito
                    ? cupomCredito.discountPercent
                    : (cupom && cupom.tipo !== "indicacao")
                        ? cupom.discountPercent
                        : 0,
            creditoUsado: !!cupomCredito,
            indicacaoRegistrada:
                !!(cupom && cupom.tipo === "indicacao"),
            creditos: Object.values(readCoupons())
                .filter(c =>
                    c.tipo === "indicacao" &&
                    c.ownerEmail === req.usuario.email
                )
                .reduce(
                    (s, c) => s + (c.credits || 0),
                    0
                )
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* =========================
   MODO TESTE - CONFIRMAR OFERTA
   Simula o pagamento da oferta para
   testes de homologação do histórico.
   Desativado em produção.
========================= */

app.post("/api/test/confirm-offer", (req, res) => {

    if (PRODUCAO && !ALLOW_TEST_MODE) {
        return res.status(403).json({
            error:
                "Modo de teste está desativado nesta " +
                "versão do site."
        });
    }

    try {

        const offerId =
            (req.body?.offerId || "").trim();

        if (!offerId) {
            return res.status(400).json({
                error: "Informe o offerId."
            });
        }

        const ofertas = readOffers();

        const oferta = ofertas[offerId];

        if (!oferta) {
            return res.status(404).json({
                error: "Oferta não encontrada."
            });
        }

        if (oferta.status !== "pending") {
            return res.status(400).json({
                error:
                    "Oferta não está pendente " +
                    "para confirmação."
            });
        }

        oferta.status = "accepted";
        oferta.paymentId =
            `TESTE-PAY-${Date.now()}`;
        oferta.feeValue =
            taxaDoSite(oferta.value);
        oferta.acceptedAt =
            new Date().toISOString();

        writeOffers(ofertas);

        const confirmado =
            confirmarPagamentoOferta(oferta.paymentId);

        const atualizada =
            readOffers()[offerId] || {};

        res.json({
            ok: confirmado === true,
            offerId,
            newOwnerToken:
                atualizada.newOwnerToken || null,
            newOwnerAccessCode:
                atualizada.newOwnerAccessCode || null
        });

    } catch (error) {

        console.error(
            "ERRO confirmar oferta teste:",
            error.message
        );

        res.status(500).json({
            error: error.message
        });
    }
});

/* =========================
   CONSULTAR PAGAMENTO
========================= */

app.get(
    "/api/payment-status/:orderId",
    authUsuario,
    async (req, res) => {

        try {

            const orderId = req.params.orderId;

            const podeConsultar =
                await usuarioPossuiOrder(req.usuario.id, orderId);

            if (!podeConsultar) {
                return res.status(403).json({
                    error: "Acesso negado a este pedido."
                });
            }

            const order =
                await consultarOrderMercadoPago(orderId);

            const db = readDB();
            const chargeStatus = order.status || "unknown";
            const pago = statusOrderPago(chargeStatus);

            /* external_reference: vínculo definitivo entre o pagamento
               consultado no MP e o orderId interno (nunca só o id do webhook). */
            const externalReference =
                String(order.external_reference || "").trim();

            /* Rejeitado/cancelado/expirado: libera a reserva na hora
               para o comprador poder tentar novamente. */
            if (statusOrderRejeitada(chargeStatus)) {
                liberarEspacosRejeitados(
                    orderId,
                    chargeStatus,
                    externalReference
                );
            }

            let accessCode = null;

            if (pago) {

                const totalPagoCents = paraCentavos(order.total_amount);

                /* Validação de valor: não marca como pago (RECEIVED)
                   se o valor pago no MP não bater com o cobrado. */
                let divergencia = false;

                for (const id of Object.keys(db)) {
                    const space = db[id];
                    if (
                        space.chargedAmountCents != null &&
                        space.chargedAmountCents !== totalPagoCents &&
                        (
                            space.mpOrderId === orderId ||
                            space.paymentId === orderId
                        )
                    ) {
                        divergencia = true;
                        console.error(
                            "[MP] VALOR DIVERGENTE (polling). Espaço NÃO marcado como pago.",
                            { mpOrderId: orderId, espaco: id, cobradoCents: space.chargedAmountCents, pagoCents: totalPagoCents }
                        );
                    }
                }

                if (divergencia) {
                    registrarLog("pagamento_valor_divergente_polling", {
                        mpOrderId: orderId,
                        totalPagoCents
                    });
                    /* NÃO reporta RECEIVED: evitaria o frontend mostrar
                       "Pagamento confirmado" com espaços ainda reservados.
                       Mantém o polling ativo até revisão manual. */
                    return res.json({
                        status: chargeStatus,
                        orderId,
                        accessCode: null,
                        divergencia: true
                    });
                }

                /* Vínculo de ordem: external_reference do MP deve bater
                   com o orderId interno dos espaços reservados. */
                const refsDivergentes = referenciasExternasDivergentes(
                    orderId,
                    externalReference,
                    db
                );

                if (refsDivergentes.length) {
                    console.error(
                        "[MP] external_reference DIVERGENTE (polling). " +
                        "Espaços NÃO marcados como pago.",
                        { mpOrderId: orderId, externalReference, refsDivergentes }
                    );
                    registrarLog("pagamento_external_reference_divergente_polling", {
                        mpOrderId: orderId,
                        externalReference,
                        refsDivergentes
                    });
                    return res.json({
                        status: chargeStatus,
                        orderId,
                        accessCode: null,
                        externalReferenceDivergencia: true
                    });
                }

                confirmarPagamentoOferta(orderId);

                pgPagamentoPago({ mpOrderId: orderId });

                /* Módulo de colecionáveis: processa pacotes,
                   compras no mercado e diferenças de troca. */
                try {
                    if (typeof colecionaveis?.processarPagamento === "function") {
                        await colecionaveis.processarPagamento({ mpOrderId: orderId, totalCents: totalPagoCents });
                    }
                } catch (eColecionaveis) {
                    console.error(
                        "ERRO ao processar pagamento de colecionáveis (polling):",
                        eColecionaveis.message
                    );
                }

                /* Módulo de Combos & Kits (idempotente). */
                try {
                    if (typeof combos?.processarPagamento === "function") {
                        await combos.processarPagamento({ mpOrderId: orderId, totalCents: totalPagoCents });
                    }
                } catch (eCombos) {
                    console.error(
                        "ERRO ao processar pagamento de combos/kits (polling):",
                        eCombos.message
                    );
                }

                registrarLog("pagamento_confirmado", {
                    mpOrderId: orderId,
                    status: chargeStatus
                });

                const paidAt = new Date();

                for (const id of Object.keys(db)) {

                    if (
                        (
                            db[id].mpOrderId === orderId ||
                            db[id].paymentId === orderId
                        ) &&
                        (!externalReference ||
                            db[id].orderId === externalReference)
                    ) {

                        if (db[id].accessCode) {
                            accessCode = db[id].accessCode;
                        }

                        if (
                            db[id].status ===
                            "reserved"
                        ) {

                            const months =
                                db[id].licenseDurationMonths || 12;

                            db[id].status = "paid";
                            db[id].paidAt = paidAt.toISOString();
                            db[id].purchasedAt = paidAt.toISOString();
                            db[id].expiresAt =
                                adicionarMeses(paidAt, months)
                                    .toISOString();
                        }
                    }
                }

                writeDB(db);
            }

            res.json({
                status: pago ? "RECEIVED" : chargeStatus,
                orderId: orderId,
                accessCode: pago ? accessCode : null
            });

        } catch (error) {

            if (error && error.status === 404) {
                return res.status(404).json({
                    error: "Pedido não encontrado no Mercado Pago."
                });
            }

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* =========================
   RECUPERAR ACESSO
   Quem comprou espaços recebe um
   código de acesso (por e-mail e na
   tela). Com ele, recupera os tokens
   de propriedade em qualquer aparelho.
========================= */

app.post("/api/restore", (req, res) => {

    try {

        const code =
            (req.body.accessCode || "")
                .trim()
                .toUpperCase();

        if (!code) {
            return res.status(400).json({
                error: "Informe seu código de acesso."
            });
        }

        if (!/^MEGA-[A-F0-9-]{16,}$/.test(code)) {
            return res.status(400).json({
                error: "Código de acesso inválido."
            });
        }

        const db = readDB();

        const encontrados = [];

        for (const id of Object.keys(db)) {

            const s = db[id];

            if (!s.accessCode) continue;

            if (s.accessCode.toUpperCase() !== code) {
                continue;
            }

            encontrados.push({
                id: s.id,
                orderToken: s.orderToken || "",
                name: s.name,
                email: s.email,
                status: s.status,
                image: s.image,
                title: s.title,
                link: s.link
            });
        }

        if (!encontrados.length) {
            return res.status(404).json({
                error:
                    "Código de acesso não encontrado. " +
                    "Confira se digitou corretamente."
            });
        }

        res.json({
            ok: true,
            spaces: encontrados,
            total: encontrados.length
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* =========================
   HISTÓRICO DE TRANSAÇÕES
   Compras e vendas do proprietário,
   consultadas pelo token de dono
   (header x-owner-tokens) ou código
   de acesso (query accessCode).
========================= */

async function resolverCredenciais(req) {

    const tokens = new Set(
        (req.headers["x-owner-tokens"] || "")
            .split(",")
            .map(t => t.trim())
            .filter(Boolean)
    );

    const codigos = new Set(
        (req.headers["x-owner-access-code"] || "")
            .split(",")
            .map(t => t.trim().toUpperCase())
            .filter(Boolean)
    );

    if (req.usuario && pgDisponivel) {

        const chaves = await chavesDoUsuario(req.usuario.id);

        for (const c of chaves) {
            if (c.tipo === "token") {
                tokens.add(c.valor);
            } else {
                codigos.add(c.valor);
            }
        }
    }

    const db = readDB();

    for (const s of Object.values(db)) {
        if (
            tokens.has(s.orderToken) &&
            s.accessCode
        ) {
            codigos.add(s.accessCode);
        }
    }

    return {
        tokens: [...tokens],
        codigos: [...codigos]
    };
}

async function buscarTransacoes(tokens, codigos) {

    const conds = [];
    const params = [];

    for (const t of tokens) {
        conds.push("token = $" + (params.length + 1));
        params.push(t);
    }

    for (const c of codigos) {
        conds.push("access_code = $" + (params.length + 1));
        params.push(c);
    }

    if (!conds.length) {
        return [];
    }

    const result = await pgPool.query(
        `SELECT id, tipo, access_code, order_id,
                nome, email, espacos, quantidade,
                valor_total, comissao, status,
                test, criado_em, pago_em
           FROM transacoes
          WHERE ${conds.join(" OR ")}
          ORDER BY criado_em DESC`,
        params
    );

    return result.rows.map(r => ({
        id: r.id,
        tipo: r.tipo,
        accessCode: r.access_code,
        orderId: r.order_id,
        nome: r.nome,
        email: r.email,
        espacos: r.espacos,
        quantidade: r.quantidade,
        valorTotal: Number(r.valor_total),
        comissao: Number(r.comissao),
        status: r.status,
        test: r.test,
        criadoEm: r.criado_em,
        pagoEm: r.pago_em
    }));
}

function resumirTransacoes(transacoes) {

    let gastoTotal = 0;
    let recebidoTotal = 0;
    let comprados = 0;
    let vendidos = 0;

    for (const t of transacoes) {

        if (t.status !== "pago") continue;

        if (t.tipo === "compra") {
            gastoTotal += t.valorTotal;
            comprados += t.quantidade;
        } else {
            recebidoTotal += t.valorTotal - t.comissao;
            vendidos += t.quantidade;
        }
    }

    return {
        gastoTotal: Math.round(gastoTotal * 100) / 100,
        recebidoTotal: Math.round(recebidoTotal * 100) / 100,
        comprados,
        vendidos
    };
}

app.get("/api/historico", authOpcional, async (req, res) => {

    if (!pgDisponivel) {
        return res.status(503).json({
            error:
                "Banco de dados ainda não configurado. " +
                "Defina DATABASE_URL para ativar o histórico."
        });
    }

    try {

        const { tokens, codigos } =
            await resolverCredenciais(req);

        if (!tokens.length && !codigos.length) {

            if (req.usuario) {
                return res.json({
                    ok: true,
                    total: 0,
                    gastoTotal: 0,
                    recebidoTotal: 0,
                    comprados: 0,
                    vendidos: 0,
                    transacoes: []
                });
            }

            return res.status(400).json({
                error:
                    "Nenhuma identificação de proprietário enviada."
            });
        }

        const transacoes =
            await buscarTransacoes(tokens, codigos);

        res.json({
            ok: true,
            total: transacoes.length,
            ...resumirTransacoes(transacoes),
            transacoes
        });

    } catch (error) {

        console.error(
            "ERRO ao consultar histórico:",
            error.message
        );

        res.status(500).json({
            error: error.message
        });
    }
});

/* =========================
   EXTRATO — EXPORTAÇÃO PDF / CSV
========================= */

app.get("/api/extrato/export", authOpcional, async (req, res) => {

    const formato =
        String(req.query.formato || "csv")
            .toLowerCase() === "pdf"
        ? "pdf"
        : "csv";

    if (!pgDisponivel) {
        return res.status(503).json({
            error:
                "Banco de dados ainda não configurado. " +
                "Defina DATABASE_URL para ativar o extrato."
        });
    }

    try {

        const { tokens, codigos } =
            await resolverCredenciais(req);

        if (!tokens.length && !codigos.length) {

            if (req.usuario) {

                const transacoes = [];
                const resumo = resumirTransacoes([]);
                const nomeArquivo =
                    "extrato-milhao-door-" +
                    new Date().toISOString().slice(0, 10);

                if (formato === "pdf") {
                    return gerarExtratoPdf(res, {
                        transacoes,
                        resumo,
                        nomeArquivo
                    });
                }

                gerarExtratoCsv(res, {
                    transacoes,
                    resumo,
                    nomeArquivo
                });
                return;
            }

            return res.status(400).json({
                error:
                    "Nenhuma identificação de proprietário enviada."
            });
        }

        const transacoes =
            await buscarTransacoes(tokens, codigos);

        const resumo = resumirTransacoes(transacoes);

        const nomeArquivo =
            "extrato-milhao-door-" +
            new Date().toISOString().slice(0, 10);

        if (formato === "pdf") {
            return gerarExtratoPdf(res, {
                transacoes,
                resumo,
                nomeArquivo
            });
        }

        gerarExtratoCsv(res, {
            transacoes,
            resumo,
            nomeArquivo
        });

    } catch (error) {

        console.error("ERRO ao exportar extrato:", error.message);

        res.status(500).json({
            error: error.message
        });
    }
});

function gerarExtratoCsv(res, { transacoes, resumo, nomeArquivo }) {

    const fmt = (n) =>
        String(Math.round(Number(n || 0) * 100) / 100)
            .replace(".", ",");

    const linhas = [];

    linhas.push(
        "Extrato Milhão Door;" +
        "gerado em;" +
        new Date().toLocaleString("pt-BR")
    );
    linhas.push("");
    linhas.push(
        "Total gasto;" + fmt(resumo.gastoTotal)
    );
    linhas.push(
        "Total recebido;" + fmt(resumo.recebidoTotal)
    );
    linhas.push(
        "Espacos comprados;" + resumo.comprados
    );
    linhas.push(
        "Espacos vendidos;" + resumo.vendidos
    );
    linhas.push("");
    linhas.push(
        "Data;Tipo;Espacos;Quantidade;Status;" +
        "Valor total;Comissao;Valor recebido"
    );

    for (const t of transacoes) {

        const data =
            new Date(t.criadoEm || Date.now())
                .toLocaleString("pt-BR");

        const espacos = (t.espacos || []).join(" ");

        linhas.push(
            [
                data,
                t.tipo,
                espacos,
                t.quantidade,
                t.status + (t.test ? " (teste)" : ""),
                fmt(t.valorTotal),
                fmt(t.comissao),
                t.tipo === "compra"
                    ? fmt(t.valorTotal)
                    : fmt(t.valorTotal - t.comissao)
            ].join(";")
        );
    }

    const csv =
        "\ufeff" + linhas.join("\r\n");

    res.setHeader(
        "Content-Type",
        "text/csv; charset=utf-8"
    );

    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${nomeArquivo}.csv"`
    );

    res.send(csv);
}

function gerarExtratoPdf(res, { transacoes, resumo, nomeArquivo }) {

    const doc = new pdfkit({
        size: "A4",
        margin: 36,
        info: {
            Title: "Extrato Milhão Door",
            Author: "Milhão Door"
        }
    });

    const chunks = [];

    doc.on("data", c => chunks.push(c));

    doc.on("end", () => {
        res.setHeader(
            "Content-Type",
            "application/pdf"
        );
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${nomeArquivo}.pdf"`
        );
        res.send(Buffer.concat(chunks));
    });

    doc.fontSize(18).fillColor("#111111").font("Helvetica-Bold");
    doc.text("MILHÃO DOOR", { align: "center" });

    doc.moveDown(0.2);
    doc.fontSize(11).fillColor("#666666").font("Helvetica");
    doc.text("Extrato do proprietário", { align: "center" });
    doc.text(
        "Gerado em " +
        new Date().toLocaleString("pt-BR"),
        { align: "center" }
    );

    doc.moveDown(1);

    const fmt = (n) =>
        "R$ " +
        Number(n || 0).toLocaleString("pt-BR", {
            minimumFractionDigits: 2
        });

    const resumoLinhas = [
        ["Total gasto", fmt(resumo.gastoTotal)],
        ["Total recebido", fmt(resumo.recebidoTotal)],
        ["Espaços comprados", String(resumo.comprados)],
        ["Espaços vendidos", String(resumo.vendidos)]
    ];

    for (const [label, valor] of resumoLinhas) {
        doc.fontSize(11).fillColor("#111111").font("Helvetica-Bold");
        doc.text(label);
        doc.font("Helvetica").fillColor("#333333");
        doc.text(valor, { align: "right" });
        doc.moveDown(0.15);
    }

    doc.moveDown(0.5);
    doc.fontSize(12).fillColor("#111111").font("Helvetica-Bold");
    doc.text("Transações");

    doc.moveDown(0.3);

    doc.fontSize(9);
    doc.font("Helvetica-Bold");
    doc.fillColor("#ffffff");
    doc.rect(36, doc.y, 518, 16).fill("#111111");
    doc.fillColor("#ffd400");
    doc.text("Data", 42, doc.y + 4, { width: 95 });
    doc.text("Tipo", 137, doc.y + 4, { width: 60 });
    doc.text("Espaços", 197, doc.y + 4, { width: 120 });
    doc.text("Qtd", 317, doc.y + 4, { width: 30 });
    doc.text("Status", 347, doc.y + 4, { width: 70 });
    doc.text("Valor", 417, doc.y + 4, { width: 70, align: "right" });
    doc.text("Recebido", 487, doc.y + 4, { width: 67, align: "right" });

    doc.moveDown(0.4);

    doc.font("Helvetica").fillColor("#333333");

    let alterna = false;

    for (const t of transacoes) {

        if (doc.y > 720) {
            doc.addPage();
        }

        const y = doc.y;

        const data =
            new Date(t.criadoEm || Date.now())
                .toLocaleString("pt-BR");

        const espacos =
            (t.espacos || []).length > 3
            ? "#" + t.espacos[0].toLocaleString("pt-BR") +
              " … #" + t.espacos[t.espacos.length - 1]
                .toLocaleString("pt-BR")
            : (t.espacos || [])
                .map(n => "#" + n.toLocaleString("pt-BR"))
                .join(" ");

        const recebido =
            t.tipo === "compra"
            ? t.valorTotal
            : t.valorTotal - t.comissao;

        if (alterna) {
            doc.rect(36, y, 518, 14).fill("#f2f2f2");
        }

        doc.fillColor("#333333");
        doc.text(data, 42, y + 2, { width: 95 });
        doc.text(
            (t.tipo === "compra" ? "Compra" : "Venda") +
            (t.test ? " (teste)" : ""),
            137, y + 2, { width: 60 }
        );
        doc.text(espacos, 197, y + 2, { width: 120 });
        doc.text(String(t.quantidade), 317, y + 2, { width: 30 });
        doc.text(
            t.status === "pago" ? "pago" : "pendente",
            347, y + 2, { width: 70 }
        );
        doc.text(fmt(t.valorTotal), 417, y + 2, {
            width: 70,
            align: "right"
        });
        doc.text(fmt(recebido), 487, y + 2, {
            width: 67,
            align: "right"
        });

        doc.moveDown(0.9);
        alterna = !alterna;
    }

    doc.moveDown(0.8);
    doc.fontSize(8).fillColor("#999999").font("Helvetica");
    doc.text(
        "Este extrato é um demonstrativo das transações " +
        "vinculadas às suas identificações de proprietário " +
        "do Milhão Door. Vendas: o valor recebido é o valor " +
        "negociado menos a comissão do site.",
        { align: "center" }
    );

    doc.end();
}

/* =========================
   OFERTAS (COMPRAR ESPAÇO VENDIDO)
========================= */

function confirmarPagamentoOferta(paymentIdOrOrderId) {

    const ofertas = readOffers();

    const oferta = Object.values(ofertas).find(o =>
        (o.paymentId === paymentIdOrOrderId || o.mpOrderId === paymentIdOrOrderId) &&
        o.status === "accepted"
    );

    if (!oferta) {
        return false;
    }

    const db = readDB();

    const alvos =
        (Array.isArray(oferta.spaceIds) &&
         oferta.spaceIds.length)
        ? oferta.spaceIds
        : [oferta.spaceId];

    const novoToken = gerarToken();
    const novoAccessCode = gerarAccessCode();

    let transferido = 0;

    const vendedores = new Set();

    for (const sid of alvos) {

        const space = db[sid];

        if (!space) continue;

        if (space.accessCode || space.orderToken) {
            vendedores.add(
                `${space.accessCode || ""}|` +
                `${space.orderToken || ""}`
            );
        }

        db[sid] = {
            ...space,
            name: oferta.name,
            email: oferta.email,
            orderToken: novoToken,
            accessCode: novoAccessCode,
            transferPaymentId: paymentId,
            transferredAt: new Date().toISOString(),
            link: undefined
        };

        transferido++;
    }

    if (!transferido) {
        return false;
    }

    writeDB(db);

    oferta.status = "paid";
    oferta.paidAt = new Date().toISOString();
    oferta.newOwnerToken = novoToken;
    oferta.newOwnerAccessCode = novoAccessCode;

    writeOffers(ofertas);

    const valorVenda = Number(oferta.value) || 0;

    const comissaoVenda =
        Number(oferta.feeValue) || taxaDoSite(valorVenda);

    const valorPagoComprador =
        Math.round(
            (valorVenda + comissaoVenda) * 100
        ) / 100;

    for (const par of vendedores) {

        const [codigo, tok] = par.split("|");

        registrarTransacao({
            tipo: "venda",
            accessCode: codigo || novoAccessCode,
            token: tok || null,
            orderId: oferta.id,
            paymentId,
            nome: oferta.name,
            email: oferta.email,
            espacos: alvos,
            valorTotal: valorVenda,
            comissao: comissaoVenda,
            status: "pago",
            test: false
        });
    }

    registrarTransacao({
        tipo: "compra",
        accessCode: novoAccessCode,
        token: novoToken,
        orderId: oferta.id,
        paymentId,
        nome: oferta.name,
        email: oferta.email,
        espacos: alvos,
        valorTotal: valorPagoComprador,
        comissao: 0,
        status: "pago",
        test: false
    });

    registrarLog("transferencia_concluida", {
        offerId: oferta.id,
        espacos: alvos.length,
        valor: valorVenda,
        comissao: comissaoVenda
    });

    const resumoEspacos =
        alvos.length === 1
        ? `espaço #${alvos[0].toLocaleString("pt-BR")}`
        : `bloco de ${alvos.length.toLocaleString("pt-BR")} espaços`;

    enviarEmail(
        oferta.email,
        "Seu bloco foi transferido — guarde este código",
        htmlNotificacao(
            "🎉 Espaço transferido para você",
            `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
            `O ${resumoEspacos} agora é seu (transferência confirmada).</p>` +
            `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
            `Guarde o código de acesso abaixo para recuperar ` +
            `seus espaços em qualquer aparelho:</p>` +
            `<div style="background:#111;border:1px solid #ffd400;` +
            `border-radius:8px;padding:12px;text-align:center;` +
            `font-size:18px;font-weight:800;color:#ffd400;` +
            `letter-spacing:1px;margin:10px 0;">${novoAccessCode}</div>`
        )
    );

    console.log(
        `Oferta ${oferta.id} paga. ` +
        `${transferido} espaço(s) transferido(s).`
    );

    return true;
}

/* =========================
   CHAVE PIX DO PROPRIETÁRIO
   Pagamento direto entre as partes
========================= */

function tipoChavePix(chave) {

    const c = chave.trim();
    const digitos = c.replace(/\D/g, "");

    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(c)) {
        return "E-mail";
    }

    if (
        /^\d{11}$/.test(digitos) &&
        digitos.length === c.length
    ) {
        return "CPF";
    }

    if (
        /^\d{14}$/.test(digitos) &&
        digitos.length === c.length
    ) {
        return "CNPJ";
    }

    if (/^\d{9,13}$/.test(digitos)) {
        return "Telefone";
    }

    if (/^[a-zA-Z0-9-]{8,36}$/.test(c)) {
        return "Aleatória";
    }

    return "";
}

/* Chave Pix do proprietário sempre atualizada:
   busca a chave cadastrada no painel (pixKeys) e,
   se o vendedor cadastrou/alterou depois de aceitar,
   o comprador recebe o valor correto automaticamente. */

function chavePixDoProprietario(oferta) {

    if (!oferta) {
        return "";
    }

    const chaveCadastrada =
        (readPixKeys()[oferta.ownerToken] || {}).chave;

    return (
        chaveCadastrada ||
        oferta.ownerPixKey ||
        ""
    );
}

/* Dados da negociação para o chat */

function alvosDaOferta(oferta) {

    return (
        Array.isArray(oferta.spaceIds) &&
        oferta.spaceIds.length
    )
        ? oferta.spaceIds
        : [oferta.spaceId];
}

function nomeDoProprietario(oferta) {

    const db = readDB();
    const alvos = alvosDaOferta(oferta);

    return (
        (db[alvos[0]] || {}).name ||
        "Proprietário"
    );
}

function identificarParticipante(oferta, email, token) {

    if (
        email &&
        email.trim().toLowerCase() ===
            (oferta.email || "").trim().toLowerCase()
    ) {
        return {
            who: "buyer",
            nick: oferta.name || "Comprador"
        };
    }

    const db = readDB();
    const alvos = alvosDaOferta(oferta);

    if (
        token &&
        alvos.every(a =>
            db[a] && db[a].orderToken === token
        )
    ) {
        return {
            who: "owner",
            nick: (db[alvos[0]] || {}).name || "Proprietário"
        };
    }

    return null;
}

app.get("/api/pix-key", (req, res) => {

    const token = (req.query.token || "").trim();

    if (!token) {
        return res.status(400).json({
            error: "Token de proprietário não informado."
        });
    }

    const keys = readPixKeys();
    const info = keys[token] || {};

    res.json({
        ok: true,
        chave: info.chave || "",
        tipo: info.tipo || ""
    });
});

app.post("/api/pix-key", (req, res) => {

    try {

        const token = (req.body.token || "").trim();
        const chave = (req.body.chave || "").trim();

        if (!token) {
            return res.status(400).json({
                error: "Token de proprietário não informado."
            });
        }

        if (!chave) {
            return res.status(400).json({
                error: "Informe sua chave Pix."
            });
        }

        const tipo = tipoChavePix(chave);

        if (!tipo) {
            return res.status(400).json({
                error:
                    "Chave Pix inválida. Use CPF, CNPJ, " +
                    "e-mail, telefone ou chave aleatória."
            });
        }

        const keys = readPixKeys();

        keys[token] = {
            chave,
            tipo,
            updatedAt: new Date().toISOString()
        };

        writePixKeys(keys);

        res.json({
            ok: true,
            chave,
            tipo
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/offers", (req, res) => {

    try {

        const {
            spaceId,
            spaceIds,
            name,
            email,
            value,
            message
        } = req.body;

        const id = Number(spaceId);

        if (
            !Number.isInteger(id) ||
            id < 1 ||
            id > 1000000
        ) {
            return res.status(400).json({
                error: "Espaço inválido."
            });
        }

        const db = readDB();

        let alvos = [];

        if (
            Array.isArray(spaceIds) &&
            spaceIds.length
        ) {

            alvos = [
                ...new Set(
                    spaceIds.map(Number)
                )
            ].filter(n =>
                Number.isInteger(n) &&
                n >= 1 &&
                n <= 1000000
            );

            if (!alvos.length) {
                return res.status(400).json({
                    error: "Lista de espaços inválida."
                });
            }

            if (alvos.length > 1000) {
                return res.status(400).json({
                    error: "Máximo de 1.000 espaços por oferta."
                });
            }

            if (!alvos.includes(id)) {
                alvos.unshift(id);
            }

        } else {

            alvos = [id];
        }

        for (const a of alvos) {

            if (!db[a]) {
                return res.status(404).json({
                    error:
                        "Espaço não encontrado: " +
                        `#${a.toLocaleString("pt-BR")}.`
                });
            }

            if (db[a].status !== "published") {
                return res.status(400).json({
                    error:
                        "Um dos espaços ainda não está publicado " +
                        "para receber ofertas."
                });
            }
        }

        const donoToken =
            db[alvos[0]].orderToken || "";

        const mesmoDono = alvos.every(a =>
            (db[a].orderToken || "") === donoToken
        );

        if (!mesmoDono || !donoToken) {
            return res.status(400).json({
                error:
                    "Os espaços da oferta devem pertencer " +
                    "ao mesmo proprietário."
            });
        }

        if (!name || name.trim().length < 3) {
            return res.status(400).json({
                error: "Informe seu nome."
            });
        }

        if (!email || !email.includes("@")) {
            return res.status(400).json({
                error: "Informe um e-mail válido."
            });
        }

        const valor = Number(value);

        if (
            !Number.isFinite(valor) ||
            valor < 1 ||
            valor > 1000000
        ) {
            return res.status(400).json({
                error: "Informe um valor de oferta válido (R$)."
            });
        }

        if (valor < alvos.length) {
            return res.status(400).json({
                error:
                    "O valor da oferta deve ser de pelo menos " +
                    "R$ 1,00 por espaço (mínimo de " +
                    `R$ ${alvos.length.toLocaleString("pt-BR")} ` +
                    "para este bloco)."
            });
        }

        const ofertas = readOffers();

        const ofertaId =
            `OFR-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 7)}`;

        ofertas[ofertaId] = {
            id: ofertaId,
            spaceId: alvos[0],
            spaceIds: alvos,
            name: name.trim(),
            email: email.trim(),
            value: valor,
            message: (message || "").trim(),
            status: "pending",
            ownerToken: donoToken,
            createdAt: new Date().toISOString()
        };

        writeOffers(ofertas);

        const dono = db[alvos[0]];

        if (dono) {

            const resumoEspacos =
                alvos.length === 1
                ? `espaço <b>#${alvos[0].toLocaleString("pt-BR")}</b>`
                : `bloco de <b>${alvos.length.toLocaleString("pt-BR")}`
                  + ` espaço(s)</b> (de #`
                  + `${alvos[0].toLocaleString("pt-BR")} a #`
                  + `${alvos[alvos.length - 1].toLocaleString("pt-BR")})`;

            const item =
                `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
                `Oferta para o ${resumoEspacos}:</p>` +
                `<div style="font-size:14px;color:#333;">` +
                `Comprador: <b>${name.trim()}</b><br>` +
                `Valor da oferta: ` +
                `<b style="color:#15803d;">` +
                `R$ ${Number(value).toLocaleString("pt-BR")}</b><br>` +
                (message
                    ? `Mensagem: ${message.trim()}<br>`
                    : "") +
                `E-mail do comprador: ${email.trim()}` +
                `</div>`;

            agendarEmailUnificado(
                dono.email,
                item
            );
        }

        res.json({
            ok: true,
            offerId: ofertaId,
            spaces: alvos.length
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

app.get("/api/offers/owner", (req, res) => {

    const token = (req.query.token || "").trim();

    if (!token) {
        return res.status(400).json({
            error: "Token de proprietário não informado."
        });
    }

    const db = readDB();
    const ofertas = readOffers();

    const meusIds =
        Object.values(db)
            .filter(s => s.orderToken === token)
            .map(s => s.id);

    const lista =
        Object.values(ofertas)
            .filter(o => {
                const alvos =
                    (Array.isArray(o.spaceIds) &&
                     o.spaceIds.length)
                    ? o.spaceIds
                    : [o.spaceId];

                return (
                    alvos.some(s => meusIds.includes(s)) &&
                    (o.status === "pending" ||
                     o.status === "countered" ||
                     o.status === "accepted" ||
                     o.status === "paid")
                );
            })
            .map(o => ({
                id: o.id,
                spaceId: o.spaceId,
                spaceIds:
                    (Array.isArray(o.spaceIds) &&
                     o.spaceIds.length)
                    ? o.spaceIds
                    : [o.spaceId],
                name: o.name,
                email: o.email,
                value: o.value,
                originalValue: o.originalValue,
                message: o.message,
                status: o.status,
                feeValue: o.feeValue,
                ownerPixKey: chavePixDoProprietario(o),
                createdAt: o.createdAt
            }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({
        ok: true,
        offers: lista
    });
});

/* =========================
   GERA CLIENTE + PIX PARA UMA OFERTA
========================= */

async function gerarPixOferta(oferta, document, valor, descricao) {

    const montante =
        Number.isFinite(valor) && valor > 0
        ? valor
        : oferta.value;

    const orderId = `OFFER-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const mp = await criarOrderMercadoPago({
        idempotencyKey: orderId,
        externalReference: orderId,
        value: montante,
        description:
            descricao ||
            `Milhão Door - transferência do espaço ` +
            `#${oferta.spaceId.toLocaleString("pt-BR")}`,
        customer: {
            name: oferta.name,
            taxID: document,
            email: oferta.email
        },
        paymentMethod: "pix"
    });

    return {
        customer: null,
        payment: {
            id: mp.paymentId,
            orderId: mp.orderId,
            correlationID: mp.externalReference,
            paymentLinkID: mp.ticketUrl,
            value: montante,
            brCode: mp.payload
        },
        pix: {
            encodedImage: mp.qrCodeBase64,
            payload: mp.payload,
            expirationDate: mp.expirationDate
        }
    };
}

app.post("/api/offers/:id/accept", async (req, res) => {

    try {

        if (!MERCADOPAGO_ACCESS_TOKEN) {
            return res.status(503).json({
                error:
                    "Pagamento temporariamente indisponível. " +
                    "MERCADOPAGO_ACCESS_TOKEN não configurado."
            });
        }

        const ofertas = readOffers();
        const oferta = ofertas[req.params.id];

        if (!oferta || oferta.status !== "pending") {
            return res.status(404).json({
                error: "Oferta não encontrada ou já respondida."
            });
        }

        const token = (req.body.token || "").trim();

        const db = readDB();

        const alvos =
            (Array.isArray(oferta.spaceIds) &&
             oferta.spaceIds.length)
            ? oferta.spaceIds
            : [oferta.spaceId];

        const donoOk =
            alvos.length &&
            alvos.every(a =>
                db[a] &&
                db[a].orderToken === token
            );

        if (!donoOk) {
            return res.status(403).json({
                error:
                    "Você não é o proprietário destes espaços."
            });
        }

        /* =========================
           CHAVE PIX DO PROPRIETÁRIO
           (pagamento direto entre as partes)
        ========================= */

        const pixKeys = readPixKeys();
        const minhaChave =
            (pixKeys[token] || {}).chave || "";

        if (!minhaChave) {
            return res.status(400).json({
                error:
                    "Cadastre sua chave Pix no painel de " +
                    "comando para receber o pagamento " +
                    "direto do comprador."
            });
        }

        /* =========================
           CRIA CLIENTE + PIX DA TAXA (10%)
           O comprador paga o valor cheio
           direto ao dono e paga a taxa ao site
        ========================= */

        const document =
            (req.body.cpfCnpj || "")
                .replace(/\D/g, "");

        if (!validarDocumento(document)) {
            return res.status(400).json({
                error:
                    "Informe um CPF ou CNPJ válido do comprador."
            });
        }

        const feeValue =
            taxaDoSite(oferta.value);

        const { customer, payment, pix } =
            await gerarPixOferta(
                oferta,
                document,
                feeValue,
                "Taxa de serviço Milhão Door (10%)"
            );

        oferta.status = "accepted";
        oferta.paymentId = payment.id;
        oferta.mpOrderId = payment.orderId;
        oferta.customerId = customer?.correlationID || "";
        oferta.feeValue = feeValue;
        oferta.ownerPixKey = minhaChave;
        oferta.acceptedAt = new Date().toISOString();

        writeOffers(ofertas);

        const resumoEspacos =
            alvos.length === 1
            ? `espaço #${alvos[0].toLocaleString("pt-BR")}`
            : `bloco de ${alvos.length.toLocaleString("pt-BR")} espaços`;

        enviarEmail(
            oferta.email,
            `Sua oferta para o ${resumoEspacos} foi aceita`,
            htmlNotificacao(
                "🎉 Oferta aceita — pagamento direto",
                `<p style="margin:0 0 10px;color:#444;font-size:14px;">` +
                `Sua oferta de ` +
                `<b style="color:#15803d;">` +
                `R$ ${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                `para o ${resumoEspacos} foi aceita.</p>` +
                `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
                `Pague <b>R$ ` +
                `${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                `diretamente ao proprietário na chave Pix:</p>` +
                `<div style="background:#f7f7f7;border-radius:8px;` +
                `padding:12px;font-size:14px;color:#333;word-break:break-all;">` +
                `${minhaChave}</div>` +
                `<p style="margin:10px 0 0;color:#666;font-size:13px;">` +
                `E pague a taxa de 10% do site ` +
                `(<b>R$ ${feeValue.toLocaleString("pt-BR")}</b>) ` +
                `pelo Pix gerado no site. A transferência é feita ` +
                `ao confirmar o pagamento da taxa.</p>`
            )
        );

        res.json({

            ok: true,
            offerId: oferta.id,
            qrCode: pix.encodedImage,
            payload: pix.payload,
            paymentId: payment.id,
            mpOrderId: payment.orderId,
            value: oferta.value,
            feeValue,
            ownerPixKey: minhaChave,
            spaceIds: alvos
        });

    } catch (error) {

        console.error("ERRO OFERTA ACEITA:", mascararSensivel(error.message));

        res.status(500).json({
            error: formatarErroPagamento(error)
        });
    }
});

app.post("/api/offers/:id/buyer-accept", async (req, res) => {

    try {

        if (!MERCADOPAGO_ACCESS_TOKEN) {
            return res.status(503).json({
                error:
                    "Pagamento temporariamente indisponível. " +
                    "MERCADOPAGO_ACCESS_TOKEN não configurado."
            });
        }

        const ofertas = readOffers();
        const oferta = ofertas[req.params.id];

        if (!oferta || oferta.status !== "countered") {
            return res.status(404).json({
                error: "Oferta não encontrada ou já respondida."
            });
        }

        const email =
            (req.body.email || "").trim().toLowerCase();

        if (
            !email ||
            email !== (oferta.email || "").trim().toLowerCase()
        ) {
            return res.status(403).json({
                error: "E-mail não confere com a oferta."
            });
        }

        const document =
            (req.body.cpfCnpj || "")
                .replace(/\D/g, "");

        if (!validarDocumento(document)) {
            return res.status(400).json({
                error:
                    "Informe um CPF ou CNPJ válido."
            });
        }

        const db = readDB();

        const alvos =
            (Array.isArray(oferta.spaceIds) &&
             oferta.spaceIds.length)
            ? oferta.spaceIds
            : [oferta.spaceId];

        const pixKeys = readPixKeys();
        const chaveDono =
            (pixKeys[oferta.ownerToken] || {}).chave || "";

        const feeValue =
            taxaDoSite(oferta.value);

        const { customer, payment, pix } =
            await gerarPixOferta(
                oferta,
                document,
                feeValue,
                "Taxa de serviço Milhão Door (10%)"
            );

        oferta.status = "accepted";
        oferta.paymentId = payment.id;
        oferta.mpOrderId = payment.orderId;
        oferta.customerId = customer?.correlationID || "";
        oferta.feeValue = feeValue;
        oferta.ownerPixKey = chaveDono;
        oferta.acceptedAt = new Date().toISOString();

        writeOffers(ofertas);

        const dono = db[oferta.spaceId];

        if (dono) {

            const resumoEspacos =
                alvos.length === 1
                ? `espaço #${alvos[0].toLocaleString("pt-BR")}`
                : `bloco de ${alvos.length.toLocaleString("pt-BR")} espaços`;

            enviarEmail(
                dono.email,
                `Comprador aceitou sua contraproposta ` +
                `para o ${resumoEspacos}`,
                htmlNotificacao(
                    "✅ Contraproposta aceita",
                    `<p style="margin:0;color:#444;font-size:14px;">` +
                    `O comprador <b>${oferta.name}</b> aceitou sua ` +
                    `contraproposta de ` +
                    `<b style="color:#15803d;">` +
                    `R$ ${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                    `para o ${resumoEspacos}.</p>` +
                    `<p style="margin:8px 0 0;color:#666;font-size:13px;">` +
                    `O comprador pagará o valor direto na sua chave Pix ` +
                    `(${chaveDono || "chave cadastrada"}) e a taxa de ` +
                    `10% ao site. A transferência é feita ao confirmar ` +
                    `o pagamento da taxa.</p>`
                )
            );
        }

        res.json({
            ok: true,
            offerId: oferta.id,
            qrCode: pix.encodedImage,
            payload: pix.payload,
            paymentId: payment.id,
            mpOrderId: payment.orderId,
            value: oferta.value,
            feeValue,
            ownerPixKey: chaveDono,
            spaceIds: alvos
        });

    } catch (error) {

        console.error("ERRO CONTRA-PROPOSTA ACEITA:", error.message);

        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/offers/:id/buyer-reject", (req, res) => {

    const ofertas = readOffers();
    const oferta = ofertas[req.params.id];

    if (!oferta || oferta.status !== "countered") {
        return res.status(404).json({
            error: "Oferta não encontrada ou já respondida."
        });
    }

    const email =
        (req.body.email || "").trim().toLowerCase();

    if (
        !email ||
        email !== (oferta.email || "").trim().toLowerCase()
    ) {
        return res.status(403).json({
            error: "E-mail não confere com a oferta."
        });
    }

    oferta.status = "rejected";
    oferta.rejectedAt = new Date().toISOString();

    writeOffers(ofertas);

    const db = readDB();
    const dono = db[oferta.spaceId];

    if (dono) {

        enviarEmail(
            dono.email,
            `Comprador recusou sua contraproposta ` +
            `para o espaço ` +
            `#${oferta.spaceId.toLocaleString("pt-BR")}`,
            htmlNotificacao(
                "Contraproposta recusada",
                `<p style="margin:0;color:#444;font-size:14px;">` +
                `O comprador <b>${oferta.name}</b> recusou sua ` +
                `contraproposta de ` +
                `<b>R$ ${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                `para o espaço ` +
                `<b>#${oferta.spaceId.toLocaleString("pt-BR")}</b>.</p>`
            )
        );
    }

    res.json({
        ok: true,
        offerId: oferta.id,
        status: "rejected"
    });
});

app.post("/api/offers/:id/reject", (req, res) => {

    const ofertas = readOffers();
    const oferta = ofertas[req.params.id];

    if (!oferta || oferta.status !== "pending") {
        return res.status(404).json({
            error: "Oferta não encontrada ou já respondida."
        });
    }

    const token = (req.body.token || "").trim();

    const db = readDB();

    if (
        !db[oferta.spaceId] ||
        db[oferta.spaceId].orderToken !== token
    ) {
        return res.status(403).json({
            error: "Você não é o proprietário deste espaço."
        });
    }

    oferta.status = "rejected";
    oferta.rejectedAt = new Date().toISOString();

    writeOffers(ofertas);

    enviarEmail(
        oferta.email,
        `Sua oferta para o espaço ` +
        `#${oferta.spaceId.toLocaleString("pt-BR")} foi recusada`,
        htmlNotificacao(
            "😔 Oferta recusada",
            `<p style="margin:0;color:#444;font-size:14px;">` +
            `O proprietário recusou sua oferta de ` +
            `<b>R$ ${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
            `para o espaço ` +
            `<b>#${oferta.spaceId.toLocaleString("pt-BR")}</b>.` +
            `</p>`
        )
    );

    res.json({
        ok: true,
        offerId: oferta.id,
        status: "rejected"
    });
});

app.post("/api/offers/:id/counter", (req, res) => {

    const ofertas = readOffers();
    const oferta = ofertas[req.params.id];

    if (
        !oferta ||
        (oferta.status !== "pending" &&
         oferta.status !== "countered")
    ) {
        return res.status(404).json({
            error: "Oferta não encontrada ou já respondida."
        });
    }

    const token = (req.body.token || "").trim();

    const db = readDB();

    if (
        !db[oferta.spaceId] ||
        db[oferta.spaceId].orderToken !== token
    ) {
        return res.status(403).json({
            error: "Você não é o proprietário deste espaço."
        });
    }

    const novoValor = Number(req.body.value);

    if (
        !Number.isFinite(novoValor) ||
        novoValor < 1 ||
        novoValor > 1000000
    ) {
        return res.status(400).json({
            error: "Informe um valor de contraproposta válido (R$)."
        });
    }

    if (!oferta.originalValue) {
        oferta.originalValue = oferta.value;
    }

    oferta.value = novoValor;
    oferta.status = "countered";
    oferta.counteredAt = new Date().toISOString();

    writeOffers(ofertas);

    enviarEmail(
        oferta.email,
        `Contraproposta para o espaço ` +
        `#${oferta.spaceId.toLocaleString("pt-BR")}`,
        htmlNotificacao(
            "🤝 Contraproposta do proprietário",
            `<p style="margin:0 0 10px;color:#444;font-size:14px;">` +
            `O proprietário do espaço ` +
            `<b>#${oferta.spaceId.toLocaleString("pt-BR")}</b> ` +
            `fez uma contraproposta de ` +
            `<b style="color:#15803d;">` +
            `R$ ${novoValor.toLocaleString("pt-BR")}</b> ` +
            `(sua oferta original: ` +
            `R$ ${oferta.originalValue.toLocaleString("pt-BR")}).</p>` +
            `<p style="margin:0;color:#666;font-size:13px;">` +
            `Acesse o site e confirme o novo valor para gerar o Pix.</p>`
        )
    );

    res.json({
        ok: true,
        offerId: oferta.id,
        status: "countered",
        value: novoValor
    });
});

app.get("/api/offers/:id", (req, res) => {

    const ofertas = readOffers();
    const oferta = ofertas[req.params.id];

    if (!oferta) {
        return res.status(404).json({
            error: "Oferta não encontrada."
        });
    }

    const email =
        (req.query.email || "")
            .trim()
            .toLowerCase();

    const token =
        (req.query.token || "").trim();

    const ehComprador =
        email ===
        (oferta.email || "").trim().toLowerCase();

    const db = readDB();

    const alvos =
        (Array.isArray(oferta.spaceIds) &&
         oferta.spaceIds.length)
        ? oferta.spaceIds
        : [oferta.spaceId];

    const ehDono =
        token &&
        alvos.length &&
        alvos.every(a =>
            db[a] && db[a].orderToken === token
        );

    if (!ehComprador && !ehDono) {
        return res.status(403).json({
            error:
                "Acesso restrito aos participantes da negociação."
        });
    }

    res.json({
        ok: true,
        id: oferta.id,
        spaceId: oferta.spaceId,
        spaceIds: alvos,
        name: oferta.name,
        email: oferta.email,
        value: oferta.value,
        originalValue: oferta.originalValue,
        status: oferta.status,
        feeValue: oferta.feeValue,
        createdAt: oferta.createdAt,
        ...(ehDono
            ? { ownerPixKey: chavePixDoProprietario(oferta) }
            : {}),
        newOwnerToken:
            oferta.status === "paid"
                ? oferta.newOwnerToken || ""
                : undefined,
        newOwnerAccessCode:
            oferta.status === "paid"
                ? oferta.newOwnerAccessCode ||
                  (db[alvos[0]] || {}).accessCode ||
                  ""
                : undefined
    });
});

/* =========================
   DADOS DE PAGAMENTO DA OFERTA
   Re-fetch do QR da taxa quando
   o comprador volta ao painel
========================= */

app.get("/api/offers/:id/payment", authUsuario, async (req, res) => {

    try {

        const ofertas = readOffers();
        const oferta = ofertas[req.params.id];

        if (
            !oferta ||
            (oferta.status !== "accepted" &&
             oferta.status !== "paid")
        ) {
            return res.status(404).json({
                error: "Oferta não encontrada ou sem pagamento."
            });
        }

        const alvos =
            (Array.isArray(oferta.spaceIds) &&
             oferta.spaceIds.length)
            ? oferta.spaceIds
            : [oferta.spaceId];

        const token =
            (req.query.token || "").trim();

        const db = readDB();

        const ehComprador =
            req.usuario.email ===
            (oferta.email || "").trim().toLowerCase();

        const ehDono =
            token &&
            alvos.length &&
            alvos.every(a =>
                db[a] && db[a].orderToken === token
            );

        if (!ehComprador && !ehDono) {
            return res.status(403).json({
                error:
                    "Acesso restrito aos participantes da negociação."
            });
        }

        if (oferta.status === "paid") {

            return res.json({
                ok: true,
                status: "paid",
                offerId: oferta.id,
                value: oferta.value,
                feeValue: oferta.feeValue,
                ownerPixKey: chavePixDoProprietario(oferta),
                spaceIds: alvos,
                newOwnerToken: oferta.newOwnerToken || "",
                newOwnerAccessCode:
                    oferta.newOwnerAccessCode ||
                    (db[alvos[0]] || {}).accessCode ||
                    ""
            });
        }

        const order =
            await consultarOrderMercadoPago(oferta.mpOrderId || oferta.paymentId);

        const dados = extrairDadosPagamento(order);

        res.json({
            ok: true,
            offerId: oferta.id,
            qrCode: dados.qrCodeBase64 || "",
            payload: dados.payload || "",
            paymentId: oferta.paymentId,
            mpOrderId: oferta.mpOrderId,
            value: oferta.value,
            feeValue: oferta.feeValue,
            ownerPixKey: chavePixDoProprietario(oferta),
            spaceIds: alvos
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* =========================
   CHAT GERAL
========================= */

function lerChatGeral() {
    return readJsonFile(CHAT_FILE, []);
}

function salvarChatGeral(mensagens) {
    writeJsonFile(CHAT_FILE, mensagens);
}

function mensagemValida(texto) {

    const t = (texto || "").trim();

    if (!t || t.length > 500) {
        return "";
    }

    return t;
}

app.get("/api/chat/general", (req, res) => {

    res.json({
        ok: true,
        messages: lerChatGeral()
    });
});

app.post("/api/chat/general", (req, res) => {

    const nick = (req.body.nick || "").trim();
    const texto = mensagemValida(req.body.text);

    if (nick.length < 2 || nick.length > 40) {
        return res.status(400).json({
            error: "Informe seu nome (2 a 40 caracteres)."
        });
    }

    if (!texto) {
        return res.status(400).json({
            error: "Escreva a mensagem (máximo 500 caracteres)."
        });
    }

    const mensagens = lerChatGeral();

    mensagens.push({
        id: Date.now().toString(36) +
            Math.random().toString(36).substring(2, 6),
        nick,
        text: texto,
        at: new Date().toISOString()
    });

    const mantidas =
        mensagens.length > 200
            ? mensagens.slice(mensagens.length - 200)
            : mensagens;

    salvarChatGeral(mantidas);

    const novaMsg =
        mantidas[mantidas.length - 1];

    broadcastChat(null, novaMsg);

    res.json({
        ok: true,
        message: novaMsg
    });
});

/* =========================
   CHAT DE NEGOCIAÇÃO
   Conversa privada entre comprador
   e proprietário de uma oferta
========================= */

function lerChatNegociacao() {
    return readJsonFile(CHAT_NEGOC_FILE, {});
}

function salvarChatNegociacao(dados) {
    writeJsonFile(CHAT_NEGOC_FILE, dados);
}

const CHAVES_PERIGOSAS = new Set([
    "__proto__",
    "constructor",
    "prototype"
]);

function chaveNegociacaoSegura(chave) {

    const c = String(chave || "");

    return (
        c.length >= 1 &&
        c.length <= 64 &&
        !CHAVES_PERIGOSAS.has(c)
    );
}

function lerChatNegociacaoDa(offerId) {

    if (!chaveNegociacaoSegura(offerId)) {
        return null;
    }

    const dados = lerChatNegociacao();

    if (
        !Object.prototype.hasOwnProperty.call(
            dados, offerId
        )
    ) {
        return [];
    }

    return dados[offerId];
}

app.get("/api/chat/negotiation", (req, res) => {

    const offerId =
        (req.query.offerId || "").trim();

    const email =
        (req.query.email || "").trim();

    const token =
        (req.query.token || "").trim();

    if (!chaveNegociacaoSegura(offerId)) {
        return res.status(400).json({
            error: "Negociação inválida."
        });
    }

    const ofertas = readOffers();
    const oferta = ofertas[offerId];

    if (!oferta) {
        return res.status(404).json({
            error: "Negociação não encontrada."
        });
    }

    const participante =
        identificarParticipante(oferta, email, token);

    if (!participante) {
        return res.status(403).json({
            error:
                "Acesso restrito aos participantes da negociação."
        });
    }

    const mensagens = lerChatNegociacaoDa(offerId);

    res.json({
        ok: true,
        offerId,
        comprador: oferta.name || "Comprador",
        dono: nomeDoProprietario(oferta),
        messages: mensagens
    });
});

app.post("/api/chat/negotiation", (req, res) => {

    const offerId =
        (req.body.offerId || "").trim();

    const email =
        (req.body.email || "").trim();

    const token =
        (req.body.token || "").trim();

    const texto =
        mensagemValida(req.body.text);

    if (!chaveNegociacaoSegura(offerId)) {
        return res.status(400).json({
            error: "Negociação inválida."
        });
    }

    const ofertas = readOffers();
    const oferta = ofertas[offerId];

    if (!oferta) {
        return res.status(404).json({
            error: "Negociação não encontrada."
        });
    }

    const participante =
        identificarParticipante(oferta, email, token);

    if (!participante) {
        return res.status(403).json({
            error:
                "Acesso restrito aos participantes da negociação."
        });
    }

    if (!texto) {
        return res.status(400).json({
            error: "Escreva a mensagem (máximo 500 caracteres)."
        });
    }

    const dados = lerChatNegociacao();
    const mensagens = dados[offerId] || [];

    mensagens.push({
        id: Date.now().toString(36) +
            Math.random().toString(36).substring(2, 6),
        who: participante.who,
        nick: participante.nick,
        text: texto,
        at: new Date().toISOString()
    });

    dados[offerId] =
        mensagens.length > 300
            ? mensagens.slice(mensagens.length - 300)
            : mensagens;

    salvarChatNegociacao(dados);

    const novaMsg =
        dados[offerId][dados[offerId].length - 1];

    broadcastChat(offerId, novaMsg);

    res.json({
        ok: true,
        message: novaMsg
    });
});

/* =========================
   STREAM DO CHAT (SSE)
   Mensagens em tempo real
========================= */

const chatGeralListeners = new Set();
const chatNegocListeners = new Map();

function broadcastChat(offerId, msg) {

    if (offerId) {

        const set = chatNegocListeners.get(offerId);

        if (!set) return;

        const dados = `data: ${JSON.stringify(msg)}\n\n`;

        for (const res of set) {
            try {
                res.write(dados);
            } catch (e) {}
        }

        return;
    }

    const dados = `data: ${JSON.stringify(msg)}\n\n`;

    for (const res of chatGeralListeners) {
        try {
            res.write(dados);
        } catch (e) {}
    }
}

app.get("/api/chat/stream", (req, res) => {

    const offerId =
        (req.query.offerId || "").trim();

    const email =
        (req.query.email || "").trim();

    const token =
        (req.query.token || "").trim();

    if (offerId) {

        if (!chaveNegociacaoSegura(offerId)) {
            return res.status(400).json({
                error: "Negociação inválida."
            });
        }

        const ofertas = readOffers();
        const oferta = ofertas[offerId];

        if (
            !oferta ||
            !identificarParticipante(oferta, email, token)
        ) {
            return res.status(403).json({
                error:
                    "Acesso restrito aos participantes da negociação."
            });
        }
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });

    res.write(":ok\n\n");

    if (offerId) {

        const set =
            chatNegocListeners.get(offerId) ||
            new Set();

        set.add(res);

        chatNegocListeners.set(offerId, set);

        req.on("close", () => {
            set.delete(res);
            if (!set.size) {
                chatNegocListeners.delete(offerId);
            }
        });

    } else {

        chatGeralListeners.add(res);

        req.on("close", () => {
            chatGeralListeners.delete(res);
        });
    }
});

/* =========================
   UPLOAD FOTO
========================= */

app.post(
    "/api/upload/:id",
    upload.single("fotos"),
    (req, res) => {

        const idRaw =
            String(req.params.id || "");

        if (!/^\d{1,7}$/.test(idRaw)) {
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            return res.status(400).json({
                error: "Identificador de espaço inválido."
            });
        }

        if (req.file) {

            const dadosImagem =
                fs.readFileSync(req.file.path);

            if (!ehImagemValida(dadosImagem)) {

                fs.unlink(req.file.path, () => {});

                return res.status(400).json({
                    error:
                        "O arquivo enviado não é uma imagem válida."
                });
            }
        }

        const id = Number(idRaw);
        const db = readDB();

        let ids = [id];

        if (req.body.mode === "extended") {

            try {
                ids = JSON.parse(req.body.ids || "[]");
            } catch {
                return res.status(400).json({
                    error: "Lista de espaços inválida."
                });
            }

            ids = [
                ...new Set(
                    ids.map(Number)
                )
            ];

            if (!ids.includes(id)) {
                ids.unshift(id);
            }

            if (!ids.length) {
                return res.status(400).json({
                    error: "Nenhum espaço informado."
                });
            }

            if (ids.length > 1000) {
                return res.status(400).json({
                    error: "Máximo de 1.000 espaços por anúncio."
                });
            }
        }

        for (const spaceId of ids) {

            if (
                !Number.isInteger(spaceId) ||
                spaceId < 1 ||
                spaceId > 1000000
            ) {
                return res.status(400).json({
                    error: `Espaço inválido: ${spaceId}`
                });
            }

            if (!db[spaceId]) {
                return res.status(404).json({
                    error:
                        `Espaço não encontrado: ` +
                        `#${spaceId.toLocaleString("pt-BR")}`
                });
            }

            if (
                db[spaceId].status !== "paid" &&
                db[spaceId].status !== "published"
            ) {
                return res.status(403).json({
                    error:
                        `O pagamento do espaço ` +
                        `#${spaceId.toLocaleString("pt-BR")} ` +
                        `ainda não foi confirmado.`
                });
            }
        }

        /* =========================
           TOKEN DE PROPRIEDADE
           Só o dono pode editar a foto
        ========================= */

        const orderToken =
            (req.body.orderToken || "").trim();

        for (const spaceId of ids) {

            const dono =
                db[spaceId].orderToken;

            if (dono && dono !== orderToken) {
                return res.status(403).json({
                    error:
                        `Você não é o proprietário do espaço ` +
                        `#${spaceId.toLocaleString("pt-BR")}.`
                });
            }
        }

        if (!req.file) {
            return res.status(400).json({
                error: "Envie uma imagem."
            });
        }

        const image =
            `/uploads/${req.file.filename}`;

        const title =
            req.body.name ||
            req.body.nome ||
            "Anunciante";

        const linkInput =
            (req.body.link || "").trim();

        const link =
            linkInput ? normalizarLink(linkInput) : "";

        if (linkInput && !link) {
            return res.status(400).json({
                error:
                    "Link do site inválido. Use um endereço " +
                    "válido, ex: https://seusite.com"
            });
        }

        const publishedAt =
            new Date().toISOString();

        const isExtended =
            req.body.mode === "extended";

        const tocados =
            new Set(ids);

        for (const spaceId of ids) {

            db[spaceId] = {
                ...db[spaceId],
                status: "published",
                image,
                title,
                link:
                    link
                    ? link
                    : undefined,
                publishedAt,
                orderToken:
                    db[spaceId].orderToken || orderToken,
                ...(isExtended ? {
                    displayMode: "extended",
                    imageGroupSpaces: ids
                } : {
                    displayMode: "individual",
                    imageGroupSpaces: [spaceId]
                })
            };
        }

        /* =========================
           RECONCILIAÇÃO DE GRUPOS
           Ao editar o bloco inteiro (modo estendido),
           espaços vizinhos que antes faziam parte do
           grupo e não foram incluídos na edição perdem
           a referência ao espaço desmembrado.

           Em edições individuais (solo) os vizinhos
           mantêm o grupo original intacto, preservando
           a foto esticada; apenas o espaço editado
           passa a exibir a nova foto.
        ========================= */

        if (isExtended) {

            for (const sid of Object.keys(db)) {

                const nid = Number(sid);

                if (tocados.has(nid)) continue;

                const s = db[sid];

                if (
                    s.displayMode !== "extended" ||
                    !Array.isArray(s.imageGroupSpaces)
                ) continue;

                const grupo =
                    s.imageGroupSpaces.map(Number);

                const novo =
                    grupo.filter(g =>
                        !tocados.has(g)
                    );

                if (novo.length === grupo.length) {
                    continue;
                }

                if (novo.length <= 1) {

                    db[sid] = {
                        ...s,
                        displayMode: "individual",
                        imageGroupSpaces: [nid]
                    };

                } else {

                    db[sid] = {
                        ...s,
                        imageGroupSpaces: novo
                    };
                }
            }
        }

        writeDB(db);

        registrarLog("espaco_publicado", {
            ids,
            title: title || ""
        });

        res.json({
            ok: true,
            spaces: ids,
            image
        });
    }
);

/* =========================
   LINK DO SITE
   Cadastra/atualiza/remove o
   link do anúncio sem precisar
   trocar a foto
========================= */

app.post("/api/link", (req, res) => {

    try {

        const ids = [
            ...new Set(
                (req.body.ids || []).map(Number)
            )
        ];

        if (!ids.length) {
            return res.status(400).json({
                error: "Nenhum espaço informado."
            });
        }

        if (ids.length > 1000) {
            return res.status(400).json({
                error: "Máximo de 1.000 espaços por bloco."
            });
        }

        const linkInput =
            (req.body.link || "").trim();

        const link =
            linkInput ? normalizarLink(linkInput) : "";

        if (linkInput && !link) {
            return res.status(400).json({
                error:
                    "Link do site inválido. Use um endereço " +
                    "válido, ex: https://seusite.com"
            });
        }

        const token =
            (req.body.orderToken || "").trim();

        if (!token) {
            return res.status(400).json({
                error: "Token de proprietário não informado."
            });
        }

        const db = readDB();

        for (const sid of ids) {

            if (
                !Number.isInteger(sid) ||
                sid < 1 ||
                sid > 1000000
            ) {
                return res.status(400).json({
                    error: `Espaço inválido: ${sid}`
                });
            }

            if (!db[sid]) {
                return res.status(404).json({
                    error:
                        `Espaço não encontrado: ` +
                        `#${sid.toLocaleString("pt-BR")}`
                });
            }

            if (
                db[sid].status !== "paid" &&
                db[sid].status !== "published"
            ) {
                return res.status(403).json({
                    error:
                        `O espaço #${sid.toLocaleString("pt-BR")} ` +
                        `ainda não está publicado.`
                });
            }

            const dono = db[sid].orderToken;

            if (dono && dono !== token) {
                return res.status(403).json({
                    error:
                        `Você não é o proprietário do espaço ` +
                        `#${sid.toLocaleString("pt-BR")}.`
                });
            }
        }

        for (const sid of ids) {

            db[sid] = {
                ...db[sid],
                link: link ? link : undefined
            };
        }

        writeDB(db);

        res.json({
            ok: true,
            spaces: ids,
            link
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* =========================
   PROCESSAR RENOVAÇÃO VIA WEBHOOK
   Quando uma Order de renovação é paga,
   estende a validade do espaço original.
========================= */

async function processarRenovacaoPagamento(mpOrderId, totalCents) {

    if (!pgDisponivel) {
        return false;
    }

    try {

        const result = await pgPool.query(
            `SELECT * FROM transacoes
              WHERE mp_order_id = $1
                AND operation_type = 'renewal'
                AND status = 'pendente'
              LIMIT 1`,
            [mpOrderId]
        );

        const transacao = result.rows[0];

        if (!transacao) {
            return false;
        }

        /* Validação de valor: o pago no MP precisa bater com o
           valor da renovação registrado na transação. */
        if (
            totalCents != null &&
            paraCentavos(transacao.valor_total) !== totalCents
        ) {
            console.error(
                "[MP] VALOR DIVERGENTE na renovação. Renovação NÃO aplicada.",
                {
                    mpOrderId,
                    transacaoId: transacao.id,
                    cobradoCents: paraCentavos(transacao.valor_total),
                    pagoCents: totalCents
                }
            );
            registrarLog("renovacao_valor_divergente", {
                mpOrderId,
                transacaoId: transacao.id,
                cobradoCents: paraCentavos(transacao.valor_total),
                pagoCents: totalCents
            });
            return false;
        }

        const spaceId = Number(transacao.espacos[0]);

        if (!spaceId) {
            return false;
        }

        const db = readDB();
        const space = db[spaceId];

        if (!space) {
            return false;
        }

        const paidAt = new Date();
        const meses =
            transacao.license_duration_months || 12;

        const dataBase =
            space.expiresAt && new Date(space.expiresAt) > paidAt
                ? new Date(space.expiresAt)
                : paidAt;

        db[spaceId] = {
            ...space,
            licensePlan: transacao.license_plan,
            licenseDurationMonths: meses,
            licenseFee: Number(transacao.license_fee) || 0,
            baseAmount: Number(transacao.base_amount) || 0,
            totalAmount: Number(transacao.total_amount) || 0,
            basePricePerBlock:
                Number(transacao.original_base_price_per_block) ||
                BASE_PRICE_PER_BLOCK,
            operationType: "renewal",
            purchasedAt: paidAt.toISOString(),
            expiresAt:
                adicionarMeses(dataBase, meses).toISOString(),
            paidAt: paidAt.toISOString(),
            renewalOrderId: transacao.order_id,
            renewalMpOrderId: mpOrderId
        };

        writeDB(db);

        registrarLog("renovacao_confirmada", {
            mpOrderId,
            spaceId,
            usuarioId: transacao.usuario_id
        });

        return true;

    } catch (error) {
        console.error(
            "ERRO ao processar renovação no webhook:",
            error.message
        );
        return false;
    }
}

/* =========================
   INICIAR SERVIDOR
========================= */

/* [MP WEBHOOK DEBUG] — logging TEMPORÁRIO para identificar a aplicação
   de origem das notificações do Mercado Pago. NÃO registra x-signature,
   secret, nem token de acesso. Remover após o diagnóstico. */
function camposDebugWebhook(req) {
    const ass = String(
        req.headers["x-signature"] ||
        req.headers["X-Signature"] ||
        ""
    );
    const mTs = ass.match(/(?:^|,)\s*ts=([^,]+)/);
    const temV1 = /(?:^|,)\s*v1=([^,]+)/.test(ass);
    return {
        xRequestId: String(
            req.headers["x-request-id"] ||
            req.headers["X-Request-Id"] ||
            ""
        ),
        dataId: String((req.query && req.query["data.id"]) ?? ""),
        dataIdBody: String((req.body && req.body.data && req.body.data.id) ?? ""),
        queryType: String((req.query && req.query.type) ?? ""),
        queryAction: String((req.query && req.query.action) ?? ""),
        action: String((req.body && req.body.action) ?? ""),
        applicationId: String((req.body && req.body.application_id) ?? ""),
        liveMode: String((req.body && req.body.live_mode) ?? ""),
        temTs: !!mTs,
        temV1,
        secretLength: MERCADOPAGO_WEBHOOK_SECRET
            ? String(MERCADOPAGO_WEBHOOK_SECRET).length
            : 0,
        timestamp: mTs ? mTs[1].trim() : new Date().toISOString()
    };
}

/* [MP WEBHOOK DIAGNOSTICO] — TEMPORÁRIO. Executado apenas quando a
   validação manual falha. Recalcula o HMAC com o MESMO segredo configurado
   em várias variantes do manifesto e registra APENAS quais coincidem com o
   v1 recebido (booleans). NUNCA loga o segredo, o x-signature completo, o
   v1 nem o HMAC calculado. Finalidade: distinguir entre (a) segredo
   divergente e (b) case do data.id no manifesto (o MP entrega ORD... em
   MAIÚSCULO mas assina o manifesto com o data.id em MINÚSCULO). Remover
   após o diagnóstico. */
function diagnosticarAssinaturaWebhook(req) {
    try {
        const lixo = (valor) => {
            if (valor === undefined || valor === null) return "";
            const bruto = Array.isArray(valor) ? valor[0] : valor;
            return String(bruto).trim();
        };
        const ass = lixo(req.headers["x-signature"]);
        const rid = lixo(req.headers["x-request-id"]);
        const query = req.query || {};
        const dataId = lixo(query["data.id"]);
        const mTs = ass.match(/(?:^|,)\s*ts=([^,]+)/);
        const mV1 = ass.match(/(?:^|,)\s*v1=([^,]+)/);
        const ts = mTs ? mTs[1].trim() : "";
        const v1 = mV1 ? mV1[1].trim() : "";
        const secret = MERCADOPAGO_WEBHOOK_SECRET || "";

        const calc = (manifest) =>
            crypto.createHmac("sha256", secret).update(manifest).digest("hex");

        const montar = (id) => {
            const partes = [];
            if (id) partes.push("id:" + id);
            if (rid) partes.push("request-id:" + rid);
            partes.push("ts:" + ts);
            return partes.join(";") + ";";
        };

        const manifestAsIs = montar(dataId);
        const manifestLowerId = montar(dataId.toLowerCase());
        const manifestLowerTudo = dataId || rid
            ? "id:" + dataId.toLowerCase() + ";request-id:" + rid.toLowerCase() + ";ts:" + ts + ";"
            : "ts:" + ts + ";";

        const igual = (esperado) =>
            v1 && Buffer.byteLength(esperado) === Buffer.byteLength(v1) &&
            crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(v1));

        console.warn("[MP WEBHOOK DIAGNOSTICO]", {
            xSignaturePresente: !!ass,
            temTs: !!ts,
            temV1: !!v1,
            v1Tamanho: v1 ? v1.length : 0,
            xRequestIdPresente: !!rid,
            dataIdQueryPresente: !!dataId,
            dataIdBodyPresente: !!((req.body && req.body.data && req.body.data.id)),
            queryChaves: Object.keys(query),
            dataId: dataId || "(ausente)",
            xRequestId: rid || "(ausente)",
            timestamp: ts || "(ausente)",
            secretConfigurado: !!secret,
            secretLength: secret ? String(secret).length : 0,
            manifestoUsado: manifestAsIs,
            bateComoVeio: igual(calc(manifestAsIs)),
            bateMinusculoId: igual(calc(manifestLowerId)),
            bateMinusculoTudo: igual(calc(manifestLowerTudo))
        });
    } catch (e) {
        console.warn("[MP WEBHOOK DIAGNOSTICO] erro:", e.message);
    }
}

app.post("/webhooks/mercadopago", async (req, res) => {

    /* Validação obrigatória da assinatura do Mercado Pago. */
    if (!validarAssinaturaWebhook(req)) {
        console.warn("[MP WEBHOOK DEBUG] INVALID", camposDebugWebhook(req));
        diagnosticarAssinaturaWebhook(req);
        console.warn("Webhook Mercado Pago rejeitado: assinatura inválida.");
        return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("[MP WEBHOOK DEBUG] VALID", camposDebugWebhook(req));

    const evento = req.body || {};
    const query = req.query || {};

    const dataIdQuery = String(
        query["data.id"] ??
        query.data?.id ??
        query["data_id"] ??
        query.id ??
        ""
    ).trim();

    const dataIdCorpo = String(
        (evento.data && evento.data.id) || ""
    ).trim();

    const dataIdWebhook = dataIdQuery || dataIdCorpo;
    const tipoEvento = String(query.type || evento.type || "");

    console.log("Webhook Mercado Pago recebido:", {
        type: tipoEvento,
        action: evento.action,
        orderId: dataIdWebhook
    });

    /* Processamos apenas notificações de Order. */
    if (tipoEvento !== "order" || !dataIdWebhook) {
        return res.status(200).json({ received: true });
    }

    /* Guarda de formato de Order ID. As Orders reais do Mercado Pago têm
       IDs gerados pela API no formato "ORD..." — alfanuméricos, sem
       comprimento/caracteres previsíveis além do próprio prefixo ORD
       (ex.: ORD01M0253SXFMB7N4T2RWDYKANH, ORD01JQ4S4KY8HWQ6NA5PXB65B3D3).
       O teste manual do painel do MP usa data.id fictício SEM o prefixo
       ORD ("123456", "5555"), que NÃO pode ser consultado na API (gera
       "path param order id is invalid"). Aqui identificamos a
       simulação/teste (sem prefixo ORD) e encerramos com 200 sem
       consultar. Não restringimos comprimento/caracteres além de
       alfanumérico: o HMAC já foi validado acima e a Order é sempre
       reconsultada na API — essas são as proteções reais, não uma regex. */
    if (!/^ORD[A-Z0-9]+$/i.test(dataIdWebhook)) {
        console.log(
            "Webhook Mercado Pago: identificador sem formato de Order real " +
            "(simulação/teste). Encerrando sem consultar a API.",
            { orderId: dataIdWebhook, type: tipoEvento }
        );
        return res.status(200).json({ received: true, simulation: true });
    }

    try {

        const orderId = dataIdWebhook;

        /* Sempre consultamos a Order na API do Mercado Pago.
           Nunca confiamos apenas no payload recebido. */
        const order = await consultarOrderMercadoPago(orderId);

        /* external_reference: eco do que enviamos no checkout (o orderId
           interno, ex.: MEGA-...). Usado como vínculo definitivo entre o
           pagamento real e o pedido — nunca confiamos só no id do webhook. */
        const externalReference = String(order.external_reference || "").trim();

        console.log("Order consultada:", order.id, order.status);

        /* Só liberamos espaços se a Order estiver efetivamente paga. */
        if (!statusOrderPago(order.status)) {

            if (statusOrderRejeitada(order.status)) {
                liberarEspacosRejeitados(orderId, order.status, externalReference);
            } else {
                console.log(`Order ${orderId} não está paga. Status: ${order.status}`);
            }

            return res.status(200).json({ received: true });
        }

        const dados = extrairDadosPagamento(order);
        const totalPagoCents = paraCentavos(order.total_amount);
        const db = readDB();

        /* Vínculo de ordem: o pagamento consultado pertence ao pedido
           correto? O external_reference do MP precisa bater com o orderId
           interno dos espaços reservados. Se divergir, NÃO libera. */
        const refsDivergentes =
            referenciasExternasDivergentes(orderId, externalReference, db);

        if (refsDivergentes.length) {
            console.error(
                "[MP] external_reference DIVERGENTE. Espaços NÃO liberados.",
                { mpOrderId: orderId, externalReference, refsDivergentes }
            );
            registrarLog("pagamento_external_reference_divergente", {
                mpOrderId: orderId,
                externalReference,
                refsDivergentes
            });
            return res.status(200).json({
                received: true,
                externalReferenceDivergencia: true
            });
        }

        /* Validação de valor: o total pago na Order do Mercado Pago
           precisa bater com o valor efetivamente cobrado no checkout.
           Reservas antigas (sem chargedAmountCents) não são bloqueadas. */
        const divergentes = [];

        for (const id of Object.keys(db)) {
            const space = db[id];
            if (
                space.mpOrderId === orderId &&
                space.status === "reserved" &&
                space.chargedAmountCents != null &&
                space.chargedAmountCents !== totalPagoCents
            ) {
                divergentes.push({
                    espaco: id,
                    cobradoCents: space.chargedAmountCents,
                    pagoCents: totalPagoCents
                });
            }
        }

        if (divergentes.length) {
            console.error(
                "[MP] VALOR DIVERGENTE entre o cobrado e o pago. " +
                "Espaços NÃO liberados.",
                { mpOrderId: orderId, totalPagoCents, divergentes }
            );
            registrarLog("pagamento_valor_divergente", {
                mpOrderId: orderId,
                totalPagoCents,
                divergentes
            });
            return res.status(200).json({ received: true, divergencia: true });
        }

        /* Liberação idempotente: só altera espaços reservados. */
        let alterado = false;
        const paidAt = new Date();

        for (const id of Object.keys(db)) {
            const space = db[id];

            if (
                space.mpOrderId === orderId &&
                space.status === "reserved" &&
                (!externalReference || space.orderId === externalReference)
            ) {
                const months =
                    space.licenseDurationMonths || 12;

                db[id] = {
                    ...space,
                    status: "paid",
                    paidAt: paidAt.toISOString(),
                    purchasedAt: paidAt.toISOString(),
                    expiresAt:
                        adicionarMeses(paidAt, months)
                            .toISOString()
                };

                alterado = true;
            }
        }

        confirmarPagamentoOferta(orderId);
        pgPagamentoPago({ mpOrderId: orderId });
        await processarRenovacaoPagamento(orderId, totalPagoCents);

        /* Pagamentos do módulo de colecionáveis (pacotes, compras
           no mercado e diferenças de troca). Independente e
           idempotente — só processa pedidos pendentes. */
        try {
            if (typeof colecionaveis?.processarPagamento === "function") {
                await colecionaveis.processarPagamento({ mpOrderId: orderId, totalCents: totalPagoCents });
            }
        } catch (eColecionaveis) {
            console.error(
                "ERRO ao processar pagamento de colecionáveis:",
                eColecionaveis.message
            );
        }

        /* Pagamentos do módulo de Combos & Kits. Idempotente —
           só processa pedidos pendentes, sem entregar em dobro. */
        try {
            if (typeof combos?.processarPagamento === "function") {
                await combos.processarPagamento({ mpOrderId: orderId, totalCents: totalPagoCents });
            }
        } catch (eCombos) {
            console.error(
                "ERRO ao processar pagamento de combos/kits:",
                eCombos.message
            );
        }

        registrarLog("pagamento_confirmado_webhook", {
            mpOrderId: orderId,
            paymentId: dados.paymentId,
            status: order.status
        });

        /* Pagamento tardio: o espaço foi liberado
           por tempo esgotado. Se ainda estiver livre,
           entrega ele ao pagante de qualquer forma. */

        const liberadas = readReservasLiberadas();
        const antiga = liberadas[orderId];

        if (
            antiga &&
            !db[antiga.id] &&
            (!externalReference || antiga.orderId === externalReference)
        ) {

            db[antiga.id] = {
                ...antiga,
                status: "paid",
                paidAt: new Date().toISOString()
            };

            delete liberadas[orderId];
            writeReservasLiberadas(liberadas);

            alterado = true;

            registrarLog(
                "pagamento_tardio_restaurado",
                {
                    mpOrderId: orderId,
                    bloco: antiga.id
                }
            );

            console.log(
                `Pagamento tardio ${orderId}: ` +
                `espaço #${antiga.id} entregue ao comprador.`
            );
        }

        if (alterado) {
            writeDB(db);
            console.log(
                `Order ${orderId} confirmada. Espaços liberados.`
            );
        }

    } catch (error) {
        console.error(
            "Erro ao processar webhook Mercado Pago:",
            error.message
        );
    }

    return res.status(200).json({
        received: true
    });
});

/* =========================
   PAINEL DO ADMINISTRADOR
   Controle total do site.
========================= */

app.post("/api/admin/login", (req, res) => {

    const adminUser = process.env.ADMIN_USER || "";
    const adminPass = process.env.ADMIN_PASSWORD || "";

    if (!adminUser || !adminPass) {
        return res.status(503).json({
            error:
                "Admin não configurado. Defina ADMIN_USER e " +
                "ADMIN_PASSWORD nas variáveis de ambiente."
        });
    }

    const { usuario, senha } = req.body;

    const a = Buffer.from(String(usuario || ""), "utf8");
    const b = Buffer.from(adminUser, "utf8");

    const c = Buffer.from(String(senha || ""), "utf8");
    const d = Buffer.from(adminPass, "utf8");

    const okUser =
        a.length === b.length &&
        crypto.timingSafeEqual(a, b);

    const okPass =
        c.length === d.length &&
        crypto.timingSafeEqual(c, d);

    if (!okUser || !okPass) {
        registrarLog("admin_login_negado");
        return res.status(401).json({
            error: "Credenciais de administrador inválidas."
        });
    }

    const fp = crypto.createHash("sha256")
        .update(adminPass)
        .digest("hex");

    registrarLog("admin_login");

    res.json({
        ok: true,
        token: gerarTokenJwt({
            role: "admin",
            usuario: adminUser,
            fp
        })
    });
});

app.get("/api/admin/resumo", authAdmin, (req, res) => {

    const db = readDB();

    const espacos = Object.values(db);

    const porStatus = {};

    let sold = 0;
    let reserved = 0;
    let revenue = 0;

    for (const s of espacos) {
        porStatus[s.status] = (porStatus[s.status] || 0) + 1;

        if (
            s.status === "published" ||
            s.status === "paid"
        ) {
            sold++;
        }

        if (s.status === "reserved") {
            reserved++;
        }
    }

        res.json({
            ok: true,
            espacosTotal: espacos.length,
            disponiveis: 1000000 - espacos.length,
            sold,
            reserved,
            porStatus,
            valorEspaco: 1,
            receitaPotencial: sold,
            mercadoPagoModo: MERCADOPAGO_SANDBOX ? "sandbox" : "producao"
        });
});

app.get("/api/admin/spaces", authAdmin, (req, res) => {

    const db = readDB();

    const busca =
        String(req.query.busca || "")
            .trim()
            .toLowerCase();

    const status =
        String(req.query.status || "")
            .trim();

    const limite =
        req.query.all === "1"
            ? Infinity
            : Math.min(
                  500,
                  Number(req.query.limite || 200)
              );

    let lista = Object.values(db);

    if (status) {
        lista = lista.filter(s => s.status === status);
    }

    if (busca) {
        lista = lista.filter(s =>
            String(s.id).includes(busca) ||
            String(s.name || "").toLowerCase().includes(busca) ||
            String(s.email || "").toLowerCase().includes(busca) ||
            String(s.title || "").toLowerCase().includes(busca) ||
            String(s.orderId || "").toLowerCase().includes(busca) ||
            String(s.orderToken || "").toLowerCase().includes(busca) ||
            String(s.accessCode || "").toLowerCase().includes(busca)
        );
    }

    lista.sort((a, b) => Number(a.id) - Number(b.id));

    const total = lista.length;

    lista = lista.slice(0, limite);

    res.json({
        ok: true,
        total,
        espacos: lista
    });
});

app.post("/api/admin/spaces/bulk-delete", authAdmin, (req, res) => {

    const raw = req.body && req.body.ids;

    const lista = Array.isArray(raw)
        ? raw
        : String(raw || "")
            .split(/[,\s]+/)
            .filter(Boolean);

    const ids = [...new Set(
        lista
            .map(id => String(id).replace(/\D/g, ""))
            .filter(Boolean)
            .map(Number)
            .filter(n =>
                Number.isInteger(n) &&
                n >= 1 &&
                n <= 1000000
            )
    )];

    if (!ids.length) {
        return res.status(400).json({
            error: "Nenhum espaço válido informado."
        });
    }

    if (ids.length > 50000) {
        return res.status(400).json({
            error: "Máximo de 50.000 espaços por lote."
        });
    }

    const db = readDB();
    const idsSet = new Set(ids);
    let removidos = 0;

    for (const id of ids) {
        if (db[id]) {
            delete db[id];
            removidos++;
        }
    }

    if (removidos === 0) {
        return res.json({
            ok: true,
            removidos: 0,
            informados: ids.length
        });
    }

    writeDB(db);

    /* Remove reservas liberadas pendentes desses blocos,
       para o pagamento tardio não devolvê-los depois. */
    const liberadas = readReservasLiberadas();
    let alteradoLib = false;

    for (const [paymentId, s] of Object.entries(liberadas)) {
        if (idsSet.has(s.id)) {
            delete liberadas[paymentId];
            alteradoLib = true;
        }
    }

    if (alteradoLib) {
        writeReservasLiberadas(liberadas);
    }

    registrarLog("admin_spaces_removidos_lote", {
        qtd: removidos,
        ids: ids.slice(0, 200)
    });

    console.log(
        `[ADMIN] ${removidos} espaço(s) apagados em lote.`
    );

    res.json({
        ok: true,
        removidos,
        informados: ids.length
    });
});

app.post("/api/admin/spaces/:id", authAdmin, (req, res) => {

    const id = String(req.params.id || "")
        .replace(/\D/g, "");

    if (!id) {
        return res.status(400).json({
            error: "Espaço inválido."
        });
    }

    const db = readDB();

    const espaco = db[id];

    if (!espaco) {
        return res.status(404).json({
            error: "Espaço não encontrado."
        });
    }

    const campos = [
        "status",
        "title",
        "link",
        "image",
        "name",
        "email"
    ];

    let alterado = false;

    for (const campo of campos) {
        if (req.body[campo] !== undefined) {
            espaco[campo] = req.body[campo];
            alterado = true;
        }
    }

    if (!alterado) {
        return res.status(400).json({
            error: "Nenhum campo enviado para edição."
        });
    }

    writeDB(db);

    registrarLog("admin_space_editado", {
        id: Number(id),
        campos: campos.filter(c => req.body[c] !== undefined)
    });

    res.json({ ok: true, espaco });
});

app.delete("/api/admin/spaces/:id", authAdmin, (req, res) => {

    const id = String(req.params.id || "")
        .replace(/\D/g, "");

    const db = readDB();

    if (!db[id]) {
        return res.status(404).json({
            error: "Espaço não encontrado."
        });
    }

    delete db[id];

    writeDB(db);

    registrarLog("admin_space_removido", { id: Number(id) });

    res.json({ ok: true });
});

const TEMPLATE_NOTAS_ADMIN = `# 📋 Referência do site — Milhão Door

Preencha com as informações de cada serviço e salve.

## 🚀 Hospedagem
- Plataforma: (ex: Render)
- URL do site:
- Painel da hospedagem:
- Usuário:
- Senha:

## ☁️ Render
- Dashboard: https://dashboard.render.com
- Nome do serviço:
- Região:
- Build: npm install | Start: node server.js
- Disco persistente: /var/lib/megaoutdoor (DADOS, UPLOADS)
- Variáveis: DATA_DIR, UPLOAD_DIR, MERCADOPAGO_ACCESS_TOKEN,
  MERCADOPAGO_PUBLIC_KEY, MERCADOPAGO_SANDBOX, MERCADOPAGO_WEBHOOK_URL,
  MERCADOPAGO_WEBHOOK_SECRET, RESEND_API_KEY, JWT_SECRET, ADMIN_USER,
  ADMIN_PASSWORD, DATABASE_URL, RESERVA_TTL_MINUTOS

## 📧 Resend (e-mails)
- Dashboard: https://resend.com
- API Key:
- Domínio verificado:
- E-mails: compra, código de acesso, ofertas, sorteio, recuperação

## 💳 Mercado Pago (pagamentos PIX e cartão)
- Dashboard: https://www.mercadopago.com.br/developers
- Access Token: configurar em MERCADOPAGO_ACCESS_TOKEN
- Public Key: configurar em MERCADOPAGO_PUBLIC_KEY (frontend)
- Webhook Secret: configurar em MERCADOPAGO_WEBHOOK_SECRET
- Webhook URL: configurar /webhooks/mercadopago no dashboard
- AppID:
- Modo sandbox / produção:

## 🗄️ Banco de dados
- Provedor:
- DATABASE_URL:
- (guarda o histórico de transações / extrato)

## 🔐 Admin do site
- URL: https://SEUSITE/admin.html
- Usuário:
- Senha:

## 📂 Outros / anotações
-
`;

app.get("/api/admin/notas", authAdmin, (req, res) => {

    const data = readJsonFile(ADMIN_NOTES_FILE, null);

    if (!data) {
        return res.json({
            ok: true,
            saved: false,
            content: TEMPLATE_NOTAS_ADMIN,
            updatedAt: null
        });
    }

    res.json({
        ok: true,
        saved: true,
        content: data.content || "",
        updatedAt: data.updatedAt || null
    });
});

app.get("/api/admin/notas/modelo", authAdmin, (req, res) => {
    res.json({
        ok: true,
        content: TEMPLATE_NOTAS_ADMIN
    });
});

app.post("/api/admin/notas", authAdmin, (req, res) => {

    const content =
        typeof req.body?.content === "string"
            ? req.body.content
            : "";

    if (content.length > 50000) {
        return res.status(400).json({
            error: "Texto muito longo (máx. 50.000 caracteres)."
        });
    }

    const updatedAt = new Date().toISOString();

    writeJsonFile(ADMIN_NOTES_FILE, {
        content,
        updatedAt
    });

    registrarLog("admin_notas_salvas");

    res.json({ ok: true, updatedAt });
});

app.get("/api/admin/transacoes", authAdmin, async (req, res) => {

    if (!pgDisponivel) {
        return res.status(503).json({
            error: "Banco de dados não configurado."
        });
    }

    try {

        const busca =
            String(req.query.busca || "").trim();

        const tipo =
            String(req.query.tipo || "").trim();

        const status =
            String(req.query.status || "").trim();

        const limite = Math.min(500, Number(req.query.limite || 200));

        const params = [];
        const clausulas = [];

        if (tipo) {
            params.push(tipo);
            clausulas.push(`tipo = $${params.length}`);
        }

        if (status) {
            params.push(status);
            clausulas.push(`status = $${params.length}`);
        }

        if (busca) {
            params.push(`%${busca}%`);
            const p = params.length;
            clausulas.push(
                `(order_id ILIKE $${p} OR nome ILIKE $${p} ` +
                `OR email ILIKE $${p} OR access_code ILIKE $${p} ` +
                `OR CAST(espacos AS TEXT) ILIKE $${p})`
            );
        }

        const where =
            clausulas.length
            ? "WHERE " + clausulas.join(" AND ")
            : "";

        const result = await pgPool.query(
            `SELECT id, tipo, access_code, token, order_id,
                    customer_id, payment_id, usuario_id,
                    nome, email, espacos, quantidade,
                    valor_total, comissao, status, test,
                    criado_em, pago_em
               FROM transacoes
              ${where}
              ORDER BY criado_em DESC
              LIMIT ${limite}`,
            params
        );

        res.json({
            ok: true,
            total: result.rows.length,
            transacoes: result.rows.map(r => ({
                id: r.id,
                tipo: r.tipo,
                accessCode: r.access_code,
                orderId: r.order_id,
                customerId: r.customer_id,
                paymentId: r.payment_id,
                usuarioId: r.usuario_id,
                nome: r.nome,
                email: r.email,
                espacos: r.espacos,
                quantidade: r.quantidade,
                valorTotal: Number(r.valor_total),
                comissao: Number(r.comissao),
                status: r.status,
                test: r.test,
                criadoEm: r.criado_em,
                pagoEm: r.pago_em
            }))
        });

    } catch (error) {
        console.error("ERRO admin/transacoes:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/admin/usuarios", authAdmin, async (req, res) => {

    if (!pgDisponivel) {
        return res.status(503).json({
            error: "Banco de dados não configurado."
        });
    }

    try {

        const result = await pgPool.query(
            `SELECT u.id, u.nome, u.email, u.criado_em,
                    u.ultimo_login,
                    (SELECT COUNT(*) FROM usuario_chaves c
                      WHERE c.usuario_id = u.id) AS chaves,
                    (SELECT COUNT(*) FROM transacoes t
                      WHERE t.usuario_id = u.id) AS transacoes
               FROM usuarios u
              ORDER BY u.id DESC
              LIMIT 500`
        );

        res.json({
            ok: true,
            total: result.rows.length,
            usuarios: result.rows.map(u => ({
                id: u.id,
                nome: u.nome,
                email: u.email,
                criadoEm: u.criado_em,
                ultimoLogin: u.ultimo_login,
                chaves: Number(u.chaves),
                transacoes: Number(u.transacoes)
            }))
        });

    } catch (error) {
        console.error("ERRO admin/usuarios:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/admin/logs", authAdmin, (req, res) => {

    const evento =
        String(req.query.evento || "").trim();

    const busca =
        String(req.query.busca || "")
            .trim()
            .toLowerCase();

    const limite = Math.min(500, Number(req.query.limite || 200));
    const offset = Math.max(0, Number(req.query.offset || 0));

    let linhas = [];

    try {
        if (fs.existsSync(LOGS_FILE)) {
            const conteudo = fs.readFileSync(LOGS_FILE, "utf8");

            linhas = conteudo
                .split("\n")
                .filter(Boolean)
                .map(l => {
                    try {
                        return JSON.parse(l);
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);
        }
    } catch (error) {
        console.error("ERRO ao ler logs:", error.message);
    }

    linhas.reverse();

    if (evento) {
        linhas = linhas.filter(l => l.evento === evento);
    }

    if (busca) {
        linhas = linhas.filter(l =>
            JSON.stringify(l).toLowerCase().includes(busca)
        );
    }

    const total = linhas.length;

    linhas = linhas.slice(offset, offset + limite);

    res.json({
        ok: true,
        total,
        logs: linhas
    });
});

app.delete("/api/admin/logs", authAdmin, (req, res) => {

    try {
        fs.writeFileSync(LOGS_FILE, "", "utf8");
        registrarLog("admin_logs_limpos");
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/admin/cupons", authAdmin, (req, res) => {

    const cupons = readCoupons();

    res.json({
        ok: true,
        total: Object.keys(cupons).length,
        cupons: Object.values(cupons)
            .sort((a, b) =>
                String(b.createdAt || "")
                    .localeCompare(String(a.createdAt || ""))
            )
    });
});

app.post("/api/admin/cupons", authAdmin, (req, res) => {

    const {
        codigo,
        discountPercent,
        maxUses,
        active
    } = req.body;

    const nome = String(codigo || "")
        .trim()
        .toUpperCase();

    if (!nome) {
        return res.status(400).json({
            error: "Informe o código do cupom."
        });
    }

    const pct = Number(discountPercent);

    if (
        !Number.isFinite(pct) ||
        pct <= 0 ||
        pct >= 100
    ) {
        return res.status(400).json({
            error: "Desconto deve estar entre 1% e 99%."
        });
    }

    const cupons = readCoupons();

    const existente = cupons[nome] || {};

    cupons[nome] = {
        codigo: nome,
        tipo: existente.tipo || "promocao",
        ownerName: existente.ownerName || "Admin",
        ownerEmail: existente.ownerEmail || "",
        ownerOrderId: existente.ownerOrderId || "ADMIN",
        discountPercent: pct,
        used: existente.used || 0,
        credits: existente.credits || 0,
        maxUses:
            maxUses !== undefined
            ? Math.max(1, Number(maxUses))
            : (existente.maxUses || 100),
        active: active !== undefined ? !!active : true,
        createdAt: existente.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    writeCoupons(cupons);

    registrarLog("admin_cupom_salvo", { codigo: nome, pct });

    res.json({ ok: true, cupom: cupons[nome] });
});

app.delete("/api/admin/cupons/:codigo", authAdmin, (req, res) => {

    const nome = String(req.params.codigo || "")
        .trim()
        .toUpperCase();

    const cupons = readCoupons();

    if (!cupons[nome]) {
        return res.status(404).json({
            error: "Cupom não encontrado."
        });
    }

    delete cupons[nome];

    writeCoupons(cupons);

    registrarLog("admin_cupom_removido", { codigo: nome });

    res.json({ ok: true });
});

/* =========================
   SORTEIO SEMANAL
========================= */

app.get("/api/sorteio", (req, res) => {

    const s = readSorteios();
    const participantes = blocosParticipantesSorteio();

    const emails = new Set(
        participantes.map(b => b.email.trim().toLowerCase())
    );

    const ultimoGanhador = (s.historico || [])[0] || null;

    if (ultimoGanhador) {
        delete ultimoGanhador.email;
    }

    res.json({
        ok: true,
        aviso: s.aviso || null,
        ultimoGanhador,
        totalParticipantes: emails.size,
        totalBilhetes: participantes.length
    });
});

app.get("/api/admin/sorteio", authAdmin, (req, res) => {

    const s = readSorteios();
    const participantes = blocosParticipantesSorteio();

    const emails = new Set(
        participantes.map(b => b.email.trim().toLowerCase())
    );

    res.json({
        ok: true,
        aviso: s.aviso || null,
        historico: s.historico || [],
        totalParticipantes: emails.size,
        totalBilhetes: participantes.length
    });
});

app.post("/api/admin/sorteio/sortear", authAdmin, async (req, res) => {

    const valor = String(req.body.valor || "").trim();

    if (!valor) {
        return res.status(400).json({
            error: "Informe o valor do prêmio do sorteio."
        });
    }

    const participantes = blocosParticipantesSorteio();

    if (participantes.length === 0) {
        return res.status(400).json({
            error: "Nenhum bloco participante disponível."
        });
    }

    const vencedor =
        participantes[Math.floor(
            Math.random() * participantes.length
        )];

    const s = readSorteios();
    s.historico = s.historico || [];
    s.aviso = null;

    const registro = {
        id:
            "SOR-" +
            Date.now().toString(36).toUpperCase(),
        sorteadoEm: new Date().toISOString(),
        valor,
        bloco: vencedor.id,
        dono: vencedor.name || "—",
        email: vencedor.email || "",
        totalBilhetes: participantes.length,
        totalParticipantes: new Set(
            participantes.map(b => b.email.trim().toLowerCase())
        ).size
    };

    s.historico.unshift(registro);

    writeSorteios(s);

    registrarLog("sorteio_realizado", {
        bloco: vencedor.id,
        email: vencedor.email,
        valor
    });

    res.json({ ok: true, registro });
});

app.post("/api/admin/sorteio/aviso", authAdmin, async (req, res) => {

    const valor = String(req.body.valor || "").trim();
    const mensagem =
        String(req.body.mensagem || "").trim();

    if (!valor) {
        return res.status(400).json({
            error: "Informe o valor do prêmio do aviso."
        });
    }

    const s = readSorteios();

    s.aviso = {
        valor,
        mensagem:
            mensagem ||
            "Sorteio de valor em blocos do Mega Outdoor!",
        avisadoEm: new Date().toISOString(),
        enviados: 0
    };

    const participantes = blocosParticipantesSorteio();

    const emails = [
        ...new Set(
            participantes.map(b => b.email.trim().toLowerCase())
        )
    ];

    let enviados = 0;

    for (const email of emails) {

        const ok = await enviarEmail(
            email,
            "🎲 Sorteio de " + valor +
                " no Mega Outdoor!",
            gerarHtmlAvisoSorteio(
                valor,
                s.aviso.mensagem,
                email
            )
        );

        if (ok) enviados++;
    }

    s.aviso.enviados = enviados;

    writeSorteios(s);

    registrarLog("sorteio_aviso", {
        valor,
        destinatarios: emails.length,
        enviados
    });

    res.json({
        ok: true,
        aviso: s.aviso,
        destinatarios: emails.length,
        enviados
    });
});

app.delete("/api/admin/sorteio/aviso", authAdmin, (req, res) => {

    const s = readSorteios();
    s.aviso = null;
    writeSorteios(s);

    registrarLog("sorteio_aviso_removido", {});

    res.json({ ok: true });
});

app.delete("/api/admin/sorteio", authAdmin, (req, res) => {

    const s = readSorteios();
    s.historico = s.historico || [];

    if (s.historico.length === 0) {
        return res.status(404).json({
            error: "Nenhum sorteio no histórico."
        });
    }

    const removido = s.historico.shift();

    writeSorteios(s);

    registrarLog("sorteio_removido", {
        id: removido.id,
        bloco: removido.bloco
    });

    res.json({ ok: true });
});

function gerarHtmlAvisoSorteio(valor, mensagem, email) {
    return (
        "<div style='font-family:Arial,Helvetica,sans-serif;" +
        "max-width:600px;margin:0 auto;padding:20px;" +
        "background:#111;color:#eee;border-radius:8px;'>" +
        "<h2 style='color:#ffd400;margin-top:0;'>🎲 " +
        "Sorteio " + valor + "</h2>" +
        "<p style='font-size:16px;line-height:1.6;'>" +
        mensagem.replace(/</g, "&lt;") +
        "</p>" +
        "<p style='font-size:15px;line-height:1.6;'>" +
        "Cada bloco comprado vale <b>1 bilhete</b> no " +
        "sorteio. Quanto mais blocos, mais chances! " +
        "Boa sorte!</p>" +
        "<hr style='border-color:#333;'>" +
        "<p style='font-size:13px;color:#888;'>" +
        "Você está recebendo este e-mail por ter blocos " +
        "ativos no Mega Outdoor (" + email + ").</p>" +
        "</div>"
    );
}

/* =========================
   MEGAOUTDOOR COLECIONÁVEIS
   Módulo independente de figurinhas digitais.
   Montado em /api/colecionaveis sem alterar os fluxos
   existentes de espaços, pagamentos, chat, login ou regras.
========================= */

const criarColecionaveis = require("./colecionaveis.js");

const colecionaveis = criarColecionaveis({
    express,
    authUsuario,
    authAdmin,
    criarOrderMercadoPago,
    consultarOrderMercadoPago,
    extrairDadosPagamento,
    statusOrderPago,
    paraCentavos,
    registrarLog,
    obterPool: () => pgPool,
    obterPgDisponivel: () => pgDisponivel,
    obterAuthUsuario: () => authUsuario,
    normalizarDadosComprador,
    validarDocumento,
    formatarErroPagamento
});

app.use("/api/colecionaveis", limiterLeitura);

app.use("/api/colecionaveis", colecionaveis.router);

/* =========================
   COMBOS & KITS
   Módulo de Combos & Kits (pacotes de espaços + figurinhas +
   licença). Tabelas `kits` e `kit_compras`. processarPagamento
   é chamado no webhook, no polling e no polling de colecionáveis.
========================= */

const criarCombos = require("./combos.js");

const combos = criarCombos({
    express,
    authUsuario,
    authAdmin,
    criarOrderMercadoPago,
    consultarOrderMercadoPago,
    statusOrderPago,
    paraCentavos,
    registrarLog,
    obterPool: () => pgPool,
    obterPgDisponivel: () => pgDisponivel,
    obterAuthUsuario: () => authUsuario,
    readDB,
    writeDB,
    registrarTransacao,
    salvarChaveUsuario,
    gerarToken,
    gerarAccessCode,
    obterColecionaveis: () => colecionaveis,
    normalizarDadosComprador,
    validarDocumento,
    formatarErroPagamento
});

app.use("/api/combos", limiterLeitura);

app.use("/api/combos", combos.router);

/* =========================
   BUGS & SUGESTÕES
   Relatos enviados pelo site (botão BUG/SUGESTÃO). O admin
   acompanha e atualiza o status no painel.
========================= */

const TIPOS_BUG = [
    "bug",
    "sugestao",
    "pagamento",
    "outro"
];

const STATUS_BUG = [
    "novo",
    "em_analise",
    "em_desenvolvimento",
    "resolvido",
    "arquivado"
];

/* Envio público de um relato. authOpcional: preenche o usuário
   automaticamente quando logado, mas aceita anônimos. */
app.post(
    "/api/bugs",
    limiterBugs,
    authOpcional,
    async (req, res) => {
        try {
            const tipo = String(req.body.tipo || "").trim().toLowerCase();
            if (!TIPOS_BUG.includes(tipo)) {
                return res.status(400).json({ error: "Tipo de relato inválido." });
            }

            const assunto = String(req.body.assunto || "").trim();
            if (!assunto || assunto.length < 3 || assunto.length > 120) {
                return res.status(400).json({ error: "Assunto deve ter entre 3 e 120 caracteres." });
            }

            const descricao = String(req.body.descricao || "").trim();
            if (!descricao || descricao.length < 10 || descricao.length > 5000) {
                return res.status(400).json({ error: "Descreva o relato com pelo menos 10 caracteres (máx. 5000)." });
            }

            const email = String(req.body.email || "").trim().toLowerCase();
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ error: "E-mail inválido." });
            }

            const pagina = String(req.body.pagina || "").trim();
            const espaco = Number(req.body.espaco);
            const usuarioId = req.usuario ? req.usuario.id : null;

            if (!pgDisponivel) {
                return res.status(503).json({ error: "Sistema de relatos indisponível no momento." });
            }

            const r = await pgPool.query(
                `INSERT INTO bugs_sugestoes
                    (tipo, assunto, descricao, pagina, espaco, email,
                     usuario_id, anexo_url, status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'novo')
                 RETURNING id`,
                [
                    tipo,
                    assunto,
                    descricao,
                    pagina || null,
                    Number.isInteger(espaco) && espaco > 0 ? espaco : null,
                    email || (req.usuario ? req.usuario.email : null),
                    usuarioId,
                    req.body.anexoUrl || null
                ]
            );

            registrarLog("bug_sugestao_recebida", {
                bugId: r.rows[0].id,
                tipo,
                usuarioId
            });

            res.json({
                ok: true,
                id: r.rows[0].id,
                message: "Obrigado! Seu relato foi enviado para nossa equipe."
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
);

/* Admin: listar relatos com filtro por status. */
app.get("/api/admin/bugs", authAdmin, async (req, res) => {
    try {
        if (!pgDisponivel) {
            return res.status(503).json({ error: "Banco de dados indisponível." });
        }

        const status = String(req.query.status || "").trim();
        let where = "";
        const params = [];

        if (status) {
            if (!STATUS_BUG.includes(status)) {
                return res.status(400).json({ error: "Status inválido." });
            }
            params.push(status);
            where = `WHERE status = $${params.length}`;
        }

        const limite = Math.min(500, Number(req.query.limite || 200));

        const r = await pgPool.query(
            `SELECT b.id, b.tipo, b.assunto, b.descricao, b.pagina,
                    b.espaco, b.email, b.usuario_id, b.anexo_url,
                    b.status, b.observacao, b.created_at, b.updated_at,
                    u.nome AS usuario_nome
               FROM bugs_sugestoes b
               LEFT JOIN usuarios u ON u.id = b.usuario_id
               ${where}
               ORDER BY b.created_at DESC
               LIMIT ${limite}`,
            params
        );

        const contagem = await pgPool.query(
            `SELECT status, COUNT(*)::int AS total
               FROM bugs_sugestoes
              GROUP BY status`
        );

        res.json({
            ok: true,
            bugs: r.rows,
            contagem: contagem.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/* Admin: atualizar status e/ou observação de um relato. */
app.post("/api/admin/bugs/:id", authAdmin, async (req, res) => {
    try {
        if (!pgDisponivel) {
            return res.status(503).json({ error: "Banco de dados indisponível." });
        }

        const bugId = Number(req.params.id);
        const campos = [];
        const params = [];

        if (req.body.status !== undefined) {
            const status = String(req.body.status).trim();
            if (!STATUS_BUG.includes(status)) {
                return res.status(400).json({ error: "Status inválido." });
            }
            params.push(status);
            campos.push(`status = $${params.length}`);
        }

        if (req.body.observacao !== undefined) {
            const obs = req.body.observacao === null
                ? null
                : String(req.body.observacao).trim();
            params.push(obs);
            campos.push(`observacao = $${params.length}`);
        }

        if (!campos.length) {
            return res.status(400).json({ error: "Nenhum campo para atualizar." });
        }

        params.push(bugId);
        campos.push("updated_at = NOW()");

        const r = await pgPool.query(
            `UPDATE bugs_sugestoes SET ${campos.join(", ")}
              WHERE id = $${params.length}`,
            params
        );
        if (!r.rowCount) {
            return res.status(404).json({ error: "Relato não encontrado." });
        }

        registrarLog("bug_sugestao_atualizada", {
            bugId,
            status: req.body.status
        });

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/* =========================
   404 JSON PARA /api
========================= */

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "Rota não encontrada."
    });
});

/* =========================
   TRATAMENTO DE ERROS
========================= */

app.use((err, req, res, next) => {
    console.error("ERRO:", err.message);

    if (err.type === "entity.too.large") {
        return res.status(413).json({
            error: "Corpo da requisição muito grande."
        });
    }

    if (err.name === "MulterError") {
        return res.status(400).json({
            error: err.message
        });
    }

    if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/webhooks")
    ) {
        return res.status(err.status || 500).json({
            error: err.message || "Erro interno do servidor."
        });
    }

    res.status(err.status || 500).send("Erro interno do servidor.");
});

/* =========================
   INICIAR SERVIDOR IMEDIATAMENTE
   O app.listen() deve acontecer primeiro para que
   o health check do Render (/api/status) responda
   enquanto a migração do banco executa em background.
========================= */

app.listen(
    PORT,
    () => {
        console.log(
            `Milhão Door funcionando em http://localhost:${PORT}` +
            (MERCADOPAGO_SANDBOX ? " (Mercado Pago SANDBOX)" : "")
        );
    }
);

if (MERCADOPAGO_SANDBOX) {
    console.warn(
        "⚠️  ATENÇÃO: MERCADOPAGO_SANDBOX=true — os pagamentos " +
        "usarão o AMBIENTE DE TESTE do Mercado Pago (dinheiro simulado)."
    );
}

/* Migração do banco em background.
   O servidor já está escutando; o banco será preparado
   sem bloquear as requisições. */
initBanco()
    .then(() => {
        /* Varredura periódica: libera reservas que estouraram
           o tempo limite (RESERVA_TTL_MINUTOS). */
        setInterval(limparReservasExpiradas, 60 * 1000);

        console.log(
            "PostgreSQL conectado — migração concluída em background."
        );
    })
    .catch((error) => {
        console.error(
            "ERRO ao conectar/migrar PostgreSQL:",
            error.message
        );
        console.error(
            "O servidor continua funcionando, mas o histórico " +
            "de transações pode estar indisponível."
        );
    });