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
    limit: ALLOW_TEST_MODE ? 200 : 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Muitas tentativas. Aguarde um pouco e tente novamente."
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

const ASAAS_API = "https://api.asaas.com/v3";
const ASAAS_KEY = process.env.ASAAS_API_KEY;

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
                id          SERIAL PRIMARY KEY,
                tipo        VARCHAR(10) NOT NULL,
                access_code VARCHAR(30) NOT NULL,
                token       VARCHAR(64),
                order_id    VARCHAR(60) NOT NULL,
                customer_id VARCHAR(60),
                payment_id  VARCHAR(60),
                usuario_id  INTEGER,
                nome        VARCHAR(200),
                email       VARCHAR(200),
                espacos     INTEGER[] NOT NULL,
                quantidade  INTEGER NOT NULL,
                valor_total NUMERIC(12,2) NOT NULL,
                comissao    NUMERIC(12,2) NOT NULL DEFAULT 0,
                status      VARCHAR(20) NOT NULL DEFAULT 'pendente',
                test        BOOLEAN NOT NULL DEFAULT FALSE,
                criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                pago_em     TIMESTAMPTZ
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
    customerId,
    paymentId,
    usuarioId,
    nome,
    email,
    espacos,
    valorTotal,
    comissao = 0,
    status,
    test = false
}) {

    if (!pgDisponivel) {
        return Promise.resolve(false);
    }

    return pgPool.query(
        `INSERT INTO transacoes
            (tipo, access_code, token, order_id,
             customer_id, payment_id, usuario_id, nome, email,
             espacos, quantidade, valor_total,
             comissao, status, test)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
            tipo,
            accessCode,
            token || null,
            orderId,
            customerId || null,
            paymentId || null,
            usuarioId || null,
            nome || null,
            email || null,
            espacos,
            espacos.length,
            valorTotal,
            comissao,
            status,
            test
        ]
    ).catch((err) => {
        console.error("ERRO ao registrar transação:", err.message);
        return false;
    });
}

function pgPagamentoPago(paymentId) {

    if (!pgDisponivel) {
        return Promise.resolve(false);
    }

    return pgPool.query(
        `UPDATE transacoes
            SET status = 'pago',
                pago_em = NOW()
          WHERE payment_id = $1
            AND status = 'pendente'`,
        [paymentId]
    ).catch((err) => {
        console.error("ERRO ao atualizar transação:", err.message);
        return false;
    });
}

/* initBanco() é chamado antes do app.listen, no final. */

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.json({
    limit: "100kb"
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
app.use("/webhooks/asaas", limiterSensivel);

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
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function extrairBearer(req) {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return null;
    }

    return auth.slice(7).trim();
}

function authUsuario(req, res, next) {
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

const SITE_URL =
    process.env.SITE_URL ||
    "https://megaoutdoor.onrender.com";

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

async function asaasRequest(endpoint, options = {}) {

    const response = await fetch(
        ASAAS_API + endpoint,
        {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "access_token": ASAAS_KEY,
                ...(options.headers || {})
            }
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.errors?.map(e => e.description).join(", ")
            || data.message
            || `Erro Asaas HTTP ${response.status}`
        );
    }

    return data;
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
            transferredAt: s.transferredAt
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
   CRIAR PEDIDO + PIX
========================= */

app.post("/api/checkout", authUsuario, async (req, res) => {

    try {

        const {
            spaces,
            name,
            email,
            cpfCnpj,
            coupon
        } = req.body;

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

            const minimo =
                Math.ceil(5 / (1 - cupom.discountPercent / 100));

            if (total < minimo) {
                return res.status(400).json({
                    error:
                        `Com o cupom de ${cupom.discountPercent}% de ` +
                        `desconto, selecione ao menos ${minimo} espaços ` +
                        `(o valor após o desconto não pode ser menor que R$ 5,00).`
                });
            }
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

        /* =========================
           CRIA CLIENTE ASAAS
        ========================= */

        const customer = await asaasRequest(
            "/customers",
            {
                method: "POST",
                body: JSON.stringify({
                    name: name.trim(),
                    cpfCnpj: document,
                    email: email.trim(),
                    externalReference:
                        `mega-outdoor-${Date.now()}`,
                    notificationDisabled: true
                })
            }
        );

        /* =========================
           CRIA COBRANÇA PIX
        ========================= */

        const dueDate =
            new Date()
                .toISOString()
                .slice(0, 10);

        const payment = await asaasRequest(
            "/payments",
            {
                method: "POST",
                body: JSON.stringify({
                    customer: customer.id,
                    billingType: "PIX",
                    value: total,
                    dueDate,
                    description:
                        `Milhão Door - ${total} espaço(s)`,
                    externalReference:
                        `MEGA-${Date.now()}`,
                    ...(desconto ? { discount: desconto } : {})
                })
            }
        );

        /* =========================
           QR CODE
        ========================= */

        const pix = await asaasRequest(
            `/payments/${payment.id}/pixQrCode`,
            {
                method: "GET"
            }
        );

        const orderId =
            `MEGA-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 7)}`;

        const orderToken =
            gerarToken();

        const accessCode =
            gerarAccessCode();

        /* =========================
           RESERVA
        ========================= */

        for (const id of ids) {

            db[id] = {
                id,
                status: "reserved",
                orderId,
                orderToken,
                accessCode,
                customerId: customer.id,
                paymentId: payment.id,
                name: name.trim(),
                email: email.trim(),
                createdAt:
                    new Date().toISOString()
            };
        }

        writeDB(db);

        const descontoPct =
            cupomCredito
                ? cupomCredito.discountPercent
                : (cupom && cupom.tipo !== "indicacao")
                    ? cupom.discountPercent
                    : 0;

        const valorCobrado =
            Math.round(
                total * (1 - descontoPct / 100) * 100
            ) / 100;

        registrarTransacao({
            tipo: "compra",
            accessCode,
            token: orderToken,
            orderId,
            customerId: customer.id,
            paymentId: payment.id,
            usuarioId: req.usuario.id,
            nome: name.trim(),
            email: email.trim(),
            espacos: ids,
            valorTotal: valorCobrado,
            comissao: 0,
            status: "pendente",
            test: false
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

        res.json({
            ok: true,
            orderId,
            orderToken,
            accessCode,
            paymentId: payment.id,
            spaces: ids,
            total,
            value: total,
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
                ),
            qrCode: pix.encodedImage,
            payload: pix.payload,
            meuCupom,
            expirationDate:
                pix.expirationDate
        });

    } catch (error) {

        console.error("ERRO CHECKOUT:", error.message);

        res.status(500).json({
            error: error.message
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
                createdAt: now
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
            test: true
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
    "/api/payment-status/:paymentId",
    async (req, res) => {

        try {

            const payment =
                await asaasRequest(
                    `/payments/${req.params.paymentId}`,
                    {
                        method: "GET"
                    }
                );

            const db = readDB();

            if (
                payment.status === "RECEIVED" ||
                payment.status === "CONFIRMED"
            ) {

                confirmarPagamentoOferta(payment.id);

                pgPagamentoPago(payment.id);

                registrarLog("pagamento_confirmado", {
                    paymentId: payment.id,
                    status: payment.status
                });

                for (const id of Object.keys(db)) {

                    if (
                        db[id].paymentId ===
                        payment.id
                    ) {

                        if (
                            db[id].status ===
                            "reserved"
                        ) {

                            db[id].status =
                                "paid";
                        }
                    }
                }

                writeDB(db);
            }

            res.json({
                status: payment.status,
                paymentId: payment.id
            });

        } catch (error) {

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

function confirmarPagamentoOferta(paymentId) {

    const ofertas = readOffers();

    const oferta = Object.values(ofertas).find(o =>
        o.paymentId === paymentId &&
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

    const customer = await asaasRequest(
        "/customers",
        {
            method: "POST",
            body: JSON.stringify({
                name: oferta.name,
                cpfCnpj: document,
                email: oferta.email,
                externalReference:
                    `oferta-${oferta.id}`,
                notificationDisabled: true
            })
        }
    );

    const dueDate =
        new Date()
            .toISOString()
            .slice(0, 10);

    const payment = await asaasRequest(
        "/payments",
        {
            method: "POST",
            body: JSON.stringify({
                customer: customer.id,
                billingType: "PIX",
                value: montante,
                dueDate,
                description:
                    descricao ||
                    `Milhão Door - transferência do espaço ` +
                    `#${oferta.spaceId.toLocaleString("pt-BR")}`,
                externalReference:
                    `OFR-${oferta.id}`
            })
        }
    );

    const pix = await asaasRequest(
        `/payments/${payment.id}/pixQrCode`,
        {
            method: "GET"
        }
    );

    return { customer, payment, pix };
}

