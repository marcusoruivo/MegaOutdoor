require("dotenv").config();

const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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
    limit: 15,
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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS " +
            "idx_transacoes_token ON transacoes(token)"
        );

        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS " +
            "idx_transacoes_access ON transacoes(access_code)"
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
             customer_id, payment_id, nome, email,
             espacos, quantidade, valor_total,
             comissao, status, test)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
            tipo,
            accessCode,
            token || null,
            orderId,
            customerId || null,
            paymentId || null,
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

initBanco();

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

function gerarCupom(nome, orderId) {
    const codigo =
        "MEGA-" +
        crypto.randomBytes(4).toString("hex").toUpperCase();

    const cupons = readCoupons();

    cupons[codigo] = {
        codigo,
        ownerName: (nome || "").trim(),
        ownerOrderId: orderId,
        discountPercent: 10,
        used: 0,
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

app.post("/api/checkout", async (req, res) => {

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

        if (coupon && !cupom) {
            return res.status(400).json({
                error: "Cupom de indicação inválido ou expirado."
            });
        }

        if (cupom) {
            desconto = {
                value: cupom.discountPercent,
                dueDateLimitDays: 0,
                type: "PERCENTAGE"
            };
        }

        if (cupom) {
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
            cupom ? cupom.discountPercent : 0;

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
            nome: name.trim(),
            email: email.trim(),
            espacos: ids,
            valorTotal: valorCobrado,
            comissao: 0,
            status: "pendente",
            test: false
        });

        if (cupom) {
            cupom.used += 1;
            const cupons = readCoupons();
            cupons[cupom.codigo] = cupom;
            writeCoupons(cupons);
        }

        const meuCupom =
            gerarCupom(name, orderId);

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
                cupom ? cupom.discountPercent : 0,
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

app.post("/api/test/reserve", (req, res) => {

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

        if (coupon && !cupom) {
            return res.status(400).json({
                error: "Cupom de indicação inválido ou expirado."
            });
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

        registrarTransacao({
            tipo: "compra",
            accessCode,
            token: orderToken,
            orderId,
            nome: name || "Anunciante",
            email: email || "",
            espacos: spaces,
            valorTotal: spaces.length,
            comissao: 0,
            status: "pago",
            test: true
        });

        const meuCupom =
            gerarCupom(name, orderId);

        if (cupom) {
            cupom.used += 1;
            const cupons = readCoupons();
            cupons[cupom.codigo] = cupom;
            writeCoupons(cupons);
        }

        res.json({
            ok: true,
            spaces,
            test: true,
            orderToken,
            accessCode,
            meuCupom,
            discountPercent:
                cupom ? cupom.discountPercent : 0
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

app.get("/api/historico", async (req, res) => {

    const tokens =
        (req.headers["x-owner-tokens"] || "")
            .split(",")
            .map(t => t.trim())
            .filter(Boolean);

    const codigosHeader =
        (req.headers["x-owner-access-code"] || "")
            .split(",")
            .map(t => t.trim().toUpperCase())
            .filter(Boolean);

    if (!pgDisponivel) {
        return res.status(503).json({
            error:
                "Banco de dados ainda não configurado. " +
                "Defina DATABASE_URL para ativar o histórico."
        });
    }

    if (!tokens.length && !codigosHeader.length) {
        return res.status(400).json({
            error:
                "Nenhuma identificação de proprietário enviada."
        });
    }

    const db = readDB();

    const meusCodigos = new Set(codigosHeader);

    for (const s of Object.values(db)) {

        if (
            tokens.includes(s.orderToken) &&
            s.accessCode
        ) {
            meusCodigos.add(s.accessCode);
        }
    }

    try {

        const result = await pgPool.query(
            `SELECT id, tipo, access_code, order_id,
                    nome, email, espacos, quantidade,
                    valor_total, comissao, status,
                    test, criado_em, pago_em
               FROM transacoes
              WHERE token = ANY($1::text[])
                 OR access_code = ANY($2::text[])
              ORDER BY criado_em DESC`,
            [
                tokens,
                [...meusCodigos]
            ]
        );

        const transacoes =
            result.rows.map(r => ({
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
                recebidoTotal +=
                    t.valorTotal - t.comissao;
                vendidos += t.quantidade;
            }
        }

        res.json({
            ok: true,
            total: transacoes.length,
            gastoTotal:
                Math.round(gastoTotal * 100) / 100,
            recebidoTotal:
                Math.round(recebidoTotal * 100) / 100,
            comprados,
            vendidos,
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

app.listen(
    PORT,
    () => {
        console.log(
            `Milhão Door funcionando em http://localhost:${PORT}`
        );
    }
);