app.post("/api/offers/:id/accept", async (req, res) => {

    try {

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
        oferta.customerId = customer.id;
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
            value: oferta.value,
            feeValue,
            ownerPixKey: minhaChave,
            spaceIds: alvos
        });

    } catch (error) {

        console.error("ERRO OFERTA ACEITA:", error.message);

        res.status(500).json({
            error: error.message
        });
    }
});

app.post("/api/offers/:id/buyer-accept", async (req, res) => {

    try {

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
        oferta.customerId = customer.id;
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

app.get("/api/offers/:id/payment", async (req, res) => {

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

        const pix = await asaasRequest(
            `/payments/${oferta.paymentId}/pixQrCode`,
            {
                method: "GET"
            }
        );

        res.json({
            ok: true,
            offerId: oferta.id,
            qrCode: pix.encodedImage,
            payload: pix.payload,
            paymentId: oferta.paymentId,
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
   INICIAR SERVIDOR
========================= */

app.post("/webhooks/asaas", (req, res) => {
    const tokenRecebido =
        req.headers["asaas-access-token"];

    if (!validarTokenWebhook(tokenRecebido)) {
        console.log("Webhook Asaas recusado: token inválido.");
        return res.status(401).json({
            error: "Unauthorized"
        });
    }

    const evento = req.body;

    console.log("Webhook recebido:", evento.event);

    if (evento.event === "PAYMENT_RECEIVED") {
        const paymentId = evento.payment?.id;

        if (paymentId) {

            const ofertaPaga =
                confirmarPagamentoOferta(paymentId);

            pgPagamentoPago(paymentId);

            registrarLog("pagamento_confirmado_webhook", {
                paymentId
            });

            const db = readDB();
            let alterado = false;

            for (const id of Object.keys(db)) {
                const space = db[id];

                if (
                    space.paymentId === paymentId &&
                    space.status === "reserved"
                ) {
                    db[id] = {
                        ...space,
                        status: "paid",
                        paidAt: new Date().toISOString()
                    };

                    alterado = true;
                }
            }

            if (alterado || ofertaPaga) {
                writeDB(db);
                console.log(
                    `Pagamento ${paymentId} confirmado.`
                );
            }
        }
    }

    return res.status(200).json({
        received: true
    });
});

function validarTokenWebhook(recebido) {

    const esperado = process.env.WEBHOOK_TOKEN;

    if (
        !esperado ||
        typeof recebido !== "string"
    ) {
        return false;
    }

    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

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
        receitaPotencial: sold
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
        Math.min(
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

initBanco().then(() => {
    app.listen(
        PORT,
        () => {
            console.log(
                `Milhão Door funcionando em http://localhost:${PORT}`
            );
        }
    );
}).catch((error) => {
    console.error("Falha ao iniciar:", error.message);
    process.exit(1);
});