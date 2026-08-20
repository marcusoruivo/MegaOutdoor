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
const { isProduction, validateProductionEnvironment } = require("./production-startup-validation");

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
    isProduction(process.env);

const ALLOW_TEST_MODE =
    process.env.ALLOW_TEST_MODE === "true";

/* Fail-closed: isto ocorre antes de diretórios, JWT, seeds, migrations ou listen. */
validateProductionEnvironment();

/* Configuração central dos destaques patrocinados. */
const STORY_PRICING = Object.freeze({
    "3h": Number(process.env.STORY_PRICE_3H || 5.00),
    "6h": Number(process.env.STORY_PRICE_6H || 8.00),
    "12h": Number(process.env.STORY_PRICE_12H || 12.00),
    "24h": Number(process.env.STORY_PRICE_24H || 20.00)
});

/* Obtém a configuração de preços dos stories do banco de dados.
   Fallback para STORY_PRICING caso o DB não esteja disponível. */
async function getStoryPricingConfig() {
    if (!pgDisponivel || !pgPool) {
        const duracoes = Object.keys(STORY_PRICING);
        return duracoes.map(d => ({
            duracao: d,
            precoCents: Math.round(STORY_PRICING[d] * 100),
            ativo: true,
            popular: d === "6h"
        }));
    }
    try {
        const result = await pgPool.query(
            "SELECT duracao, preco_cents, ativo, popular FROM story_pricing_config ORDER BY CASE duracao WHEN '3h' THEN 1 WHEN '6h' THEN 2 WHEN '12h' THEN 3 WHEN '24h' THEN 4 ELSE 5 END"
        );
        if (result.rows.length > 0) {
            return result.rows.map(r => ({
                duracao: r.duracao,
                precoCents: Number(r.preco_cents),
                ativo: r.ativo === true,
                popular: r.popular === true
            }));
        }
    } catch (e) { /* fallback */ }
    const duracoes = Object.keys(STORY_PRICING);
    return duracoes.map(d => ({
        duracao: d,
        precoCents: Math.round(STORY_PRICING[d] * 100),
        ativo: true,
        popular: d === "6h"
    }));
}

/* Valida o preço de uma duração de story contra a config do banco.
   Retorna { ok, precoCents, erro } */
async function validarPrecoStory(duracao, frontendPrecoCents) {
    const config = await getStoryPricingConfig();
    const item = config.find(c => c.duracao === duracao);
    if (!item) return { ok: false, erro: "Duração inválida." };
    if (!item.ativo) return { ok: false, erro: "Duração desativada pelo administrador." };
    return { ok: true, precoCents: item.precoCents };
}

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
    limit: ALLOW_TEST_MODE ? 300 : 5,
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

const MERCADOPAGO_CLIENT_ID = process.env.MERCADOPAGO_CLIENT_ID || "";
const MERCADOPAGO_CLIENT_SECRET = process.env.MERCADOPAGO_CLIENT_SECRET || "";
const MERCADOPAGO_REDIRECT_URI = process.env.MERCADOPAGO_REDIRECT_URI || "";
const MERCADOPAGO_MARKETPLACE_FEE_PERCENT = Number(process.env.MERCADOPAGO_MARKETPLACE_FEE_PERCENT || 10);
const MERCADOPAGO_MARKETPLACE_SPLIT_ENABLED = process.env.MERCADOPAGO_MARKETPLACE_SPLIT_ENABLED === "true";

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

function chaveCriptografiaMarketplace() {
    return crypto.createHash("sha256").update(String(JWT_SECRET) + ":marketplace").digest();
}

function criptografarMarketplace(valor) {
    if (!valor) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", chaveCriptografiaMarketplace(), iv);
    const encrypted = Buffer.concat([cipher.update(String(valor), "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function descriptografarMarketplace(valor) {
    if (!valor) return null;
    try {
        const [ivRaw, tagRaw, dataRaw] = String(valor).split(".");
        const decipher = crypto.createDecipheriv("aes-256-gcm", chaveCriptografiaMarketplace(), Buffer.from(ivRaw, "base64url"));
        decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
    } catch (error) { return null; }
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

async function registrarStoryEvento({
    eventKey, kind, title, subtitle, actionType = null,
    actionId = null, metadata = {}, usuarioId = null, expiresAt = null
} = {}) {
    if (!pgDisponivel || !pgPool || !eventKey || !title) return false;
    try {
        const expira = expiresAt
            ? new Date(expiresAt).toISOString()
            : "NOW() + INTERVAL '24 hours'";
        if (expira === "NOW() + INTERVAL '24 hours'") {
            await pgPool.query(
                `INSERT INTO story_events
                    (event_key, kind, title, subtitle, action_type, action_id, metadata, usuario_id, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + INTERVAL '24 hours')
                 ON CONFLICT (event_key) DO NOTHING`,
                [eventKey, kind || "purchase", title, subtitle || null,
                 actionType, actionId, JSON.stringify(metadata || {}), usuarioId]
            );
        } else {
            await pgPool.query(
                `INSERT INTO story_events
                    (event_key, kind, title, subtitle, action_type, action_id, metadata, usuario_id, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (event_key) DO UPDATE
                    SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle,
                        metadata = EXCLUDED.metadata, expires_at = EXCLUDED.expires_at,
                        usuario_id = COALESCE(story_events.usuario_id, EXCLUDED.usuario_id)`,
                [eventKey, kind || "purchase", title, subtitle || null,
                 actionType, actionId, JSON.stringify(metadata || {}), usuarioId, expira]
            );
        }
        return true;
    } catch (error) {
        console.error("ERRO ao registrar Story:", error.message);
        return false;
    }
}

async function registrarStoryDaTransacao(transacao) {
    if (!transacao || !transacao.story_opt_in || transacao.status !== "pago") return;
    const ids = Array.isArray(transacao.espacos) ? transacao.espacos.map(Number).filter(Number.isFinite) : [];
    const qtd = Number(transacao.quantidade || ids.length || 0);
    const isSingle = ids.length === 1;
    await registrarStoryEvento({
        eventKey: `purchase:${transacao.order_id}`,
        kind: isSingle ? "space" : "purchase",
        title: isSingle ? "🟡 NOVO ESPAÇO" : "🟡 NOVA COMPRA",
        subtitle: isSingle
            ? `#${String(ids[0]).padStart(4, "0")}`
            : `${qtd} espaço${qtd === 1 ? "" : "s"} comprado${qtd === 1 ? "" : "s"}`,
        actionType: isSingle ? "space" : (ids.length > 1 ? "block" : "purchase"),
        actionId: ids.length ? ids[0] : null,
        metadata: { spaces: ids.slice(0, 1000), quantity: qtd }
    });
}

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

        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_transacoes_mp_order_id ON transacoes(mp_order_id)`);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_transacoes_status ON transacoes(status)`);

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

        /* Álbum público (Feature: perfil público de colecionador).
           Aditivo — nunca remove/reescreve dados existentes. */
        try {
            await pgPool.query(`
                ALTER TABLE usuarios
                    ADD COLUMN IF NOT EXISTS album_publico BOOLEAN NOT NULL DEFAULT FALSE
            `);
        } catch (e) { /* se a coluna já existir, segue o boot */ }

        /* Perfil estendido e sistema de indicação */
        try {
            await pgPool.query(`
                ALTER TABLE usuarios
                    ADD COLUMN IF NOT EXISTS apelido VARCHAR(50),
                    ADD COLUMN IF NOT EXISTS bio TEXT,
                    ADD COLUMN IF NOT EXISTS foto_url VARCHAR(500),
                    ADD COLUMN IF NOT EXISTS codigo_indicacao VARCHAR(20) UNIQUE,
                    ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN NOT NULL DEFAULT FALSE
            `);
        } catch (e) { /* se as colunas já existirem, segue o boot */ }

        /* Tabela de indicações */
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS indicacoes (
                    id SERIAL PRIMARY KEY,
                    indicador_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                    indicado_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                    codigo_indicacao VARCHAR(20) NOT NULL,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(indicado_id)
                )
            `);
        } catch (e) { /* se a tabela já existir, segue o boot */ }

        /* Tabela de benefícios de indicação (desconto de 10%) */
        try {
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS beneficios_indicacao (
                    id SERIAL PRIMARY KEY,
                    indicado_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                    indicador_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                    percentual_desconto INTEGER NOT NULL DEFAULT 10,
                    status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    utilizado_em TIMESTAMPTZ,
                    order_id VARCHAR(60),
                    valor_original_cents INTEGER,
                    valor_desconto_cents INTEGER,
                    valor_final_cents INTEGER,
                    UNIQUE(indicado_id, status)
                )
            `);
        } catch (e) { /* se a tabela já existir, segue o boot */ }

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS concessoes_administrativas (
                id             BIGSERIAL PRIMARY KEY,
                admin_usuario  VARCHAR(200) NOT NULL,
                usuario_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                tipo           VARCHAR(40) NOT NULL,
                itens          JSONB NOT NULL DEFAULT '[]',
                quantidade     INTEGER NOT NULL DEFAULT 0,
                motivo         TEXT NOT NULL,
                criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_concessoes_usuario ON concessoes_administrativas(usuario_id, criado_em DESC)`);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_concessoes_criado ON concessoes_administrativas(criado_em DESC)`);

        /* Tabela de últimas compras (feed público) */
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS ultimas_compras (
                    id SERIAL PRIMARY KEY,
                    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                    tipo VARCHAR(20) NOT NULL,
                    descricao VARCHAR(200) NOT NULL,
                    quantidade INTEGER NOT NULL DEFAULT 0,
                    valor_cents INTEGER NOT NULL DEFAULT 0,
                    espacos INTEGER[] DEFAULT '{}',
                    visivel BOOLEAN NOT NULL DEFAULT TRUE,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expira_em TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
                )
            `);
            await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_ultimas_compras_expira ON ultimas_compras(expira_em)`);
            await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_ultimas_compras_criado ON ultimas_compras(criado_em DESC)`);
        } catch (e) { /* se a tabela já existir, segue o boot */ }

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS story_events (
                id           SERIAL PRIMARY KEY,
                event_key    VARCHAR(180) UNIQUE NOT NULL,
                kind         VARCHAR(30) NOT NULL,
                title        VARCHAR(180) NOT NULL,
                subtitle     VARCHAR(240),
                action_type  VARCHAR(30),
                action_id    INTEGER,
                metadata     JSONB NOT NULL DEFAULT '{}',
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at   TIMESTAMPTZ NOT NULL
            )
        `);
        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS idx_story_events_expiry ON story_events(expires_at)"
        );

        /* Associação do Story ao usuário que o criou (purchase/destaque). */
        await pgPool.query(
            "ALTER TABLE story_events ADD COLUMN IF NOT EXISTS usuario_id INTEGER"
        );

        /* ===== DESTAQUES / STORY PAGO =====
           Compra de destaque no Story com duração (5h/7h/12h/24h).
           Cobrança REAL via Mercado Pago (nunca fictícia). O usuário
           só publica depois da confirmação do pagamento. */
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS destaques (
                id              SERIAL PRIMARY KEY,
                usuario_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                tipo            VARCHAR(20) NOT NULL DEFAULT 'story',
                duracao         VARCHAR(5) NOT NULL,
                preco_cents     INTEGER NOT NULL,
                status          VARCHAR(20) NOT NULL DEFAULT 'pendente',
                order_id        VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id     VARCHAR(60),
                payment_id      VARCHAR(60),
                metodo_pagamento VARCHAR(20),
                titulo          VARCHAR(180),
                subtitulo       VARCHAR(240),
                publicado       BOOLEAN NOT NULL DEFAULT FALSE,
                visualizacoes   INTEGER NOT NULL DEFAULT 0,
                criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                pago_em         TIMESTAMPTZ,
                expira_em       TIMESTAMPTZ
            )
        `);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_destaques_usuario ON destaques(usuario_id, status)`);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_destaques_mp ON destaques(mp_order_id)`);

        const colsDestaques = await pgPool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'destaques'`
        ).then(r => new Set(r.rows.map(x => x.column_name))).catch(() => new Set());

        if (!colsDestaques.has("imagem")) {
            await pgPool.query(`ALTER TABLE destaques ADD COLUMN imagem VARCHAR(500)`);
        }
        if (!colsDestaques.has("link")) {
            await pgPool.query(`ALTER TABLE destaques ADD COLUMN link VARCHAR(500)`);
        }
        if (!colsDestaques.has("espaco_id")) {
            await pgPool.query(`ALTER TABLE destaques ADD COLUMN espaco_id INTEGER`);
        }

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS marketplace_accounts (
                id               SERIAL PRIMARY KEY,
                usuario_id       INTEGER UNIQUE NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                provider         VARCHAR(30) NOT NULL DEFAULT 'mercadopago',
                seller_user_id   VARCHAR(80) NOT NULL,
                access_token_enc TEXT NOT NULL,
                refresh_token_enc TEXT,
                public_key       VARCHAR(200),
                expires_at       TIMESTAMPTZ,
                connected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS marketplace_oauth_states (
                state          VARCHAR(180) PRIMARY KEY,
                usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                verifier_enc   TEXT NOT NULL,
                expires_at     TIMESTAMPTZ NOT NULL,
                used_at        TIMESTAMPTZ
            )
        `);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_oauth_expiry ON marketplace_oauth_states(expires_at)`);

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

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS senha_recuperacoes (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL
                            REFERENCES usuarios(id)
                            ON DELETE CASCADE,
                token_hash  VARCHAR(64) NOT NULL UNIQUE,
                expira_em   TIMESTAMPTZ NOT NULL,
                usada_em    TIMESTAMPTZ,
                criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pgPool.query(
            "CREATE INDEX IF NOT EXISTS idx_senha_recuperacoes_expiry " +
            "ON senha_recuperacoes(expira_em)"
        );

        /* ===== NOTIFICAÇÕES =====
           Sistema de notificações para eventos importantes da conta do usuário.
           Tipos: oferta_recebida, oferta_aceita, oferta_recusada, oferta_cancelada,
                  nova_mensagem, pagamento_aprovado, figurinha_recebida, nova_meta,
                  album_proximo, bloco_publicado */
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS notificacoes (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                tipo        VARCHAR(40) NOT NULL,
                titulo      VARCHAR(200) NOT NULL,
                mensagem    TEXT NOT NULL,
                referencia  JSONB NOT NULL DEFAULT '{}',
                lida_em     TIMESTAMPTZ,
                criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario ON notificacoes(usuario_id, lida_em NULLS FIRST)`);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_notificacoes_criado ON notificacoes(criado_em DESC)`);

        /* Verificação de perfil: não armazena senha nem token do Instagram.
           Pagamento aprovado nunca concede o selo automaticamente; continua
           aguardando análise manual. */
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS verificacoes_perfil (
                id                  BIGSERIAL PRIMARY KEY,
                usuario_id          INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                instagram_handle    VARCHAR(100),
                instagram_url       VARCHAR(500),
                status              VARCHAR(30) NOT NULL DEFAULT 'em_analise',
                metodo              VARCHAR(30) NOT NULL DEFAULT 'manual',
                order_id            VARCHAR(100) UNIQUE,
                mp_order_id         VARCHAR(100),
                payment_id          VARCHAR(100),
                criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                pago_em             TIMESTAMPTZ,
                UNIQUE (usuario_id, status)
            )
        `);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_verificacoes_usuario ON verificacoes_perfil(usuario_id, criado_em DESC)`);
        await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_verificacoes_mp_order ON verificacoes_perfil(mp_order_id)`);

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
            "ALTER TABLE transacoes " +
            "ADD COLUMN IF NOT EXISTS story_opt_in BOOLEAN NOT NULL DEFAULT FALSE"
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

        /* Configuração de preços de destaque dos Stories (admin). */
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS story_pricing_config (
                    id            SERIAL PRIMARY KEY,
                    duracao       VARCHAR(10) NOT NULL UNIQUE,
                    preco_cents   INTEGER NOT NULL DEFAULT 0,
                    ativo         BOOLEAN NOT NULL DEFAULT TRUE,
                    popular       BOOLEAN NOT NULL DEFAULT FALSE,
                    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);

            const pricingCheck = await pgPool.query(
                "SELECT COUNT(*) as total FROM story_pricing_config"
            );

            if (Number(pricingCheck.rows[0].total) === 0) {
                const defaults = [
                    ["3h", 500, true, false],
                    ["6h", 800, true, true],
                    ["12h", 1200, true, false],
                    ["24h", 2000, true, false]
                ];
                for (const [dur, preco, ativo, pop] of defaults) {
                    await pgPool.query(
                        "INSERT INTO story_pricing_config (duracao, preco_cents, ativo, popular) VALUES ($1,$2,$3,$4)",
                        [dur, preco, ativo, pop]
                    );
                }
                console.log("story_pricing_config: preços padrão inseridos.");
            }
        } catch (ePricing) {
            console.error("ERRO ao migrar tabela de preços de stories:", ePricing.message);
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
    aceiteRegras = false,
    storyOptIn = false
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
             operation_type, aceite_regras, story_opt_in)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                  $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
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
             aceiteRegras === true || aceiteRegras === "true",
             storyOptIn === true || storyOptIn === "true"
        ]
    ).then(async (result) => {
        if (status === "pago" && (storyOptIn === true || storyOptIn === "true")) {
            await registrarStoryDaTransacao({
                order_id: orderId,
                status,
                story_opt_in: true,
                espacos,
                quantidade: espacos.length
            });
        }
        return result;
    }).catch((err) => {
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
                    THEN NOW() + (INTERVAL '1 month' * license_duration_months)
                    ELSE NULL
                END
          WHERE ${whereClause}
            AND status = 'pendente'
          RETURNING order_id, status, story_opt_in, espacos, quantidade`,
        [param]
    ).then(async (result) => {
        if (result.rows && result.rows[0]) {
            await registrarStoryDaTransacao(result.rows[0]);
        }
        return result;
    }).catch((err) => {
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
    invalidarDBBuscaCache && invalidarDBBuscaCache();
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

    if (auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
    }

    /* EventSource não envia headers customizados; o frontend pode enviar o token via query string. */
    const queryToken = req.query && req.query.token ? String(req.query.token).trim() : "";
    if (queryToken) {
        return queryToken;
    }

    return null;
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
        ultimoLogin: u.ultimo_login,
        apelido: u.apelido || null,
        bio: u.bio || null,
        fotoUrl: u.foto_url || null,
        albumPublico: u.album_publico ?? true
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
    const cents = paraCentavos(valor);
    const taxaCents = Math.max(1, Math.round(cents * TAXA_SITE));
    return taxaCents / 100;
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

function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

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
    if (mapeada) return mapeada.msg;
    /* A mensagem genérica do MP (ex.: "Missing properties, Invalid value for property")
       esconde a propriedade real rejeitada, que vem no array cause. Não devolvemos
       só a mensagem crua: anexamos a descrição específica para o usuário entender
       o que está errado (ex.: "payment_method.id"). */
    const causas = (erro && Array.isArray(erro.cause))
        ? erro.cause.map(c => c && c.description).filter(Boolean)
        : [];
    if (causas.length) {
        return msg + (msg ? " — " : "") + causas.join("; ");
    }
    return msg;
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

async function mercadoPagoRequestComToken(accessToken, endpoint, options = {}) {
    if (!accessToken) throw new Error("Conta Mercado Pago do vendedor não conectada.");
    const response = await fetch(MERCADOPAGO_API + endpoint, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Mercado Pago Marketplace ${response.status}: ${mascararSensivel(data.message || data.error || "erro")}`);
    return data;
}

/* Checkout Pro Marketplace 1:1. A preferência é criada com o access token
   OAuth do vendedor; marketplace_fee é enviado ao gateway, não é repasse interno. */
async function criarOrderMercadoPagoSplit({
    sellerAccount, idempotencyKey, externalReference, value, description, customer, platformFee
}) {
    if (!MERCADOPAGO_MARKETPLACE_SPLIT_ENABLED) throw new Error("Split Marketplace desativado.");
    if (!sellerAccount || !sellerAccount.accessToken) throw new Error("Conta Mercado Pago do vendedor não conectada.");
    const preference = await mercadoPagoRequestComToken(sellerAccount.accessToken, "/checkout/preferences", {
        method: "POST",
        headers: { "X-Idempotency-Key": String(idempotencyKey || externalReference) },
        body: JSON.stringify({
            items: [{
                id: String(externalReference),
                title: description || "Compra no marketplace",
                quantity: 1,
                currency_id: "BRL",
                unit_price: Number(value)
            }],
            payer: { email: customer && customer.email ? String(customer.email).trim() : undefined },
            external_reference: String(externalReference),
            marketplace_fee: Number(platformFee),
            notification_url: process.env.MERCADOPAGO_WEBHOOK_URL || undefined,
            back_urls: {
                success: process.env.SITE_URL || "https://milhaodoor.com.br",
                failure: process.env.SITE_URL || "https://milhaodoor.com.br",
                pending: process.env.SITE_URL || "https://milhaodoor.com.br"
            },
            auto_return: "approved"
        })
    });
    return {
        orderId: String(preference.id),
        externalReference: String(externalReference),
        paymentStatus: "pending",
        ticketUrl: preference.init_point || preference.sandbox_init_point || "",
        preferenceId: String(preference.id),
        marketplaceFee: Number(platformFee),
        raw: preference
    };
}

async function consultarMercadoPagoPayment(accessToken, paymentId) {
    return mercadoPagoRequestComToken(accessToken, `/v1/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
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
    installments = 1,
    issuerId
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
    } else if (paymentMethodId) {
        /* A API Orders exige o id da bandeira (ex.: "visa", "master", "elo").
           "credit_card" é apenas o tipo, NÃO um id válido — enviá-lo como
           fallback faz o MP rejeitar com "Invalid value for property". */
        paymentBody.payment_method.id = paymentMethodId;
    }

    if (!isPix && cardToken) {
        paymentBody.payment_method.token = cardToken;
        paymentBody.payment_method.installments = Number(installments) || 1;
        if (issuerId) {
            paymentBody.payment_method.issuer_id = String(issuerId);
        }
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
    return status === "paid" || status === "approved" ||
           status === "processed" || status === "accredited";
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

/* CORREÇÃO 6 — Decisão definitiva de pagamento para a resposta REAL da
   API Orders do Mercado Pago (GET /v1/orders/{id}).
   A Orders API usa order.status="processed" (com status_detail
   "accredited") quando o PIX é pago/creditado — e NÃO "approved".
   Para os status "processed"/"accredited" exigimos a validação da
   TRANSAÇÃO em transactions.payments: payment.status processado/
   creditado/aprovado E payment.status_detail NÃO pendente. Assim
   nunca marcamos pago apenas pelo status da Order (ex.: um PIX pago
   mas com transação refunded/cancelada NÃO é pago). */
function orderPagaMercadoPago(order) {
    if (!order || typeof order !== "object") return false;
    const status = String(order.status || "");
    if (statusOrderRejeitada(status)) return false;
    if (!statusOrderPago(status)) return false;
    if (status === "paid" || status === "approved") return true;

    const payments = order?.transactions?.payments || order?.payments || [];
    if (!Array.isArray(payments) || payments.length === 0) return false;

    return payments.some(p => {
        if (!statusOrderPago(String(p.status || ""))) return false;
        const detalhe = String(p.status_detail || "");
        if (
            detalhe === "action_required" ||
            detalhe === "waiting_transfer" ||
            detalhe === "pending_waiting_transfer" ||
            detalhe === "in_process" ||
            detalhe === "waiting_capture"
        ) {
            return false;
        }
        return true;
    });
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
        res.status(500).json({ error: "Erro interno do servidor." });
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
                    criado_em, ultimo_login, apelido, bio,
                    foto_url, album_publico
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
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});

/* =========================
   ESQUECI A SENHA
   Solicita recuperação por e-mail e redefine a senha com
   token de uso único e expiração (30 min). Mensagem sempre
   genérica para não revelar se o e-mail existe.
========================= */

app.post("/api/auth/senha-recuperacao", async (req, res) => {

    if (!pgDisponivel || !pgPool) {
        return res.status(503).json({
            error: "Recuperação indisponível no momento."
        });
    }

    const email = String(req.body.email || "")
        .trim()
        .toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({
            error: "Informe um e-mail válido."
        });
    }

    try {

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = hashToken(token);

        const result = await pgPool.query(
            "SELECT id, nome FROM usuarios WHERE email = $1",
            [email]
        );

        if (result.rowCount > 0) {
            const usuario = result.rows[0];
            await pgPool.query(
                `UPDATE senha_recuperacoes SET usada_em = NOW() - INTERVAL '1 second'
                  WHERE usuario_id = $1 AND usada_em IS NULL AND expira_em > NOW()`,
                [usuario.id]
            );
            await pgPool.query(
                `INSERT INTO senha_recuperacoes (usuario_id, token_hash, expira_em)
                 VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
                [usuario.id, tokenHash]
            );

            const link = `${urlBase(req)}/redefinir-senha.html?token=${token}`;
            const enviado = await enviarEmail(
                email,
                "Redefinição de senha — Milhão Door",
                `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto">
                   <h2 style="color:#0d9488">Redefinição de senha</h2>
                    <p>Olá, ${escapeHtml(usuario.nome.split(" ")[0])}!</p>
                   <p>Recebemos um pedido de redefinição da sua senha. O link abaixo é válido por <b>30 minutos</b> e só pode ser usado uma vez:</p>
                   <p style="text-align:center;margin:24px 0">
                     <a href="${link}" style="background:#0d9488;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Redefinir minha senha</a>
                   </p>
                   <p>Se você não pediu essa redefinição, ignore este e-mail — sua senha continua a mesma.</p>
                   <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
                   <p style="color:#6b7280;font-size:12px">Milhão Door — anúncios de outdoor digital.</p>
                 </div>`
            );
            registrarLog("senha_recuperacao_solicitada", {
                usuarioId: usuario.id,
                email,
                emailEnviado: enviado
            });
        }

        const resposta = {
            ok: true,
            mensagem:
                "Se existir uma conta com este e-mail, " +
                "enviaremos um link de redefinição."
        };

        /* Apenas em modo de teste (ALLOW_TEST_MODE) o token é
           devolvido para que os testes consigam redefinir a senha. */
        if (
            ALLOW_TEST_MODE &&
            req.get("x-test-mode") === "1" &&
            result.rowCount > 0
        ) {
            resposta.testeToken = token;
        }

        res.json(resposta);

    } catch (error) {
        console.error("ERRO na recuperação de senha:", error.message);
        res.status(500).json({ error: "Não foi possível processar a solicitação." });
    }
});

app.post("/api/auth/redefinir-senha", async (req, res) => {

    if (!pgDisponivel || !pgPool) {
        return res.status(503).json({
            error: "Recuperação indisponível no momento."
        });
    }

    const token = String(req.body.token || "").trim();
    const novaSenha = String(req.body.novaSenha || "");

    if (!token) {
        return res.status(400).json({ error: "Link de redefinição inválido ou expirado." });
    }

    if (
        typeof novaSenha !== "string" ||
        novaSenha.length < 6
    ) {
        return res.status(400).json({
            error: "A nova senha deve ter ao menos 6 caracteres."
        });
    }

    try {

        const tokenHash = hashToken(token);

        const result = await pgPool.query(
            `SELECT id, usuario_id, expira_em
               FROM senha_recuperacoes
              WHERE token_hash = $1
                AND usada_em IS NULL`,
            [tokenHash]
        );

        const registro = result.rows[0];

        if (
            !registro ||
            new Date(registro.expira_em).getTime() <= Date.now()
        ) {
            return res.status(400).json({
                error: "Link de redefinição inválido ou expirado."
            });
        }

        await pgPool.query(
            `UPDATE usuarios SET senha_hash = $1 WHERE id = $2`,
            [hashSenha(novaSenha), registro.usuario_id]
        );

        await pgPool.query(
            `UPDATE senha_recuperacoes SET usada_em = NOW() WHERE id = $1`,
            [registro.id]
        );

        await pgPool.query(
            `INSERT INTO usuario_chaves (usuario_id, tipo, valor)
             VALUES ($1, 'logout', $2)
             ON CONFLICT (tipo, valor) DO NOTHING`,
            [registro.usuario_id, crypto.randomUUID()]
        );

        registrarLog("senha_redefinida", {
            usuarioId: registro.usuario_id
        });

        res.json({ ok: true, mensagem: "Senha redefinida com sucesso." });

    } catch (error) {
        console.error("ERRO ao redefinir senha:", error.message);
        res.status(500).json({ error: "Não foi possível redefinir a senha." });
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
            `SELECT id, nome, email, criado_em, ultimo_login,
                    apelido, bio, foto_url, album_publico
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

        const verificacao = await pgPool.query(
            `SELECT instagram_handle, instagram_url, status, metodo,
                    order_id, mp_order_id, payment_id, criado_em, atualizado_em, pago_em
               FROM verificacoes_perfil
              WHERE usuario_id = $1
              ORDER BY criado_em DESC LIMIT 1`,
            [usuario.id]
        ).catch(() => ({ rows: [] }));

        res.json({
            ok: true,
            usuario: usuarioSemSenha(usuario),
            chaves: chaves.map(c => ({
                tipo: c.tipo,
                valor: c.valor
            })),
            espacos: meusEspacos,
            totalTransacoes:
                Number(transacoes?.rows?.[0]?.total || 0),
            verificacaoPerfil: verificacao.rows[0] || null,
            verificado: verificacao.rows[0]?.status === "aprovado"
        });

    } catch (error) {
        console.error("ERRO ao carregar conta:", error.message);
        res.status(500).json({ error: error.message });
    }
});

function normalizarInstagramVerificacao(valor) {
    const bruto = String(valor || "").trim();
    if (!bruto || bruto.length > 500) return { handle: null, url: null };
    const url = /^https?:\/\/(www\.)?instagram\.com\//i.test(bruto)
        ? bruto.split(/[?#]/)[0].replace(/\/$/, "")
        : null;
    const handle = (url ? url.split("/").pop() : bruto.replace(/^@/, ""))
        .trim().replace(/^@/, "");
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) return { handle: null, url: null };
    return { handle: handle.toLowerCase(), url: url || `https://instagram.com/${handle}` };
}

/* O pagamento é um sinal de intenção, não prova de identidade. */
async function processarPagamentoVerificacaoPerfil(mpOrderId, totalPagoCents, paymentId) {
    if (!pgDisponivel || !pgPool || !mpOrderId || Number(totalPagoCents) !== 5000) return false;
    const q = await pgPool.query(
        `SELECT id, usuario_id FROM verificacoes_perfil
          WHERE mp_order_id = $1 AND status = 'pendente_pagamento' LIMIT 1`,
        [String(mpOrderId)]
    );
    if (!q.rowCount) return false;
    const v = q.rows[0];
    const atualizado = await pgPool.query(
        `UPDATE verificacoes_perfil
            SET status = 'em_analise', payment_id = COALESCE(payment_id, $2),
                pago_em = COALESCE(pago_em, NOW()), atualizado_em = NOW()
          WHERE id = $1 AND status = 'pendente_pagamento'
        RETURNING id`,
        [v.id, paymentId ? String(paymentId) : null]
    );
    if (atualizado.rowCount) {
        await criarNotificacao(v.usuario_id, "verificacao_pagamento", "Pagamento recebido", "Recebemos R$ 50,00. Seu perfil segue em análise manual; o selo não é automático.", { verificacaoId: v.id, mpOrderId: String(mpOrderId) });
    }
    return true;
}

app.get("/api/verificacoes-perfil", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    const result = await pgPool.query(
        `SELECT id, instagram_handle, instagram_url, status, metodo, order_id,
                mp_order_id, payment_id, criado_em, atualizado_em, pago_em
           FROM verificacoes_perfil WHERE usuario_id = $1 ORDER BY criado_em DESC`,
        [req.usuario.id]
    );
    res.json({ verificacoes: result.rows, verificado: result.rows.some(v => v.status === "aprovado") });
});

app.post("/api/verificacoes-perfil", limiterSensivel, authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    const alvo = normalizarInstagramVerificacao(req.body.instagramHandle || req.body.instagramUrl);
    if (!alvo.handle) return res.status(400).json({ error: "Informe um @ ou URL válida do Instagram." });
    const metodo = String(req.body.metodo || "manual").toLowerCase() === "mercadopago" ? "mercadopago" : "manual";
    const orderId = `VER-${req.usuario.id}-${crypto.randomUUID()}`;
    const existente = await pgPool.query(
        `SELECT * FROM verificacoes_perfil
          WHERE usuario_id = $1 AND status IN ('pendente_pagamento', 'em_analise', 'aprovado')
          ORDER BY criado_em DESC LIMIT 1`, [req.usuario.id]
    );
    if (existente.rowCount) return res.status(409).json({ error: "Já existe uma solicitação ativa.", verificacao: existente.rows[0] });
    const status = metodo === "mercadopago" ? "pendente_pagamento" : "em_analise";
    const inserida = await pgPool.query(
        `INSERT INTO verificacoes_perfil
            (usuario_id, instagram_handle, instagram_url, status, metodo, order_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.usuario.id, alvo.handle, alvo.url, status, metodo, orderId]
    );
    const verificacao = inserida.rows[0];
    if (metodo === "manual") return res.status(201).json({ ok: true, verificacao, mensagem: "Solicitação enviada para análise manual." });
    try {
        const mp = await criarOrderMercadoPago({
            idempotencyKey: orderId,
            externalReference: orderId,
            value: 50,
            description: "Verificação de perfil MegaOutdoor",
            customer: { email: req.usuario.email },
            paymentMethod: String(req.body.paymentMethod || "pix") === "pix" ? "pix" : "pix"
        });
        await pgPool.query(
            `UPDATE verificacoes_perfil SET mp_order_id = $1, payment_id = $2, atualizado_em = NOW() WHERE id = $3`,
            [mp.orderId, mp.paymentId || null, verificacao.id]
        );
        verificacao.mp_order_id = mp.orderId;
        return res.status(201).json({ ok: true, verificacao, checkout: { orderId: mp.orderId, paymentId: mp.paymentId || null, qrCodeBase64: mp.qrCodeBase64 || "", payload: mp.payload || "", ticketUrl: mp.ticketUrl || "" }, valor: 50 });
    } catch (error) {
        console.error("ERRO ao criar checkout de verificação:", error.message);
        return res.status(202).json({ ok: true, pendente: true, verificacao, mensagem: "Solicitação criada, mas o checkout não está disponível. O status permanece pendente." });
    }
});

/* Aprovação/rejeição fica restrita ao administrador; nunca é inferida do @,
   da URL, da quantidade de seguidores ou do pagamento. */
app.patch("/api/verificacoes-perfil/:id", limiterSensivel, authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    const status = String(req.body.status || "").toLowerCase();
    if (!["aprovado", "rejeitado", "em_analise"].includes(status)) return res.status(400).json({ error: "Status inválido." });
    const result = await pgPool.query(
        `UPDATE verificacoes_perfil SET status = $1, atualizado_em = NOW()
          WHERE id = $2 RETURNING *`, [status, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Solicitação não encontrada." });
    const v = result.rows[0];
    if (status === "aprovado" || status === "rejeitado") {
        await criarNotificacao(v.usuario_id, "verificacao_status", status === "aprovado" ? "Perfil verificado" : "Verificação não aprovada", status === "aprovado" ? "Seu perfil foi aprovado na análise manual." : "Sua solicitação de verificação não foi aprovada.", { verificacaoId: v.id });
    }
    res.json({ ok: true, verificacao: v, verificado: status === "aprovado" });
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

/* Stories públicos: somente eventos autorizados, confirmados e ainda válidos. */
app.get("/api/stories", async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.json({ ok: true, stories: [] });
    try {
        await pgPool.query("DELETE FROM story_events WHERE expires_at <= NOW()");
        const result = await pgPool.query(
            `SELECT se.id, se.kind, se.title, se.subtitle, se.action_type, se.action_id,
                    se.metadata, se.created_at, se.usuario_id,
                    u.apelido, u.foto_url, u.nome
               FROM story_events se
               LEFT JOIN usuarios u ON u.id = se.usuario_id
              WHERE se.expires_at > NOW()
              ORDER BY se.created_at DESC
              LIMIT 30`
        );
        res.json({
            ok: true,
            stories: result.rows.map(row => ({
                id: row.id,
                kind: row.kind,
                title: row.title,
                subtitle: row.subtitle,
                actionType: row.action_type,
                actionId: row.action_id,
                metadata: row.metadata || {},
                createdAt: row.created_at,
                apelido: row.apelido || null,
                nome: row.nome || null,
                fotoUrl: row.foto_url || null,
                usuarioId: row.usuario_id || null
            }))
        });
    } catch (error) {
        console.error("ERRO ao carregar Stories:", error.message);
        res.json({ ok: true, stories: [] });
    }
});

/* =========================
   DESTAQUES NO STORY — COMPRA, CONFIRMAÇÃO E PUBLICAÇÃO
   Cobrança REAL via Mercado Pago (PIX ou cartão). O usuário só
   publica conteúdo depois do pagamento confirmado. Renovação =
   nova compra. Nada de pagamento fictício.
========================= */

async function processarPagamentoDestaque({ mpOrderId, totalCents }) {
    if (!pgDisponivel || !pgPool || !mpOrderId) return false;
    try {
        const q = await pgPool.query(
            `SELECT * FROM destaques WHERE mp_order_id = $1 AND status = 'pendente' LIMIT 1`,
            [mpOrderId]
        );
        const destaque = q.rows[0];
        if (!destaque) return false;

        if (totalCents != null && Number(totalCents) !== Number(destaque.preco_cents)) {
            registrarLog("destaque_valor_divergente", {
                destaqueId: destaque.id,
                cobradoCents: destaque.preco_cents,
                pagoCents: totalCents
            });
            return false;
        }

        const horas = Number(String(destaque.duracao || "24h").replace(/\D/g, "")) || 24;
        await pgPool.query(
            `UPDATE destaques
                SET status = 'ativo', pago_em = NOW(), expira_em = NOW() + (INTERVAL '1 hour' * $2)
              WHERE id = $1`,
            [destaque.id, horas]
        );

        /* Se o conteúdo já veio na compra, publica automaticamente. */
        const titulo = String(destaque.titulo || "").trim();
        if (titulo) {
            await publicarDestaque(destaque.id);
        }
        return true;
    } catch (error) {
        console.error("ERRO ao processar pagamento de destaque:", error.message);
        return false;
    }
}

async function publicarDestaque(destaqueId) {
    if (!pgDisponivel || !pgPool) return false;
    try {
        const q = await pgPool.query(
            `SELECT * FROM destaques WHERE id = $1`,
            [destaqueId]
        );
        const destaque = q.rows[0];
        if (!destaque) return false;
        if (destaque.status !== "ativo") return false;
        if (destaque.expira_em && new Date(destaque.expira_em).getTime() <= Date.now()) return false;

        const titulo = String(destaque.titulo || "").trim();
        if (!titulo) return false;

        const metadata = {};
        if (destaque.imagem) metadata.imagem = destaque.imagem;
        if (destaque.link) metadata.link = destaque.link;

        const temEspaco = destaque.espaco_id &&
            Number(destaque.espaco_id) >= 1 &&
            Number(destaque.espaco_id) <= 1000000;

        await registrarStoryEvento({
            eventKey: `destaque:${destaque.id}`,
            kind: destaque.tipo === "destaque" ? "destaque" : "story",
            title: titulo.slice(0, 180),
            subtitle: String(destaque.subtitulo || "").slice(0, 240) || null,
            usuarioId: destaque.usuario_id,
            expiresAt: destaque.expira_em,
            actionType: temEspaco ? "space" : null,
            actionId: temEspaco ? Number(destaque.espaco_id) : null,
            metadata
        });

        await pgPool.query(
            `UPDATE destaques SET publicado = TRUE WHERE id = $1`,
            [destaque.id]
        );
        return true;
    } catch (error) {
        console.error("ERRO ao publicar destaque:", error.message);
        return false;
    }
}

async function expirarDestaquesVencidos() {
    if (!pgDisponivel || !pgPool) return;
    try {
        await pgPool.query(
            `UPDATE destaques SET status = 'expirado' WHERE status = 'ativo' AND expira_em <= NOW()`
        );
        await pgPool.query(`DELETE FROM story_events WHERE expires_at <= NOW()`);
    } catch (error) {
        console.error("ERRO ao expirar destaques:", error.message);
    }
}

/* ===== NOTIFICAÇÕES ===== */
async function criarNotificacao(usuarioId, tipo, titulo, mensagem, referencia = {}) {
    if (!pgDisponivel || !pgPool || !usuarioId) return null;
    try {
        const result = await pgPool.query(
            `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem, referencia)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, tipo, titulo, mensagem, referencia, criado_em`,
            [usuarioId, tipo, titulo, mensagem, JSON.stringify(referencia)]
        );
        const notificacao = result.rows[0];
        
        // Broadcast via SSE para o usuário
        broadcastNotificacao(usuarioId, notificacao);
        
        return notificacao;
    } catch (error) {
        console.error("ERRO ao criar notificação:", error.message);
        return null;
    }
}

async function listarNotificacoes(usuarioId, limite = 50) {
    if (!pgDisponivel || !pgPool || !usuarioId) return [];
    try {
        const result = await pgPool.query(
            `SELECT id, tipo, titulo, mensagem, referencia, lida_em, criado_em
               FROM notificacoes
              WHERE usuario_id = $1
              ORDER BY criado_em DESC
              LIMIT $2`,
            [usuarioId, limite]
        );
        return result.rows;
    } catch (error) {
        console.error("ERRO ao listar notificações:", error.message);
        return [];
    }
}

async function marcarNotificacaoLida(notificacaoId, usuarioId) {
    if (!pgDisponivel || !pgPool) return false;
    try {
        await pgPool.query(
            `UPDATE notificacoes SET lida_em = NOW() WHERE id = $1 AND usuario_id = $2`,
            [notificacaoId, usuarioId]
        );
        return true;
    } catch (error) {
        console.error("ERRO ao marcar notificação lida:", error.message);
        return false;
    }
}

async function marcarTodasNotificacoesLidas(usuarioId) {
    if (!pgDisponivel || !pgPool) return false;
    try {
        await pgPool.query(
            `UPDATE notificacoes SET lida_em = NOW() WHERE usuario_id = $1 AND lida_em IS NULL`,
            [usuarioId]
        );
        return true;
    } catch (error) {
        console.error("ERRO ao marcar todas notificações lidas:", error.message);
        return false;
    }
}

async function contarNotificacoesNaoLidas(usuarioId) {
    if (!pgDisponivel || !pgPool || !usuarioId) return 0;
    try {
        const result = await pgPool.query(
            `SELECT COUNT(*) as total FROM notificacoes WHERE usuario_id = $1 AND lida_em IS NULL`,
            [usuarioId]
        );
        return parseInt(result.rows[0].total, 10);
    } catch (error) {
        console.error("ERRO ao contar notificações:", error.message);
        return 0;
    }
}

/* Compra de um destaque no Story. */
app.post("/api/stories/destaques", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço de destaques indisponível no momento." });
    try {
        const duracao = String(req.body.duracao || "24h").trim();

        /* Valida preço contra config do banco (admin é a fonte de verdade). */
        const validacao = await validarPrecoStory(duracao);
        if (!validacao.ok) {
            return res.status(400).json({ error: validacao.erro });
        }
        const precoCents = validacao.precoCents;
        const preco = precoCents / 100;

        const comprador = normalizarDadosComprador(req.body);
        if (!comprador.documento || !validarDocumento(comprador.documento)) {
            return res.status(400).json({ error: "Informe um CPF ou CNPJ válido." });
        }

        const titulo = String(req.body.titulo || "").slice(0, 180).trim();
        if (!titulo) return res.status(400).json({ error: "Informe o título do seu destaque." });

        const subtitulo = String(req.body.subtitulo || "").slice(0, 240).trim();

        /* Link do anúncio — validado no backend */
        const link = normalizarLink(req.body.link || "");
        if (req.body.link && !link) {
            return res.status(400).json({ error: "Link do anúncio inválido. Use http(s):// ou um domínio válido." });
        }

        /* Imagem do destaque — apenas URL pública /uploads já validada no upload */
        const imagem = String(req.body.imagem || "").trim();
        if (imagem && !/^\/uploads\/[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(imagem)) {
            return res.status(400).json({ error: "Imagem do destaque inválida. Envie a foto pelo botão de upload." });
        }

        /* Espaço associado — validação server-side da propriedade */
        let espacoId = null;
        const pedidoEspaco = req.body.espacoId;
        if (pedidoEspaco !== undefined && pedidoEspaco !== null && String(pedidoEspaco) !== "") {
            const nid = Math.floor(Number(pedidoEspaco));
            if (!(nid >= 1 && nid <= 1000000)) {
                return res.status(400).json({ error: "Espaço associado inválido." });
            }
            const dbEspacos = readDB();
            const esp = dbEspacos[String(nid)];
            if (esp) {
                const dono = await usuarioEhDonoEspaco(req, esp);
                if (!dono) {
                    return res.status(403).json({ error: "Você só pode associar o destaque a um espaço seu." });
                }
            }
            espacoId = nid;
        }

        const orderId = "MEGA-STORY-" + crypto.randomUUID().slice(0, 8).toUpperCase();

        const mp = await criarOrderMercadoPago({
            idempotencyKey: orderId,
            externalReference: orderId,
            value: preco,
            description: `Milhão Door — Destaque no Story (${duracao})`,
            customer: {
                name: req.usuario.nome || comprador.nome,
                taxID: comprador.documento,
                email: comprador.email || req.usuario.email
            },
            paymentMethod: req.body.paymentMethod || "pix",
            paymentMethodId: req.body.paymentMethodId,
            cardToken: req.body.cardToken,
            installments: req.body.installments
        });

        const q = await pgPool.query(
            `INSERT INTO destaques
                (usuario_id, tipo, duracao, preco_cents, status, order_id, mp_order_id, payment_id, metodo_pagamento, titulo, subtitulo, imagem, link, espaco_id)
             VALUES ($1,$2,$3,$4,'pendente',$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING *`,
            [req.usuario.id, String(req.body.tipo || "story").slice(0, 20),
             duracao, precoCents, orderId, String(mp.orderId), String(mp.paymentId || ""),
             String(req.body.paymentMethod || "pix"), titulo, subtitulo,
             imagem || null, link, espacoId]
        );
        const destaque = q.rows[0];

        registrarLog("destaque_compra_criada", {
            destaqueId: destaque.id,
            usuarioId: req.usuario.id,
            duracao,
            orderId
        });

        res.json({
            ok: true,
            id: destaque.id,
            orderId: String(mp.orderId),
            externalReference: orderId,
            qrCodeBase64: mp.qrCodeBase64,
            payload: mp.payload,
            ticketUrl: mp.ticketUrl,
            expiresDate: mp.expirationDate,
            paymentId: mp.paymentId,
            total: preco,
            totalCents: precoCents,
            duracao,
            duracaoLabel: String(duracao).replace(/^(\d+)h$/i, "$1 horas")
        });
    } catch (error) {
        console.error("ERRO ao criar compra de destaque:", error.message);
        res.status(500).json({ error: "Não foi possível iniciar a compra do destaque. Tente novamente." });
    }
});

/* Meus destaques (status, tempo restante, publicações). */
app.get("/api/stories/destaques/meus", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço de destaques indisponível no momento." });
    try {
        await expirarDestaquesVencidos();
        const q = await pgPool.query(
            `SELECT id, tipo, duracao, preco_cents, status, publicado, titulo, subtitulo,
                    imagem, link, espaco_id, criado_em, pago_em, expira_em
               FROM destaques WHERE usuario_id = $1
              ORDER BY criado_em DESC LIMIT 50`,
            [req.usuario.id]
        );
        const agora = Date.now();
        res.json({
            ok: true,
            destaques: q.rows.map(d => ({
                id: d.id,
                tipo: d.tipo,
                duracao: d.duracao,
                preco: Number((d.preco_cents / 100).toFixed(2)),
                precoCents: Number(d.preco_cents),
                imagem: d.imagem || null,
                link: d.link || null,
                espacoId: d.espaco_id || null,
                status: d.status,
                publicado: d.publicado,
                titulo: d.titulo,
                subtitulo: d.subtitulo,
                criadoEm: d.criado_em,
                pagoEm: d.pago_em,
                expiraEm: d.expira_em,
                tempoRestanteSegundos: d.expira_em ? Math.max(0, Math.floor((new Date(d.expira_em).getTime() - agora) / 1000)) : null
            }))
        });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível carregar seus destaques." });
    }
});

/* Consulta do pagamento de um destaque (polling). */
app.get("/api/stories/destaques/:id", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço de destaques indisponível no momento." });
    try {
        const q = await pgPool.query(
            `SELECT * FROM destaques WHERE id = $1 AND usuario_id = $2`,
            [Number(req.params.id), req.usuario.id]
        );
        const destaque = q.rows[0];
        if (!destaque) return res.status(404).json({ error: "Destaque não encontrado." });

        if (destaque.status === "pendente" && destaque.mp_order_id) {
            try {
                const ordem = await consultarOrderMercadoPago(destaque.mp_order_id);
                if (orderPagaMercadoPago(ordem)) {
                    await processarPagamentoDestaque({
                        mpOrderId: destaque.mp_order_id,
                        totalCents: Number(ordem.total_amount || 0)
                    });
                }
            } catch (e) { /* consulta falhou — mantém pendente */ }
        }
        await expirarDestaquesVencidos();

        const atualizado = await pgPool.query(
            `SELECT id, tipo, duracao, preco_cents, status, publicado, titulo, subtitulo,
                    imagem, link, espaco_id, criado_em, pago_em, expira_em
               FROM destaques WHERE id = $1`,
            [destaque.id]
        );
        const d = atualizado.rows[0];
        const agora = Date.now();
        res.json({
            ok: true,
            destaque: {
                id: d.id,
                tipo: d.tipo,
                duracao: d.duracao,
                status: d.status,
                publicado: d.publicado,
                titulo: d.titulo,
                subtitulo: d.subtitulo,
                imagem: d.imagem || null,
                link: d.link || null,
                espacoId: d.espaco_id || null,
                criadoEm: d.criado_em,
                pagoEm: d.pago_em,
                expiraEm: d.expira_em,
                tempoRestanteSegundos: d.expira_em ? Math.max(0, Math.floor((new Date(d.expira_em).getTime() - agora) / 1000)) : null
            }
        });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível consultar o destaque." });
    }
});

/* Publica/atualiza o conteúdo do destaque (somente se pago e ativo). */
app.post("/api/stories/destaques/:id/publicar", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço de destaques indisponível no momento." });
    try {
        const q = await pgPool.query(
            `SELECT * FROM destaques WHERE id = $1 AND usuario_id = $2`,
            [Number(req.params.id), req.usuario.id]
        );
        const destaque = q.rows[0];
        if (!destaque) return res.status(404).json({ error: "Destaque não encontrado." });

        const titulo = String(req.body.titulo ?? destaque.titulo ?? "").slice(0, 180).trim();
        const subtitulo = String(req.body.subtitulo ?? destaque.subtitulo ?? "").slice(0, 240).trim();
        if (!titulo) return res.status(400).json({ error: "Informe o título do seu destaque." });

        /* Link editável na publicação */
        let link = destaque.link;
        if (req.body.link !== undefined) {
            const normLink = normalizarLink(req.body.link || "");
            if (req.body.link && !normLink) {
                return res.status(400).json({ error: "Link do anúncio inválido." });
            }
            link = normLink;
        }

        /* Imagem editável na publicação */
        let imagem = destaque.imagem;
        if (req.body.imagem !== undefined) {
            const img = String(req.body.imagem || "").trim();
            if (img && !/^\/uploads\/[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(img)) {
                return res.status(400).json({ error: "Imagem do destaque inválida." });
            }
            imagem = img || null;
        }

        /* Espaço associado editável na publicação */
        let espacoId = destaque.espaco_id;
        if (req.body.espacoId !== undefined && req.body.espacoId !== null && String(req.body.espacoId) !== "") {
            const nid = Math.floor(Number(req.body.espacoId));
            if (!(nid >= 1 && nid <= 1000000)) {
                return res.status(400).json({ error: "Espaço associado inválido." });
            }
            const dbEspacos = readDB();
            const esp = dbEspacos[String(nid)];
            if (esp) {
                const dono = await usuarioEhDonoEspaco(req, esp);
                if (!dono) {
                    return res.status(403).json({ error: "Você só pode associar o destaque a um espaço seu." });
                }
            }
            espacoId = nid;
        } else if (req.body.espacoId === null) {
            espacoId = null;
        }

        if (destaque.status !== "ativo") {
            return res.status(403).json({ error: destaque.status === "expirado" ? "Este destaque expirou. Adquira novamente para publicar." : "Aguardando a confirmação do pagamento para publicar." });
        }

        await pgPool.query(
            `UPDATE destaques SET titulo = $2, subtitulo = $3, link = $4, imagem = $5, espaco_id = $6 WHERE id = $1`,
            [destaque.id, titulo, subtitulo, link, imagem, espacoId]
        );
        const ok = await publicarDestaque(destaque.id);
        if (!ok) return res.status(400).json({ error: "Não foi possível publicar o destaque agora. Tente novamente." });
        res.json({ ok: true, mensagem: "Destaque publicado!" });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível publicar o destaque." });
    }
});

/* =========================
   ÚLTIMAS COMPRAS (Feed Público)
========================= */

/* Lista as últimas compras públicas para o feed */
app.get("/api/ultimas-compras", async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const limite = Math.min(50, Math.max(1, parseInt(req.query.limite) || 20));
        
        const result = await pgPool.query(
            `SELECT uc.*, u.apelido, u.foto_url
             FROM ultimas_compras uc
             LEFT JOIN usuarios u ON u.id = uc.usuario_id
             WHERE uc.expira_em > NOW() AND uc.visivel = TRUE
             ORDER BY uc.criado_em DESC
             LIMIT $1`,
            [limite]
        );
        
        const agora = Date.now();
        const compras = result.rows.map(c => ({
            id: c.id,
            usuarioId: c.usuario_id,
            apelido: c.apelido || `Usuário ${c.id}`,
            fotoUrl: c.foto_url,
            tipo: c.tipo,
            descricao: c.descricao,
            quantidade: c.quantidade,
            valorCents: c.valor_cents,
            espacos: c.espacos,
            criadoEm: c.criado_em,
            tempoAtrasSegundos: Math.floor((agora - new Date(c.criado_em).getTime()) / 1000)
        }));
        
        res.json({ compras });
    } catch (error) {
        console.error("ERRO ao listar últimas compras:", error.message);
        res.status(500).json({ error: "Não foi possível listar últimas compras." });
    }
});

/* Registra uma nova compra no feed (chamado após confirmação de pagamento) */
async function registrarUltimaCompra(usuarioId, tipo, descricao, quantidade, valorCents, espacos = []) {
    if (!pgDisponivel || !pgPool) return null;
    try {
        const result = await pgPool.query(
            `INSERT INTO ultimas_compras (usuario_id, tipo, descricao, quantidade, valor_cents, espacos)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [usuarioId, tipo, descricao, quantidade, valorCents, espacos]
        );
        return result.rows[0];
    } catch (error) {
        console.error("ERRO ao registrar última compra:", error.message);
        return null;
    }
}

/* =========================
   STORIES - LISTA PÚBLICA
========================= */

/* Lista stories ativos para exibição pública */
app.get("/api/stories", async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const result = await pgPool.query(
            `SELECT d.*, u.apelido, u.foto_url
             FROM destaques d
             LEFT JOIN usuarios u ON u.id = d.usuario_id
             WHERE d.status = 'ativo' AND d.publicado = TRUE AND d.expira_em > NOW()
             ORDER BY d.pago_em DESC
             LIMIT 50`
        );
        
        const agora = Date.now();
        const stories = result.rows.map(s => ({
            id: s.id,
            usuarioId: s.usuario_id,
            apelido: s.apelido || `Usuário ${s.id}`,
            fotoUrl: s.foto_url,
            imagem: s.imagem || null,
            tipo: s.tipo,
            duracao: s.duracao,
            titulo: s.titulo,
            subtitulo: s.subtitulo,
            criadoEm: s.criado_em,
            pagoEm: s.pago_em,
            expiraEm: s.expira_em,
            tempoRestanteSegundos: s.expira_em ? Math.max(0, Math.floor((new Date(s.expira_em).getTime() - agora) / 1000)) : 0
        }));
        
        res.json({ stories });
    } catch (error) {
        console.error("ERRO ao listar stories:", error.message);
        res.status(500).json({ error: "Não foi possível listar stories." });
    }
});

/* Configuração pública dos preços de stories */
app.get("/api/stories/config", async (req, res) => {
    const config = await getStoryPricingConfig();
    const pricing = {};
    const duracoes = [];
    for (const c of config) {
        pricing[c.duracao] = c.precoCents / 100;
        if (c.ativo) duracoes.push(c.duracao);
    }
    res.json({
        pricing,
        duracoes,
        config
    });
});

/* =========================
   NOTIFICAÇÕES
========================= */

app.get("/api/notificacoes", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível no momento." });
    try {
        const notificacoes = await listarNotificacoes(req.usuario.id, 50);
        const naoLidas = await contarNotificacoesNaoLidas(req.usuario.id);
        res.json({ ok: true, notificacoes, naoLidas });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível carregar notificações." });
    }
});

app.post("/api/notificacoes/:id/lida", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível no momento." });
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "ID inválido." });
        await marcarNotificacaoLida(id, req.usuario.id);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível marcar notificação." });
    }
});

app.post("/api/notificacoes/lidas", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível no momento." });
    try {
        await marcarTodasNotificacoesLidas(req.usuario.id);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível marcar notificações." });
    }
});

app.get("/api/notificacoes/contador", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível no momento." });
    try {
        const total = await contarNotificacoesNaoLidas(req.usuario.id);
        res.json({ ok: true, total });
    } catch (error) {
        res.status(500).json({ error: "Não foi possível contar notificações." });
    }
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

async function obterContaMarketplace(usuarioId) {
    if (!pgDisponivel || !pgPool || !usuarioId) return null;
    const q = await pgPool.query(
        `SELECT id, usuario_id, seller_user_id, public_key, expires_at, connected_at,
                access_token_enc, refresh_token_enc
           FROM marketplace_accounts WHERE usuario_id = $1`,
        [usuarioId]
    );
    const account = q.rows[0] || null;
    if (!account) return null;
    if (account.expires_at && new Date(account.expires_at).getTime() <= Date.now() + 60000 && account.refresh_token_enc && MERCADOPAGO_CLIENT_ID && MERCADOPAGO_CLIENT_SECRET) {
        const refreshToken = descriptografarMarketplace(account.refresh_token_enc);
        if (refreshToken) {
            try {
                const response = await fetch("https://api.mercadopago.com/oauth/token", {
                    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ client_id: MERCADOPAGO_CLIENT_ID, client_secret: MERCADOPAGO_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }).toString()
                });
                const data = await response.json();
                if (response.ok && data.access_token) {
                    await pgPool.query(
                        `UPDATE marketplace_accounts SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), expires_at = NOW() + (INTERVAL '1 second' * $4), updated_at = NOW() WHERE usuario_id = $1`,
                        [usuarioId, criptografarMarketplace(data.access_token), data.refresh_token ? criptografarMarketplace(data.refresh_token) : null, Number(data.expires_in || 15552000)]
                    );
                    account.expires_at = new Date(Date.now() + Number(data.expires_in || 15552000) * 1000);
                }
            } catch (error) { console.error("ERRO ao renovar conexão Mercado Pago:", error.message); }
        }
    }
    delete account.access_token_enc;
    delete account.refresh_token_enc;
    return account;
}

async function obterContaMarketplacePrivada(usuarioId) {
    await obterContaMarketplace(usuarioId);
    if (!pgDisponivel || !pgPool || !usuarioId) return null;
    const q = await pgPool.query(
        `SELECT id, usuario_id, seller_user_id, public_key, expires_at, connected_at,
                access_token_enc, refresh_token_enc
           FROM marketplace_accounts WHERE usuario_id = $1`,
        [usuarioId]
    );
    const account = q.rows[0];
    if (!account) return null;
    return {
        id: account.id,
        usuarioId: account.usuario_id,
        sellerUserId: account.seller_user_id,
        publicKey: account.public_key,
        expiresAt: account.expires_at,
        accessToken: descriptografarMarketplace(account.access_token_enc),
        refreshToken: descriptografarMarketplace(account.refresh_token_enc)
    };
}

app.get("/api/marketplace/oauth/connect", authUsuario, async (req, res) => {
    if (!MERCADOPAGO_CLIENT_ID || !MERCADOPAGO_CLIENT_SECRET || !MERCADOPAGO_REDIRECT_URI || !pgDisponivel || !pgPool) {
        return res.status(503).json({ error: "OAuth do Mercado Pago ainda não foi configurado no ambiente." });
    }
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    try {
        await pgPool.query(`DELETE FROM marketplace_oauth_states WHERE expires_at <= NOW()`);
        await pgPool.query(
        `INSERT INTO marketplace_oauth_states (state, usuario_id, verifier_enc, expires_at)
         VALUES ($1,$2,$3,NOW() + INTERVAL '10 minutes')`,
        [state, req.usuario.id, criptografarMarketplace(verifier)]
        );
        const params = new URLSearchParams({
            client_id: MERCADOPAGO_CLIENT_ID,
            response_type: "code",
            platform_id: "mp",
            redirect_uri: MERCADOPAGO_REDIRECT_URI,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256"
        });
        console.log(`[oauth-connect] usuario_id=${req.usuario.id} redirect_uri=${MERCADOPAGO_REDIRECT_URI}`);
        const authorizationUrl = "https://auth.mercadopago.com.br/authorization?" + params.toString();
        if (String(req.headers.accept || "").includes("application/json")) {
            return res.json({ ok: true, authorizationUrl });
        }
        return res.redirect(authorizationUrl);
    } catch (error) {
        console.error("ERRO ao iniciar OAuth Mercado Pago:", error.message);
        return res.status(500).json({ error: "Não foi possível iniciar a conexão Mercado Pago." });
    }
});

app.get("/api/marketplace/oauth/callback", async (req, res) => {
    let oauthClient = null;
    const sanitize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const log = (message) => console.log("[oauth-callback]", sanitize(message));
    try {
        const code = String(req.query.code || "");
        const state = String(req.query.state || "");
        const oauthError = String(req.query.error || "");
        const oauthErrorDescription = String(req.query.error_description || "");
        log(`callback recebido | code=${code ? "presente" : "ausente"} | state=${state ? "presente" : "ausente"} | erro_mp=${oauthError || "nenhum"}`);
        if (oauthError) {
            log(`Mercado Pago recusou a autorização: ${oauthError} ${oauthErrorDescription}`);
            return res.redirect("/colecionaveis.html?mercadopago=error");
        }
        if (!code || !state) {
            log("code ou state ausente no callback");
            return res.status(400).send("Autorização inválida.");
        }
        if (!MERCADOPAGO_CLIENT_ID || !MERCADOPAGO_CLIENT_SECRET || !MERCADOPAGO_REDIRECT_URI || !pgDisponivel || !pgPool) {
            log("OAuth não configurado no ambiente");
            return res.status(503).send("OAuth não configurado.");
        }
        oauthClient = await pgPool.connect();
        await oauthClient.query("BEGIN");
        const stateQ = await oauthClient.query(
            `SELECT state, usuario_id, verifier_enc FROM marketplace_oauth_states
              WHERE state = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
            [state]
        );
        if (!stateQ.rows[0]) {
            await oauthClient.query("ROLLBACK");
            log("state inválido, expirado ou já utilizado");
            return res.status(400).send("Estado OAuth inválido ou já utilizado.");
        }
        const oauthState = stateQ.rows[0];
        const verifier = descriptografarMarketplace(oauthState.verifier_enc);
        if (!verifier) {
            await oauthClient.query("ROLLBACK");
            log("verifier não pôde ser descriptografado");
            return res.status(400).send("Estado OAuth inválido.");
        }
        log("state validado para usuario_id=" + oauthState.usuario_id);
        await oauthClient.query("UPDATE marketplace_oauth_states SET used_at = NOW() WHERE state = $1", [state]);
        await oauthClient.query("COMMIT");
        oauthClient.release();
        oauthClient = null;
        log("trocando authorization code por access token");
        const response = await fetch("https://api.mercadopago.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: MERCADOPAGO_CLIENT_ID,
                client_secret: MERCADOPAGO_CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: MERCADOPAGO_REDIRECT_URI,
                code_verifier: verifier
            }).toString()
        });
        const data = await response.json();
        log(`token MP respondeu HTTP ${response.status}`);
        if (!response.ok) {
            log(`falha na troca do code: ${data.error || response.status} ${data.error_description || ""}`);
            return res.status(502).send("Não foi possível concluir a conexão Mercado Pago.");
        }
        if (!data.access_token || !data.user_id) {
            log("resposta da troca sem access_token ou user_id");
            return res.status(502).send("Não foi possível concluir a conexão Mercado Pago.");
        }
        await pgPool.query(
            `INSERT INTO marketplace_accounts
                (usuario_id, seller_user_id, access_token_enc, refresh_token_enc, public_key, expires_at)
             VALUES ($1,$2,$3,$4,$5,NOW() + (INTERVAL '1 second' * $6))
             ON CONFLICT (usuario_id) DO UPDATE SET
                seller_user_id = EXCLUDED.seller_user_id,
                access_token_enc = EXCLUDED.access_token_enc,
                refresh_token_enc = EXCLUDED.refresh_token_enc,
                public_key = EXCLUDED.public_key,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()`,
            [oauthState.usuario_id, String(data.user_id), criptografarMarketplace(data.access_token), criptografarMarketplace(data.refresh_token), data.public_key || null, Number(data.expires_in || 15552000)]
        );
        log(`conta conectada com sucesso para usuario_id=${oauthState.usuario_id}`);
        res.redirect("/colecionaveis.html?mercadopago=connected");
    } catch (error) {
        if (oauthClient) { try { await oauthClient.query("ROLLBACK"); } catch(e) {} oauthClient.release(); }
        log("erro interno: " + error.message);
        res.status(400).send("Não foi possível concluir a autorização Mercado Pago.");
    }
});

app.get("/api/marketplace/account", authUsuario, async (req, res) => {
    const account = await obterContaMarketplace(req.usuario.id);
    res.json({ ok: true, connected: !!account, account: account ? { sellerUserId: account.seller_user_id, connectedAt: account.connected_at } : null });
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

        /* =========================
           BENEFÍCIO DE INDICAÇÃO (10%)
        ========================= */

        let beneficioIndicacao = null;
        let descontoIndicacaoPct = 0;

        if (req.usuario && req.usuario.id) {
            try {
                const benefResult = await pgPool.query(
                    `SELECT id, percentual_desconto FROM beneficios_indicacao 
                     WHERE indicado_id = $1 AND status = 'PENDENTE' 
                     ORDER BY criado_em DESC LIMIT 1`,
                    [req.usuario.id]
                );
                if (benefResult.rowCount > 0) {
                    beneficioIndicacao = benefResult.rows[0];
                    descontoIndicacaoPct = beneficioIndicacao.percentual_desconto || 10;
                }
            } catch (e) {
                console.error("ERRO ao verificar benefício de indicação:", e.message);
            }
        }

        /* O cliente ganha o melhor desconto: progressivo, cupom ou indicação.
           O desconto é aplicado apenas sobre o valor base dos blocos;
           a taxa de licença é cobrada uma única vez por pedido. */
        const descontoPct =
            Math.max(descontoProgressivoPct, descontoCupomPct, descontoIndicacaoPct);

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
                issuerId: req.body.issuerId,
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
            aceiteRegras,
            storyOptIn: req.body.storyOptIn === true || req.body.storyOptIn === "true"
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
                `Olá, <b>${escapeHtml(name.trim())}</b>! Você reservou ` +
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
            issuerId: req.body.issuerId,
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
                usuarioId: req.usuario.id,
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
            error: "Erro interno do servidor."
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
            const pago = orderPagaMercadoPago(order);

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
            error: "Erro interno do servidor."
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
            error: "Erro interno do servidor."
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
            error: "Erro interno do servidor."
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

    const paymentId = paymentIdOrOrderId;

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
            error: "Erro interno do servidor."
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
                `Oferta para o ${escapeHtml(resumoEspacos)}:</p>` +
                `<div style="font-size:14px;color:#333;">` +
                `Comprador: <b>${escapeHtml(name.trim())}</b><br>` +
                `Valor da oferta: ` +
                `<b style="color:#15803d;">` +
                `R$ ${Number(value).toLocaleString("pt-BR")}</b><br>` +
                (message
                    ? `Mensagem: ${escapeHtml(message.trim())}<br>`
                    : "") +
                `E-mail do comprador: ${escapeHtml(email.trim())}` +
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
            error: "Erro interno do servidor."
        });
    }
});

/* Ofertas do usuário logado (como comprador OU como proprietário).
   Formato: { ofertas: [...] } com comprador_nome/vendedor_nome para o painel da dashboard. */
app.get("/api/offers", authUsuario, (req, res) => {

    const db = readDB();
    const ofertas = readOffers();

    const emailUsuario = (req.usuario.email || "").trim().toLowerCase();
    const tokensUsuario =
        Object.values(db)
            .filter(s => s.email && (s.email || "").trim().toLowerCase() === emailUsuario)
            .map(s => s.orderToken)
            .filter(Boolean);

    const ativos = new Set(["pending", "countered", "accepted", "paid"]);

    const lista =
        Object.values(ofertas)
            .filter(o => {
                const alvos =
                    (Array.isArray(o.spaceIds) && o.spaceIds.length)
                    ? o.spaceIds
                    : [o.spaceId];
                const souComprador =
                    (o.email || "").trim().toLowerCase() === emailUsuario;
                const souDono =
                    tokensUsuario.length &&
                    alvos.some(s => {
                        const esp = db[s];
                        return esp && tokensUsuario.includes(esp.orderToken);
                    });
                return (souComprador || souDono) && ativos.has(o.status);
            })
            .map(o => {
                const alvos =
                    (Array.isArray(o.spaceIds) && o.spaceIds.length)
                    ? o.spaceIds
                    : [o.spaceId];
                const souComprador =
                    (o.email || "").trim().toLowerCase() === emailUsuario;
                return {
                    id: o.id,
                    espacos: alvos.length,
                    valor: o.value,
                    originalValue: o.originalValue || o.value,
                    status: o.status,
                    message: o.message || "",
                    comprador_nome: o.name || "—",
                    vendedor_nome: souComprador ? "Compra" : "Venda",
                    createdAt: o.createdAt,
                    spaceId: o.spaceId,
                    spaceIds: alvos
                };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({ ok: true, ofertas: lista });
});

/* Cancela uma oferta enviada pelo próprio comprador (ou pelo dono). */
app.post("/api/offers/:id/cancel", authUsuario, (req, res) => {

    const ofertas = readOffers();
    const oferta = ofertas[req.params.id];

    if (!oferta) {
        return res.status(404).json({ error: "Oferta não encontrada." });
    }

    if (oferta.status !== "pending" && oferta.status !== "countered") {
        return res.status(400).json({
            error: "Só é possível cancelar ofertas ainda pendentes."
        });
    }

    const emailUsuario = (req.usuario.email || "").trim().toLowerCase();
    const souComprador = (oferta.email || "").trim().toLowerCase() === emailUsuario;

    let souDono = false;
    if (!souComprador) {
        const db = readDB();
        const alvos =
            (Array.isArray(oferta.spaceIds) && oferta.spaceIds.length)
            ? oferta.spaceIds
            : [oferta.spaceId];
        const tokensUsuario =
            Object.values(db)
                .filter(s => s.email && (s.email || "").trim().toLowerCase() === emailUsuario)
                .map(s => s.orderToken)
                .filter(Boolean);
        souDono =
            tokensUsuario.length &&
            alvos.some(s => {
                const esp = db[s];
                return esp && tokensUsuario.includes(esp.orderToken);
            });
    }

    if (!souComprador && !souDono) {
        return res.status(403).json({ error: "Você não pode cancelar esta oferta." });
    }

    oferta.status = "cancelled";
    oferta.cancelledAt = new Date().toISOString();
    writeOffers(ofertas);

    res.json({ ok: true, offerId: oferta.id, status: "cancelled" });
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
            `Sua oferta para o ${escapeHtml(resumoEspacos)} foi aceita`,
            htmlNotificacao(
                "🎉 Oferta aceita — pagamento direto",
                `<p style="margin:0 0 10px;color:#444;font-size:14px;">` +
                `Sua oferta de ` +
                `<b style="color:#15803d;">` +
                `R$ ${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                `para o ${escapeHtml(resumoEspacos)} foi aceita.</p>` +
                `<p style="margin:0 0 8px;color:#444;font-size:14px;">` +
                `Pague <b>R$ ` +
                `${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                `diretamente ao proprietário na chave Pix:</p>` +
                `<div style="background:#f7f7f7;border-radius:8px;` +
                `padding:12px;font-size:14px;color:#333;word-break:break-all;">` +
                `${escapeHtml(minhaChave)}</div>` +
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
                `para o ${escapeHtml(resumoEspacos)}`,
                htmlNotificacao(
                    "✅ Contraproposta aceita",
                    `<p style="margin:0;color:#444;font-size:14px;">` +
                    `O comprador <b>${escapeHtml(oferta.name)}</b> aceitou sua ` +
                    `contraproposta de ` +
                    `<b style="color:#15803d;">` +
                    `R$ ${Number(oferta.value).toLocaleString("pt-BR")}</b> ` +
                    `para o ${escapeHtml(resumoEspacos)}.</p>` +
                    `<p style="margin:8px 0 0;color:#666;font-size:13px;">` +
                    `O comprador pagará o valor direto na sua chave Pix ` +
                    `(${escapeHtml(chaveDono) || "chave cadastrada"}) e a taxa de ` +
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
            error: "Erro interno do servidor."
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
                `O comprador <b>${escapeHtml(oferta.name)}</b> recusou sua ` +
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
   STREAM DE NOTIFICAÇÕES (SSE)
   Notificações em tempo real
========================= */

const notificacoesListeners = new Map(); // usuarioId -> Set<response>

function broadcastNotificacao(usuarioId, notificacao) {
    if (!usuarioId) return;
    const set = notificacoesListeners.get(usuarioId);
    if (!set || !set.size) return;
    const dados = `data: ${JSON.stringify(notificacao)}\n\n`;
    for (const res of set) {
        try {
            res.write(dados);
        } catch (e) {}
    }
}

app.get("/api/notificacoes/stream", authUsuario, (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });

    res.write(":ok\n\n");

    const set = notificacoesListeners.get(req.usuario.id) || new Set();
    set.add(res);
    notificacoesListeners.set(req.usuario.id, set);

    req.on("close", () => {
        set.delete(res);
        if (!set.size) {
            notificacoesListeners.delete(req.usuario.id);
        }
    });
});

/* =========================
   CONTAGEM P�BLICA DE USU�RIOS
========================= */

app.get("/api/usuarios/contagem", async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.json({ ok: true, total: 0 });
    try {
        const result = await pgPool.query(
            `SELECT COUNT(*)::int AS total FROM usuarios WHERE bloqueado = FALSE`
        );
        res.json({ ok: true, total: result.rows[0].total || 0 });
    } catch (error) {
        console.error("ERRO ao contar usu�rios:", error.message);
        res.status(500).json({ error: "N�o foi poss�vel contar os usu�rios." });
    }
});

/* =========================================================
   BUSCA DE ANUNCIANTES — OUTDOOR DIGITAL PESQUISÁVEL
   Uma única fonte alimenta a busca geral e a busca no mapa
   expandido. Expõe SOMENTE espaços públicos (status published):
   nunca dados privados, administrativos ou de pagamento.
========================================================= */

const CATEGORIAS_ANUNCIANTE = [
    "EMPRESAS",
    "SERVIÇOS",
    "PESSOAS",
    "REDES_SOCIAIS",
    "OUTROS"
];

function normalizarTextoBusca(str) {
    return String(str || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

let _dbBuscaCache = null;
function readDBCached() {
    if (_dbBuscaCache === null) _dbBuscaCache = readDB();
    return _dbBuscaCache;
}
function invalidarDBBuscaCache() {
    _dbBuscaCache = null;
}

function agruparBlocosContiguos(ids) {
    const conjunto = new Set(ids);
    const blocos = [];
    const visitados = new Set();
    for (const id of ids) {
        if (visitados.has(id)) continue;
        const grupo = [id];
        visitados.add(id);
        const fila = [id];
        while (fila.length) {
            const atual = fila.shift();
            const indice = atual - 1;
            const linha = Math.floor(indice / 1000);
            const coluna = indice % 1000;
            const vizinhos = [];
            if (coluna > 0) vizinhos.push(atual - 1);
            if (coluna < 999) vizinhos.push(atual + 1);
            if (linha > 0) vizinhos.push(atual - 1000);
            if (linha < 999) vizinhos.push(atual + 1000);
            for (const v of vizinhos) {
                if (!conjunto.has(v) || visitados.has(v)) continue;
                visitados.add(v);
                grupo.push(v);
                fila.push(v);
            }
        }
        grupo.sort((a, b) => a - b);
        blocos.push(grupo);
    }
    return blocos;
}

function construirIndiceAnunciantes() {
    const db = readDBCached();
    const grupos = new Map();
    for (const sid in db) {
        const s = db[sid];
        if (!s || s.status !== "published") continue;
        const chave = s.orderToken || ("esp:" + sid);
        let g = grupos.get(chave);
        if (!g) {
            g = {
                chave,
                espacos: [],
                titulo: "",
                categoria: "",
                segmento: "",
                descricao: "",
                palavrasChave: [],
                links: [],
                nomeDono: "",
                usuarioId: null,
                image: ""
            };
            grupos.set(chave, g);
        }
        g.espacos.push(Number(sid));
        if (!g.titulo && s.title) g.titulo = String(s.title).trim();
        if (!g.categoria && s.categoria) g.categoria = String(s.categoria);
        if (!g.segmento && s.segmento) g.segmento = String(s.segmento).trim();
        if (!g.descricao && s.descricao) g.descricao = String(s.descricao).trim();
        if (!g.nomeDono && s.name) g.nomeDono = String(s.name).trim();
        if (!g.usuarioId && s.usuarioId) g.usuarioId = Number(s.usuarioId) || null;
        if (!g.image && s.image) g.image = String(s.image);
        const pc = Array.isArray(s.palavras_chave) ? s.palavras_chave : [];
        for (const p of pc) {
            const t = String(p || "").trim();
            if (t && !g.palavrasChave.includes(t)) g.palavrasChave.push(t);
        }
        const links = Array.isArray(s.links) ? s.links : [];
        for (const l of links) {
            if (!l || !l.url) continue;
            if (l.publico === false) continue;
            g.links.push({
                url: String(l.url),
                tipo: String(l.tipo || ""),
                rotulo: String(l.rotulo || ""),
                categoria: String(l.categoria || ""),
                segmento: String(l.segmento || "")
            });
        }
        if (s.link) {
            const jaTem = g.links.some(l => l.url === String(s.link));
            if (!jaTem) {
                g.links.push({
                    url: String(s.link),
                    tipo: "site",
                    rotulo: "Site",
                    categoria: g.categoria || "EMPRESAS",
                    segmento: g.segmento || ""
                });
            }
        }
    }
    const resultado = [];
    for (const g of grupos.values()) {
        const espacos = g.espacos.sort((a, b) => a - b);
        resultado.push(Object.assign({}, g, { espacos, blocos: agruparBlocosContiguos(espacos) }));
    }
    return resultado;
}

function pontuarAnunciante(g, termos, numeros) {
    let score = 0;
    const tituloNorm = normalizarTextoBusca(g.titulo);
    const segmentoNorm = normalizarTextoBusca(g.segmento);
    const descNorm = normalizarTextoBusca(g.descricao);
    const nomeNorm = normalizarTextoBusca(g.nomeDono);
    const catNorm = normalizarTextoBusca(g.categoria);
    const kwNorm = normalizarTextoBusca((g.palavrasChave || []).join(" "));
    const linksNorm = normalizarTextoBusca(
        (g.links || []).map(l => (l.url || "") + " " + (l.rotulo || "") + " " + (l.tipo || "")).join(" ")
    );
    const tudoNorm = tituloNorm + " " + segmentoNorm + " " + nomeNorm + " " + kwNorm + " " + descNorm;

    for (const termo of termos) {
        if (tituloNorm === termo) score += 100;
        else if (tituloNorm.startsWith(termo)) score += 85;
        else if (tituloNorm.includes(termo)) score += 70;
        if (segmentoNorm === termo) score += 60;
        else if (segmentoNorm.includes(termo)) score += 55;
        if (nomeNorm.includes(termo)) score += 60;
        if (kwNorm.includes(termo)) score += 50;
        if (descNorm.includes(termo)) score += 40;
        if (catNorm.includes(termo)) score += 45;
        if (linksNorm.includes(termo)) score += 30;
        if (tudoNorm.includes(termo)) score += 20;
    }
    for (const n of numeros) {
        if (g.espacos.indexOf(n) >= 0) score += 90;
    }
    return score;
}

app.get("/api/busca", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        const cat = String(req.query.categoria || "").trim();
        const seg = String(req.query.segmento || "").trim();
        const limite = Math.min(50, Math.max(1, parseInt(req.query.limite, 10) || 20));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

        const indices = construirIndiceAnunciantes();
        const catNormReq = cat ? normalizarTextoBusca(cat) : "";
        let alvo = indices;

        if (catNormReq && catNormReq !== "todos") {
            alvo = alvo.filter(g => normalizarTextoBusca(g.categoria) === catNormReq);
        }
        if (seg) {
            const segNorm = normalizarTextoBusca(seg);
            alvo = alvo.filter(g => normalizarTextoBusca(g.segmento).indexOf(segNorm) >= 0);
        }

        let total = alvo.length;
        let resultados;
        if (q) {
            const termos = q.split(/\s+/).map(normalizarTextoBusca).filter(Boolean);
            const numeros = [];
            const nums = q.match(/\d+/g);
            if (nums) {
                for (const n of nums) {
                    const ni = Number(n);
                    if (ni >= 1 && ni <= 1000000) numeros.push(ni);
                }
            }
            const comScore = [];
            for (const g of alvo) {
                const score = pontuarAnunciante(g, termos, numeros);
                if (score > 0) comScore.push({ g, score });
            }
            comScore.sort((a, b) => (b.score - a.score) || (b.g.espacos.length - a.g.espacos.length) || a.g.titulo.localeCompare(b.g.titulo));
            total = comScore.length;
            resultados = comScore.slice(offset, offset + limite).map(x => x.g);
        } else {
            alvo.sort((a, b) => (b.espacos.length - a.espacos.length) || a.titulo.localeCompare(b.titulo));
            resultados = alvo.slice(offset, offset + limite);
        }

        const resposta = resultados.map(g => ({
            anunciante: g.titulo || g.nomeDono || "Anunciante",
            titulo: g.titulo,
            categoria: g.categoria || "OUTROS",
            segmento: g.segmento,
            descricao: g.descricao,
            palavrasChave: g.palavrasChave,
            links: g.links,
            nomeDono: g.nomeDono,
            usuarioId: g.usuarioId,
            image: g.image,
            espacos: g.espacos,
            blocos: g.blocos,
            qtdEspacos: g.espacos.length
        }));

        res.json({ ok: true, total, limite, offset, resultados: resposta });
    } catch (error) {
        console.error("ERRO na busca de anunciantes:", error.message);
        res.status(500).json({ error: "Não foi possível realizar a busca." });
    }
});

/* Salva os dados públicos de pesquisa do anúncio de um espaço
   (categoria, segmento, descrição, palavras-chave e links).
   Escopo "solo" aplica ao espaço; "bloco" aplica a todo o bloco. */
app.post("/api/anuncio/dados/:id", authOpcional, async (req, res) => {
    try {
        const id = Number(String(req.params.id || ""));
        if (!Number.isInteger(id) || id < 1 || id > 1000000) {
            return res.status(400).json({ error: "Espaço inválido." });
        }
        const db = readDB();
        if (!db[id]) {
            return res.status(404).json({ error: "Espaço não encontrado." });
        }
        if (db[id].status !== "paid" && db[id].status !== "published") {
            return res.status(403).json({ error: "O espaço ainda não está publicado." });
        }
        if (!(await usuarioEhDonoEspaco(req, db[id]))) {
            return res.status(403).json({ error: "Você não é o proprietário do espaço." });
        }

        const cat = String(req.body.categoria || "").trim().toUpperCase();
        if (cat && CATEGORIAS_ANUNCIANTE.indexOf(cat) < 0) {
            return res.status(400).json({ error: "Categoria inválida." });
        }
        const segmento = String(req.body.segmento || "").trim().slice(0, 120);
        const descricao = String(req.body.descricao || "").trim().slice(0, 400);

        let palavras = req.body.palavras_chave;
        if (typeof palavras === "string") {
            palavras = palavras.split(/[,;]/).map(s => s.trim()).filter(Boolean);
        }
        if (!Array.isArray(palavras)) palavras = [];
        palavras = palavras.map(p => String(p).trim().slice(0, 40)).filter(Boolean).slice(0, 30);

        const linksInput = Array.isArray(req.body.links) ? req.body.links : [];
        const links = [];
        for (const l of linksInput.slice(0, 10)) {
            if (!l || typeof l !== "object") continue;
            const url = normalizarLink(l.url);
            if (!url) continue;
            const lCat = String(l.categoria || "").trim().toUpperCase();
            if (lCat && CATEGORIAS_ANUNCIANTE.indexOf(lCat) < 0) continue;
            links.push({
                url,
                tipo: String(l.tipo || "").trim().slice(0, 30),
                rotulo: String(l.rotulo || "").trim().slice(0, 60),
                categoria: lCat,
                segmento: String(l.segmento || "").trim().slice(0, 120),
                publico: l.publico !== false
            });
        }

        const escopo = req.body.escopo === "bloco" ? "bloco" : "solo";
        const setAplicar = new Set([id]);
        if (escopo === "bloco") {
            const token = db[id].orderToken;
            const fila = [id];
            while (fila.length) {
                const atual = fila.shift();
                const indice = atual - 1;
                const linha = Math.floor(indice / 1000);
                const coluna = indice % 1000;
                const vizinhos = [];
                if (coluna > 0) vizinhos.push(atual - 1);
                if (coluna < 999) vizinhos.push(atual + 1);
                if (linha > 0) vizinhos.push(atual - 1000);
                if (linha < 999) vizinhos.push(atual + 1000);
                for (const v of vizinhos) {
                    const sv = db[v];
                    if (setAplicar.has(v) || !sv) continue;
                    if (sv.orderToken === token && (sv.status === "paid" || sv.status === "published")) {
                        setAplicar.add(v);
                        fila.push(v);
                    }
                }
            }
        }
        const idsAplicar = [...setAplicar].sort((a, b) => a - b);

        const dados = {};
        if (cat) dados.categoria = cat;
        dados.segmento = segmento;
        dados.descricao = descricao;
        dados.palavras_chave = palavras;
        dados.links = links;
        for (const sid of idsAplicar) {
            db[sid] = Object.assign({}, db[sid], dados);
        }
        writeDB(db);

        res.json({
            ok: true,
            spaces: idsAplicar,
            dados: { categoria: cat, segmento, descricao, palavras_chave: palavras, links }
        });
    } catch (error) {
        console.error("ERRO ao salvar dados do anúncio:", error.message);
        res.status(500).json({ error: "Não foi possível salvar os dados do anúncio." });
    }
});

/* =========================
   BISBILHOTAR - Perfis Públicos
========================= */

app.get("/api/perfis/publicos", async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const busca = String(req.query.busca || "").trim();
        const limite = Math.min(50, Math.max(1, parseInt(req.query.limite) || 20));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        let query = `
            SELECT u.id, u.nome, u.apelido, u.bio, u.foto_url, u.album_publico,
                   v.status AS verificacao_status,
                   (v.status = 'aprovado') AS verificado
              FROM usuarios u
              LEFT JOIN LATERAL (
                  SELECT status FROM verificacoes_perfil
                   WHERE usuario_id = u.id ORDER BY criado_em DESC LIMIT 1
              ) v ON TRUE
             WHERE u.album_publico = TRUE
        `;
        const params = [];

        if (busca) {
            query += ` AND (LOWER(nome) LIKE LOWER($1) OR LOWER(apelido) LIKE LOWER($1))`;
            params.push(`%${busca}%`);
        }

        query += ` ORDER BY criado_em DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limite, offset);

        const result = await pgPool.query(query, params);
        res.json({ perfis: result.rows });
    } catch (error) {
        console.error("ERRO ao listar perfis públicos:", error.message);
        res.status(500).json({ error: "Não foi possível listar perfis." });
    }
});

/* =========================
   EDITAR PERFIL
========================= */

app.put("/api/perfil", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const { apelido, bio, album_publico } = req.body;
        const usuarioId = req.usuario.id;

        // Validações
        if (apelido !== undefined) {
            const apelidoStr = String(apelido || "").trim();
            if (apelidoStr.length > 50) {
                return res.status(400).json({ error: "Apelido muito longo (máx. 50 caracteres)." });
            }
            if (apelidoStr && !/^[a-zA-Z0-9_]+$/.test(apelidoStr)) {
                return res.status(400).json({ error: "Apelido contém caracteres inválidos. Use apenas letras, números e underscore." });
            }
            // Verifica unicidade do apelido
            const check = await pgPool.query(
                `SELECT id FROM usuarios WHERE LOWER(apelido) = LOWER($1) AND id != $2`,
                [apelidoStr, usuarioId]
            );
            if (check.rowCount > 0) {
                return res.status(400).json({ error: "Este apelido já está em uso." });
            }
        }

        if (bio !== undefined) {
            const bioStr = String(bio || "").trim();
            if (bioStr.length > 500) {
                return res.status(400).json({ error: "Bio muito longa (máx. 500 caracteres)." });
            }
        }

        // Atualiza o perfil
        const updates = [];
        const params = [];
        let paramIndex = 1;

        if (apelido !== undefined) {
            updates.push(`apelido = $${paramIndex++}`);
            params.push(String(apelido || "").trim() || null);
        }
        if (bio !== undefined) {
            updates.push(`bio = $${paramIndex++}`);
            params.push(String(bio || "").trim() || null);
        }
        if (album_publico !== undefined) {
            updates.push(`album_publico = $${paramIndex++}`);
            params.push(Boolean(album_publico));
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "Nenhum campo para atualizar." });
        }

        params.push(usuarioId);
        const query = `UPDATE usuarios SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING id, nome, email, apelido, bio, foto_url, album_publico, criado_em`;

        const result = await pgPool.query(query, params);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        res.json({ ok: true, perfil: result.rows[0] });
    } catch (error) {
        console.error("ERRO ao atualizar perfil:", error.message);
        res.status(500).json({ error: "Não foi possível atualizar o perfil." });
    }
});

/* Upload de foto de perfil */
app.post("/api/perfil/foto", authUsuario, upload.single("foto"), async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        if (!req.file) {
            return res.status(400).json({ error: "Nenhuma foto enviada." });
        }

        // Valida tipo de arquivo
        const tiposPermitidos = ["image/jpeg", "image/png", "image/webp"];
        if (!tiposPermitidos.includes(req.file.mimetype)) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Formato de imagem inválido. Use JPEG, PNG ou WebP." });
        }

        // Valida tamanho (máx 5MB)
        if (req.file.size > 5 * 1024 * 1024) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Imagem muito grande. Máximo 5MB." });
        }

        const fotoUrl = `/uploads/${req.file.filename}`;
        const usuarioId = req.usuario.id;

        // Remove foto anterior se existir
        const oldResult = await pgPool.query(`SELECT foto_url FROM usuarios WHERE id = $1`, [usuarioId]);
        if (oldResult.rows[0] && oldResult.rows[0].foto_url) {
            const oldRel = String(oldResult.rows[0].foto_url).replace(/^\/uploads\//, "");
            if (oldRel && oldRel !== req.file.filename) {
                const oldPath = path.join(UPLOAD_DIR, oldRel);
                fs.unlink(oldPath, () => {});
            }
        }

        // Atualiza URL da foto
        await pgPool.query(`UPDATE usuarios SET foto_url = $1 WHERE id = $2`, [fotoUrl, usuarioId]);

        res.json({ ok: true, foto_url: fotoUrl });
    } catch (error) {
        console.error("ERRO ao enviar foto:", error.message);
        if (req.file) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: "Não foi possível enviar a foto." });
    }
});

/* Upload de foto do Destaque no Story.
   Arquivo fica em /uploads e o endereço é salvo na tabela destaques. */
app.post("/api/stories/destaques/foto", authUsuario, limiterUpload, upload.single("foto"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "Nenhuma foto enviada." });
        }

        const tiposPermitidos = ["image/jpeg", "image/png", "image/webp", "image/gif"];
        if (!tiposPermitidos.includes(req.file.mimetype)) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Formato de imagem inválido. Use JPEG, PNG, WebP ou GIF." });
        }

        if (req.file.size > 5 * 1024 * 1024) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "Imagem muito grande. Máximo 5MB." });
        }

        res.json({ ok: true, foto_url: `/uploads/${req.file.filename}` });
    } catch (error) {
        console.error("ERRO ao enviar foto do destaque:", error.message);
        if (req.file) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: "Não foi possível enviar a foto." });
    }
});

/* =========================
   SISTEMA DE INDICAÇÃO
========================= */

/* Gera código de indicação único para o usuário */
app.post("/api/indicacao/gerar-codigo", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const usuarioId = req.usuario.id;

        // Verifica se já tem código
        const check = await pgPool.query(`SELECT codigo_indicacao FROM usuarios WHERE id = $1`, [usuarioId]);
        if (check.rows[0] && check.rows[0].codigo_indicacao) {
            return res.json({ codigo: check.rows[0].codigo_indicacao });
        }

        // Gera código único
        let codigo;
        let tentativas = 0;
        do {
            codigo = "MD" + Math.random().toString(36).substring(2, 8).toUpperCase();
            const exists = await pgPool.query(`SELECT 1 FROM usuarios WHERE codigo_indicacao = $1`, [codigo]);
            if (exists.rowCount === 0) break;
            tentativas++;
        } while (tentativas < 10);

        if (tentativas >= 10) {
            return res.status(500).json({ error: "Não foi possível gerar código único." });
        }

        await pgPool.query(`UPDATE usuarios SET codigo_indicacao = $1 WHERE id = $2`, [codigo, usuarioId]);
        res.json({ codigo });
    } catch (error) {
        console.error("ERRO ao gerar código:", error.message);
        res.status(500).json({ error: "Não foi possível gerar código de indicação." });
    }
});

/* Registra indicação (quando novo usuário usa código) */
app.post("/api/indicacao/registrar", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const indicadoId = req.usuario.id;
        const { codigo } = req.body;

        if (!codigo || typeof codigo !== "string") {
            return res.status(400).json({ error: "Código de indicação inválido." });
        }

        const codigoStr = String(codigo).trim().toUpperCase();

        // Busca indicador
        const indicadorResult = await pgPool.query(`SELECT id FROM usuarios WHERE codigo_indicacao = $1`, [codigoStr]);
        if (indicadorResult.rowCount === 0) {
            return res.status(404).json({ error: "Código de indicação não encontrado." });
        }
        const indicadorId = indicadorResult.rows[0].id;

        // Não pode usar próprio código
        if (indicadorId === indicadoId) {
            return res.status(400).json({ error: "Você não pode usar seu próprio código de indicação." });
        }

        // Verifica se já foi indicado
        const checkIndicacao = await pgPool.query(`SELECT id FROM indicacoes WHERE indicado_id = $1`, [indicadoId]);
        if (checkIndicacao.rowCount > 0) {
            return res.status(400).json({ error: "Você já foi indicado por outro usuário." });
        }

        // Verifica se já tem benefício pendente
        const checkBeneficio = await pgPool.query(
            `SELECT id FROM beneficios_indicacao WHERE indicado_id = $1 AND status = 'PENDENTE'`,
            [indicadoId]
        );
        if (checkBeneficio.rowCount > 0) {
            return res.status(400).json({ error: "Você já possui um benefício de indicação pendente." });
        }

        // Registra indicação
        await pgPool.query(
            `INSERT INTO indicacoes (indicador_id, indicado_id, codigo_indicacao) VALUES ($1, $2, $3)`,
            [indicadorId, indicadoId, codigoStr]
        );

        // Cria benefício pendente
        await pgPool.query(
            `INSERT INTO beneficios_indicacao (indicado_id, indicador_id, percentual_desconto, status) VALUES ($1, $2, 10, 'PENDENTE')`,
            [indicadoId, indicadorId]
        );

        res.json({ ok: true, mensagem: "Indicação registrada com sucesso!" });
    } catch (error) {
        console.error("ERRO ao registrar indicação:", error.message);
        res.status(500).json({ error: "Não foi possível registrar indicação." });
    }
});

/* Verifica benefício de indicação do usuário */
app.get("/api/indicacao/beneficio", authUsuario, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const usuarioId = req.usuario.id;

        const result = await pgPool.query(
            `SELECT * FROM beneficios_indicacao WHERE indicado_id = $1 ORDER BY criado_em DESC LIMIT 1`,
            [usuarioId]
        );

        if (result.rowCount === 0) {
            return res.json({ beneficio: null });
        }

        res.json({ beneficio: result.rows[0] });
    } catch (error) {
        console.error("ERRO ao verificar benefício:", error.message);
        res.status(500).json({ error: "Não foi possível verificar benefício." });
    }
});

/* Verifica código de indicação (via query param ?ref=) */
app.get("/api/indicacao/verificar", async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const { ref } = req.query;
        if (!ref) {
            return res.json({ valido: false });
        }

        const codigo = String(ref).trim().toUpperCase();
        const result = await pgPool.query(`SELECT id FROM usuarios WHERE codigo_indicacao = $1`, [codigo]);

        res.json({ valido: result.rowCount > 0, codigo });
    } catch (error) {
        console.error("ERRO ao verificar código:", error.message);
        res.status(500).json({ error: "Não foi possível verificar código." });
    }
});

/* =========================
   UPLOAD FOTO
========================= */

/* Validação de propriedade NO BACKEND para publicar/editar um espaço.
   Aceita: (a) usuário logado que é o dono (usuarioId) do espaço; ou
   (b) usuário logado cuja conta possui o orderToken do espaço em
   usuario_chaves; ou (c) o orderToken exato do espaço enviado no body
   (fluxo por código de acesso). Espaço SEM dono nunca pode ser tomado. */
async function usuarioEhDonoEspaco(req, space) {
    const tokenFornecido = String(req.body.orderToken || req.body.token || "").trim();
    const donoTok = space ? String(space.orderToken || "") : "";
    if (req.usuario && req.usuario.id) {
        if (space && space.usuarioId && Number(space.usuarioId) === Number(req.usuario.id)) {
            return true;
        }
        if (donoTok) {
            if (donoTok === tokenFornecido) return true;
            if (pgDisponivel && pgPool) {
                try {
                    const q = await pgPool.query(
                        `SELECT 1 FROM usuario_chaves
                          WHERE usuario_id = $1 AND valor = $2 AND tipo = 'token'
                          LIMIT 1`,
                        [req.usuario.id, donoTok]
                    );
                    if (q.rows[0]) return true;
                } catch (e) { /* sem banco, segue pelo token */ }
            }
        }
        return false;
    }
    return !!donoTok && donoTok === tokenFornecido;
}

/* Verifica se um conjunto de ids forma um grupo contíguo no grid
   (cada espaço é vizinho de pelo menos um outro do grupo). */
function espacosSaoContiguos(ids) {
    if (!Array.isArray(ids) || ids.length <= 1) return true;
    const set = new Set(ids.map(Number));
    const visitados = new Set();
    const fila = [Number(ids[0])];
    visitados.add(Number(ids[0]));
    while (fila.length) {
        const atual = fila.shift();
        const indice = atual - 1;
        const linha = Math.floor(indice / 1000);
        const coluna = indice % 1000;
        const vizinhos = [];
        if (coluna > 0) vizinhos.push(atual - 1);
        if (coluna < 999) vizinhos.push(atual + 1);
        if (linha > 0) vizinhos.push(atual - 1000);
        if (linha < 999) vizinhos.push(atual + 1000);
        for (const v of vizinhos) {
            if (!set.has(v) || visitados.has(v)) continue;
            visitados.add(v);
            fila.push(v);
        }
    }
    return visitados.size === set.size;
}

app.post(
    "/api/upload/:id",
    authOpcional,
    upload.single("fotos"),
    async (req, res) => {

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

            if (!espacosSaoContiguos(ids)) {
                return res.status(400).json({
                    error:
                        "Os espaços do bloco precisam ser consecutivos " +
                        "(vizinhos entre si no mapa)."
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
           VALIDAÇÃO DE PROPRIEDADE NO BACKEND
           Só o dono pode editar a foto. Nunca confia só no frontend.
        ========================= */

        for (const spaceId of ids) {

            const espaco = db[spaceId];

            if (!(await usuarioEhDonoEspaco(req, espaco))) {
                return res.status(403).json({
                    error:
                        `Você não é o proprietário do espaço ` +
                        `#${spaceId.toLocaleString("pt-BR")}.`
                });
            }
        }

        const removeImage =
            req.body.removeImage === "true" ||
            req.body.removeImage === "1";

        const keepImage =
            req.body.keepImage === "true" ||
            req.body.keepImage === "1";

        let image = null;

        if (req.file) {

            image =
                `/uploads/${req.file.filename}`;

        } else if (removeImage) {

            image = null;

        } else if (keepImage) {

            image =
                db[ids[0]] && db[ids[0]].image
                ? db[ids[0]].image
                : null;

            if (!image) {
                return res.status(400).json({
                    error:
                        "Este espaço ainda não possui imagem " +
                        "para manter."
                });
            }

        } else {

            return res.status(400).json({
                error: "Envie uma imagem."
            });
        }

        const title =
            req.body.name ||
            req.body.nome ||
            db[ids[0]].title ||
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

            const atual = db[spaceId];

            if (removeImage) {

                db[spaceId] = {
                    ...atual,
                    status: "paid",
                    image: undefined,
                    publishedAt: undefined,
                    displayMode: "individual",
                    imageGroupSpaces: [spaceId]
                };

                continue;
            }

            db[spaceId] = {
                ...atual,
                status: "published",
                image,
                title,
                link:
                    link
                    ? link
                    : undefined,
                publishedAt,
                orderToken:
                    atual.orderToken || String(req.body.orderToken || req.body.token || "").trim(),
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

app.post("/api/link", authOpcional, async (req, res) => {

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

            if (!(await usuarioEhDonoEspaco(req, db[sid]))) {
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
            error: "Erro interno do servidor."
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

    if (tipoEvento === "payment" && dataIdWebhook) {
        try {
            const resultadoMarketplace = await colecionaveis.processarMarketplacePayment(dataIdWebhook);
            return res.status(200).json({ received: true, marketplace: !!resultadoMarketplace, approved: !!resultadoMarketplace?.approved });
        } catch (error) {
            console.error("ERRO ao processar pagamento marketplace:", mascararSensivel(error.message));
            return res.status(200).json({ received: true, marketplace: true });
        }
    }

    /* Processamos notificações de Order dos produtos próprios. */
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

        /* Log diagnóstico seguro (sem token/secret): apenas dados da Order. */
        const pagamentosDaOrder = (order?.transactions?.payments || []).map(p => ({
            paymentId: p.id,
            status: p.status,
            status_detail: p.status_detail,
            paid_amount: p.paid_amount
        }));
        console.log(
            "Order consultada:", order.id,
            "status=" + order.status,
            "status_detail=" + (order.status_detail || ""),
            "total_amount=" + order.total_amount,
            "total_paid_amount=" + (order.total_paid_amount || ""),
            "payments=" + JSON.stringify(pagamentosDaOrder)
        );

        /* Só liberamos espaços se a Order estiver efetivamente paga. */
        if (!orderPagaMercadoPago(order)) {

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

        /* Consome benefício de indicação se existir */
        if (alterado && pgDisponivel && pgPool) {
            try {
                // Busca o usuário que fez a compra
                const firstSpace = Object.values(db).find(s => s.mpOrderId === orderId);
                if (firstSpace && firstSpace.usuarioId) {
                    const usuarioId = firstSpace.usuarioId;
                    
                    // Verifica se tem benefício pendente
                    const benefCheck = await pgPool.query(
                        `SELECT id, percentual_desconto FROM beneficios_indicacao 
                         WHERE indicado_id = $1 AND status = 'PENDENTE' 
                         LIMIT 1`,
                        [usuarioId]
                    );
                    
                    if (benefCheck.rowCount > 0) {
                        const beneficio = benefCheck.rows[0];
                        const valorOriginalCents = firstSpace.chargedAmountCents || 0;
                        const descontoCents = Math.round(valorOriginalCents * beneficio.percentual_desconto / 100);
                        const valorFinalCents = valorOriginalCents - descontoCents;
                        
                        // Marca benefício como utilizado
                        await pgPool.query(
                            `UPDATE beneficios_indicacao 
                             SET status = 'UTILIZADO', 
                                 utilizado_em = NOW(),
                                 order_id = $2,
                                 valor_original_cents = $3,
                                 valor_desconto_cents = $4,
                                 valor_final_cents = $5
                             WHERE id = $1`,
                            [beneficio.id, orderId, valorOriginalCents, descontoCents, valorFinalCents]
                        );
                        
                        registrarLog("beneficio_indicacao_consumido", {
                            beneficioId: beneficio.id,
                            usuarioId,
                            orderId,
                            descontoCents
                        });
                    }
                    
                    // Registra no feed de últimas compras
                    const espacosIds = Object.keys(db)
                        .filter(id => db[id].mpOrderId === orderId && db[id].status === "paid")
                        .map(id => Number(id));
                    
                    await registrarUltimaCompra(
                        usuarioId,
                        "espacos",
                        `${espacosIds.length} espaço(s)`,
                        espacosIds.length,
                        totalPagoCents,
                        espacosIds
                    );
                }
            } catch (eBenef) {
                console.error("ERRO ao consumir benefício de indicação:", eBenef.message);
            }
        }

        confirmarPagamentoOferta(orderId);
        pgPagamentoPago({ mpOrderId: orderId });
        await processarRenovacaoPagamento(orderId, totalPagoCents);

        /* Pagamentos do módulo de colecionáveis (pacotes, compras
           no mercado e diferenças de troca). Independente e
           idempotente — só processa pedidos pendentes. */
        try {
            await processarPagamentoVerificacaoPerfil(orderId, totalPagoCents, dados.paymentId);
        } catch (eVerificacao) {
            console.error("ERRO ao processar pagamento de verificação:", eVerificacao.message);
        }
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

        /* Pagamentos de Destaques no Story. Idempotente —
           só ativa pedidos pendentes e com valor correto. */
        await processarPagamentoDestaque({ mpOrderId: orderId, totalCents: totalPagoCents });

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

app.get("/api/admin/resumo", authAdmin, async (req, res) => {

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

    /* Métricas expandidas do PostgreSQL */
    let totalUsuarios = 0;
    let usuariosBloqueados = 0;
    let totalTransacoes = 0;
    let storiesAtivos = 0;
    let storiesExpirados = 0;
    let comprasVisiveis = 0;

    if (pgDisponivel && pgPool) {
        try {
            const uRes = await pgPool.query(
                "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE bloqueado = TRUE) as bloqueados FROM usuarios"
            );
            totalUsuarios = Number(uRes.rows[0].total);
            usuariosBloqueados = Number(uRes.rows[0].bloqueados);

            const tRes = await pgPool.query("SELECT COUNT(*) as total FROM transacoes");
            totalTransacoes = Number(tRes.rows[0].total);

            const sRes = await pgPool.query(
                "SELECT COUNT(*) as total FROM destaques WHERE status = 'ativo' AND (expira_em IS NULL OR expira_em > NOW())"
            );
            storiesAtivos = Number(sRes.rows[0].total);

            const seRes = await pgPool.query(
                "SELECT COUNT(*) as total FROM destaques WHERE status = 'ativo' AND expira_em IS NOT NULL AND expira_em <= NOW()"
            );
            storiesExpirados = Number(seRes.rows[0].total);

            const cRes = await pgPool.query(
                "SELECT COUNT(*) as total FROM ultimas_compras WHERE visivel = TRUE"
            );
            comprasVisiveis = Number(cRes.rows[0].total);
        } catch (e) {
            console.error("ERRO ao buscar métricas do resumo:", e.message);
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
            mercadoPagoModo: MERCADOPAGO_SANDBOX ? "sandbox" : "producao",
            totalUsuarios,
            usuariosBloqueados,
            totalTransacoes,
            storiesAtivos,
            storiesExpirados,
            comprasVisiveis
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

        const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
        const limite = Math.min(500, Number(req.query.limite || 200));
        const offset = (pagina - 1) * limite;

        const countResult = await pgPool.query(
            `SELECT COUNT(*) as total FROM transacoes ${where}`,
            params
        );
        const total = Number(countResult.rows[0].total);
        const totalPaginas = Math.ceil(total / limite);

        const result = await pgPool.query(
            `SELECT id, tipo, access_code, token, order_id,
                    customer_id, payment_id, usuario_id,
                    nome, email, espacos, quantidade,
                    valor_total, comissao, status, test,
                    criado_em, pago_em
               FROM transacoes
              ${where}
              ORDER BY criado_em DESC
              LIMIT ${limite} OFFSET ${offset}`,
            params
        );

        res.json({
            ok: true,
            total,
            pagina,
            totalPaginas,
            limite,
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
        const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
        const limite = Math.min(200, Math.max(1, parseInt(req.query.limite) || 50));
        const offset = (pagina - 1) * limite;
        const busca = String(req.query.busca || "").trim().toLowerCase();
        const bloqueado = req.query.bloqueado;

        let where = ["u.email NOT LIKE '%@deleted.local'"];
        let params = [];
        let paramIdx = 1;

        if (busca) {
            where.push(`(LOWER(u.nome) LIKE $${paramIdx} OR LOWER(u.email) LIKE $${paramIdx})`);
            params.push(`%${busca}%`);
            paramIdx++;
        }
        if (bloqueado === "true") {
            where.push(`u.bloqueado = TRUE`);
        } else if (bloqueado === "false") {
            where.push(`u.bloqueado = FALSE`);
        }

        const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

        const countResult = await pgPool.query(
            `SELECT COUNT(*) as total FROM usuarios u ${whereClause}`,
            params
        );
        const total = Number(countResult.rows[0].total);
        const totalPaginas = Math.ceil(total / limite);

        const result = await pgPool.query(
            `SELECT u.id, u.nome, u.email, u.criado_em,
                    u.ultimo_login, u.bloqueado,
                    COALESCE(k.chaves, 0) AS chaves,
                    COALESCE(t.transacoes, 0) AS transacoes
               FROM usuarios u
              LEFT JOIN (
                  SELECT usuario_id, COUNT(*) AS chaves
                    FROM usuario_chaves GROUP BY usuario_id
              ) k ON k.usuario_id = u.id
              LEFT JOIN (
                  SELECT usuario_id, COUNT(*) AS transacoes
                    FROM transacoes GROUP BY usuario_id
              ) t ON t.usuario_id = u.id
              ${whereClause}
              ORDER BY u.id DESC
              LIMIT ${limite} OFFSET ${offset}`,
            params
        );

        res.json({
            ok: true,
            total,
            pagina,
            totalPaginas,
            limite,
            usuarios: result.rows.map(u => ({
                id: u.id,
                nome: u.nome,
                email: u.email,
                criadoEm: u.criado_em,
                ultimoLogin: u.ultimo_login,
                chaves: Number(u.chaves),
                transacoes: Number(u.transacoes),
                bloqueado: u.bloqueado === true
            }))
        });

    } catch (error) {
        console.error("ERRO admin/usuarios:", error.message);
        res.status(500).json({ error: error.message });
    }
});

/* =========================
   CONCESSÕES ADMINISTRATIVAS
   Operações sem compra, pagamento ou receita.
========================= */
app.get("/api/admin/concessoes/usuarios", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Banco de dados não configurado." });
    try {
        const busca = String(req.query.busca || "").trim().toLowerCase();
        if (!busca) return res.json({ ok: true, usuarios: [] });
        const q = await pgPool.query(
            `SELECT id, nome, apelido, email, foto_url, criado_em
               FROM usuarios
              WHERE CAST(id AS TEXT) = $1
                 OR LOWER(nome) LIKE $2
                 OR LOWER(COALESCE(apelido,'')) LIKE $2
                 OR LOWER(email) LIKE $2
              ORDER BY id DESC LIMIT 30`,
            [busca, `%${busca}%`]
        );
        res.json({ ok: true, usuarios: q.rows });
    } catch (error) { res.status(500).json({ error: "Não foi possível buscar usuários." }); }
});

app.get("/api/admin/concessoes/cards", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Banco de dados não configurado." });
    try {
        const busca = String(req.query.busca || "").trim().toLowerCase();
        const q = await pgPool.query(
            `SELECT c.id, c.number, c.name, c.rarity, c.image_url, c.collection_id, sc.name AS collection_name
               FROM sticker_cards c JOIN sticker_collections sc ON sc.id = c.collection_id
              WHERE c.is_active = TRUE
                AND ($1 = '' OR LOWER(c.name) LIKE $2 OR CAST(c.number AS TEXT) = $1 OR CAST(c.id AS TEXT) = $1)
              ORDER BY c.number LIMIT 100`,
            [busca, `%${busca}%`]
        );
        res.json({ ok: true, cards: q.rows });
    } catch (error) { res.status(500).json({ error: "Não foi possível buscar figurinhas." }); }
});

app.get("/api/admin/concessoes/espacos", authAdmin, (req, res) => {
    const busca = String(req.query.busca || "").trim();
    const db = readDB();
    const espacos = Object.values(db).filter(s => !busca || String(s.id) === busca).slice(0, 50);
    res.json({ ok: true, espacos });
});

app.get("/api/admin/concessoes/historico", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Banco de dados não configurado." });
    try {
        const q = await pgPool.query(
            `SELECT ca.*, u.nome AS usuario_nome, u.apelido AS usuario_apelido
               FROM concessoes_administrativas ca
               LEFT JOIN usuarios u ON u.id = ca.usuario_id
              ORDER BY ca.criado_em DESC LIMIT 100`
        );
        res.json({ ok: true, concessoes: q.rows });
    } catch (error) { res.status(500).json({ error: "Não foi possível carregar o histórico." }); }
});

app.post("/api/admin/concessoes/espacos", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Banco de dados não configurado." });
    const usuarioId = Number(req.body && req.body.usuarioId);
    const motivo = String(req.body && req.body.motivo || "").trim();
    const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
        .map(Number).filter(id => Number.isInteger(id) && id >= 1 && id <= 1000000))];
    if (!Number.isInteger(usuarioId) || !ids.length || !motivo) return res.status(400).json({ error: "Usuário, espaços e motivo são obrigatórios." });
    if (motivo.length > 1000) return res.status(400).json({ error: "Motivo muito longo." });
    const usuarioQ = await pgPool.query("SELECT id, nome, email FROM usuarios WHERE id = $1", [usuarioId]);
    if (!usuarioQ.rows[0]) return res.status(404).json({ error: "Usuário não encontrado." });
    const db = readDB();
    const ocupados = ids.filter(id => db[String(id)]);
    if (ocupados.length) return res.status(409).json({ error: "Um ou mais espaços já pertencem a outro usuário.", ocupados: ocupados.map(id => ({ id, proprietario: db[String(id)].name || db[String(id)].email || "desconhecido" })) });
    const token = gerarToken();
    const accessCode = gerarAccessCode();
    const original = JSON.stringify(db);
    const client = await pgPool.connect();
    try {
        await client.query("BEGIN");
        const audit = await client.query(
            `INSERT INTO concessoes_administrativas (admin_usuario, usuario_id, tipo, itens, quantidade, motivo)
             VALUES ($1,$2,'ESPACOS',$3,$4,$5) RETURNING id`,
            [req.admin.usuario, usuarioId, JSON.stringify(ids), ids.length, motivo]
        );
        await client.query("INSERT INTO usuario_chaves (usuario_id, tipo, valor) VALUES ($1,'token',$2),($1,'access',$3)", [usuarioId, token, accessCode]);
        const agora = new Date().toISOString();
        for (const id of ids) db[String(id)] = {
            id, status: "published", title: "", link: "", image: "",
            name: usuarioQ.rows[0].nome, email: usuarioQ.rows[0].email,
            orderToken: token, accessCode, usuarioId,
            operationType: "CONCESSAO_ADMINISTRATIVA", test: false,
            publishedAt: agora, grantedAt: agora
        };
        writeDB(db);
        await client.query("COMMIT");
        registrarLog("concessao_administrativa_espacos", { concessaoId: audit.rows[0].id, usuarioId, ids, admin: req.admin.usuario, motivo });
        res.json({ ok: true, concessaoId: audit.rows[0].id, ids });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        try { writeDB(JSON.parse(original)); } catch {}
        res.status(500).json({ error: "Não foi possível conceder os espaços." });
    } finally { client.release(); }
});

app.post("/api/admin/concessoes/figurinhas", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Banco de dados não configurado." });
    const usuarioId = Number(req.body && req.body.usuarioId);
    const motivo = String(req.body && req.body.motivo || "").trim();
    const ids = [...new Set((Array.isArray(req.body && req.body.cardIds) ? req.body.cardIds : [])
        .map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (!Number.isInteger(usuarioId) || !ids.length || !motivo) return res.status(400).json({ error: "Usuário, figurinhas e motivo são obrigatórios." });
    if (ids.length > 100 || motivo.length > 1000) return res.status(400).json({ error: "Limite de itens ou tamanho de motivo excedido." });
    const client = await pgPool.connect();
    try {
        await client.query("BEGIN");
        const userQ = await client.query("SELECT id FROM usuarios WHERE id = $1", [usuarioId]);
        const cardsQ = await client.query(
            `SELECT id, number, name, rarity, image_url FROM sticker_cards WHERE id IN (${ids.join(",")}) AND is_active = TRUE`
        );
        if (!userQ.rows[0]) throw new Error("Usuário não encontrado.");
        if (cardsQ.rows.length !== ids.length) throw new Error("Uma ou mais figurinhas não existem no catálogo oficial.");
        const itens = cardsQ.rows.map(c => ({ id: c.id, number: c.number, name: c.name, rarity: c.rarity }));
        const audit = await client.query(
            `INSERT INTO concessoes_administrativas (admin_usuario, usuario_id, tipo, itens, quantidade, motivo)
             VALUES ($1,$2,'FIGURINHAS',$3,$4,$5) RETURNING id`,
            [req.admin.usuario, usuarioId, JSON.stringify(itens), ids.length, motivo]
        );
        for (const card of cardsQ.rows) {
            await client.query(
                `INSERT INTO user_stickers (usuario_id, card_id, quantity) VALUES ($1,$2,1)
                 ON CONFLICT (usuario_id, card_id) DO UPDATE SET quantity = user_stickers.quantity + 1`,
                [usuarioId, card.id]
            );
            await client.query(
                `INSERT INTO sticker_transactions (usuario_id, tipo, detalhe, valor, ref_id) VALUES ($1,'CONCESSAO_ADMINISTRATIVA',$2,0,$3)`,
                [usuarioId, `Concessão administrativa: #${card.number} ${card.name}`, `ADM-CONCESSAO-${audit.rows[0].id}`]
            );
        }
        await client.query("COMMIT");
        registrarLog("concessao_administrativa_figurinhas", { concessaoId: audit.rows[0].id, usuarioId, ids, admin: req.admin.usuario, motivo });
        res.json({ ok: true, concessaoId: audit.rows[0].id, itens });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        const status = /não encontrado|não existem|catálogo/i.test(error.message) ? 400 : 500;
        res.status(status).json({ error: error.message || "Não foi possível conceder as figurinhas." });
    } finally { client.release(); }
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

/* ─── Exportação CSV (admin) ─── */

function csvEscape(val) {
    if (val == null) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function csvFromRows(headers, rows) {
    const lines = [headers.map(csvEscape).join(",")];
    for (const row of rows) {
        lines.push(headers.map(h => csvEscape(row[h])).join(","));
    }
    return lines.join("\n");
}

function sendCsv(res, filename, csvContent) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csvContent);
}

app.get("/api/admin/export/usuarios", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const result = await pgPool.query(
            `SELECT u.id, u.nome, u.email, u.criado_em, u.ultimo_login, u.bloqueado,
                    COALESCE(k.chaves, 0) AS chaves,
                    COALESCE(t.transacoes, 0) AS transacoes
               FROM usuarios u
              LEFT JOIN (
                  SELECT usuario_id, COUNT(*) AS chaves
                    FROM usuario_chaves GROUP BY usuario_id
              ) k ON k.usuario_id = u.id
              LEFT JOIN (
                  SELECT usuario_id, COUNT(*) AS transacoes
                    FROM transacoes GROUP BY usuario_id
              ) t ON t.usuario_id = u.id
              ORDER BY u.id DESC`
        );
        const rows = result.rows.map(u => ({
            id: u.id, nome: u.nome, email: u.email,
            criado_em: u.criado_em, ultimo_login: u.ultimo_login,
            bloqueado: u.bloqueado ? "SIM" : "NAO",
            chaves: Number(u.chaves), transacoes: Number(u.transacoes)
        }));
        const csv = csvFromRows(["id", "nome", "email", "criado_em", "ultimo_login", "bloqueado", "chaves", "transacoes"], rows);
        sendCsv(res, "usuarios.csv", csv);
    } catch (error) {
        res.status(500).json({ error: "Erro ao exportar usuários." });
    }
});

app.get("/api/admin/export/transacoes", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const result = await pgPool.query(
            `SELECT t.id, t.usuario_id, CAST(t.espacos AS TEXT) as espacos, t.valor_total, t.comissao, t.status, t.metodo_pagamento, t.criado_em
               FROM transacoes t ORDER BY t.criado_em DESC`
        );
        const rows = result.rows.map(t => ({
            id: t.id, usuario_id: t.usuario_id, espaco: t.espacos,
            valor_total: t.valor_total, comissao: t.comissao,
            status: t.status, metodo_pagamento: t.metodo_pagamento, criado_em: t.criado_em
        }));
        const csv = csvFromRows(["id", "usuario_id", "espaco", "valor_total", "comissao", "status", "metodo_pagamento", "criado_em"], rows);
        sendCsv(res, "transacoes.csv", csv);
    } catch (error) {
        res.status(500).json({ error: "Erro ao exportar transações." });
    }
});

app.get("/api/admin/export/stories", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const result = await pgPool.query(
            `SELECT d.id, d.usuario_id, d.tipo, d.duracao, d.titulo, d.status,
                    d.preco_cents, d.visualizacoes, d.criado_em, d.pago_em, d.expira_em
               FROM destaques d ORDER BY d.criado_em DESC`
        );
        const rows = result.rows.map(s => ({
            id: s.id, usuario_id: s.usuario_id, tipo: s.tipo,
            duracao: s.duracao, titulo: s.titulo, status: s.status,
            preco_cents: s.preco_cents, visualizacoes: s.visualizacoes || 0,
            criado_em: s.criado_em, pago_em: s.pago_em, expira_em: s.expira_em
        }));
        const csv = csvFromRows(["id", "usuario_id", "tipo", "duracao", "titulo", "status", "preco_cents", "visualizacoes", "criado_em", "pago_em", "expira_em"], rows);
        sendCsv(res, "stories.csv", csv);
    } catch (error) {
        res.status(500).json({ error: "Erro ao exportar stories." });
    }
});

app.get("/api/admin/export/ultimas-compras", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const result = await pgPool.query(
            `SELECT uc.id, uc.usuario_id, uc.tipo, uc.descricao, uc.quantidade,
                    uc.valor_cents, uc.visivel, uc.criado_em
               FROM ultimas_compras uc ORDER BY uc.criado_em DESC`
        );
        const rows = result.rows.map(c => ({
            id: c.id, usuario_id: c.usuario_id, tipo: c.tipo,
            descricao: c.descricao, quantidade: c.quantidade,
            valor_cents: c.valor_cents, visivel: c.visivel ? "SIM" : "NAO",
            criado_em: c.criado_em
        }));
        const csv = csvFromRows(["id", "usuario_id", "tipo", "descricao", "quantidade", "valor_cents", "visivel", "criado_em"], rows);
        sendCsv(res, "ultimas-compras.csv", csv);
    } catch (error) {
        res.status(500).json({ error: "Erro ao exportar últimas compras." });
    }
});

app.get("/api/admin/export/espacos", authAdmin, (req, res) => {
    try {
        const db = readDB();
        const espacos = Object.values(db);
        const rows = espacos.map(e => ({
            id: e.id, status: e.status, dono: e.owner || "",
            comprador: e.buyer || "",
            valor: e.price || 1,
            criado_em: e.createdAt || ""
        }));
        const csv = csvFromRows(["id", "status", "dono", "comprador", "valor", "criado_em"], rows);
        sendCsv(res, "espacos.csv", csv);
    } catch (error) {
        res.status(500).json({ error: "Erro ao exportar espaços." });
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
        "Sorteio " + escapeHtml(valor) + "</h2>" +
        "<p style='font-size:16px;line-height:1.6;'>" +
        escapeHtml(mensagem) +
        "</p>" +
        "<p style='font-size:15px;line-height:1.6;'>" +
        "Cada bloco comprado vale <b>1 bilhete</b> no " +
        "sorteio. Quanto mais blocos, mais chances! " +
        "Boa sorte!</p>" +
        "<hr style='border-color:#333;'>" +
        "<p style='font-size:13px;color:#888;'>" +
        "Você está recebendo este e-mail por ter blocos " +
        "ativos no Mega Outdoor (" + escapeHtml(email) + ").</p>" +
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
    criarOrderMercadoPagoSplit,
    consultarMercadoPagoPayment,
    consultarOrderMercadoPago,
    extrairDadosPagamento,
    statusOrderPago,
    orderPagaMercadoPago,
    paraCentavos,
    registrarLog,
    registrarStoryEvento,
    obterPool: () => pgPool,
    obterPgDisponivel: () => pgDisponivel,
    obterContaMarketplace,
    obterContaMarketplacePrivada,
    mercadopagoMarketplaceFeePercent: MERCADOPAGO_MARKETPLACE_FEE_PERCENT,
    mercadopagoMarketplaceSplitEnabled: MERCADOPAGO_MARKETPLACE_SPLIT_ENABLED,
    obterAuthUsuario: () => authUsuario,
    normalizarDadosComprador,
    validarDocumento,
    formatarErroPagamento,
    criarNotificacao
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
    criarOrderMercadoPagoSplit,
    consultarMercadoPagoPayment,
    consultarOrderMercadoPago,
    statusOrderPago,
    orderPagaMercadoPago,
    paraCentavos,
    descontoEmCentavos,
    registrarLog,
    registrarStoryEvento,
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
            res.status(500).json({ error: "Erro interno do servidor." });
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
   ADMINISTRAÇÃO DE USUÁRIOS
========================= */

/* Criação administrativa de usuário, sem conceder espaços ou créditos. */
app.post("/api/admin/usuarios", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const nome = String(req.body.nome || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const senha = String(req.body.senha || "");
        if (nome.length < 2) return res.status(400).json({ error: "Informe um nome válido." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Informe um e-mail válido." });
        if (senha.length < 6) return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
        const existente = await pgPool.query("SELECT id FROM usuarios WHERE LOWER(email) = $1", [email]);
        if (existente.rowCount) return res.status(409).json({ error: "Já existe um usuário com este e-mail." });
        const criado = await pgPool.query(
            `INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1,$2,$3)
             RETURNING id, nome, email, criado_em, bloqueado`,
            [nome, email, hashSenha(senha)]
        );
        const usuario = criado.rows[0];
        registrarLog("admin_usuario_criado", { admin: req.admin.usuario, usuarioId: usuario.id });
        res.status(201).json({ ok: true, usuario });
    } catch (error) {
        console.error("ERRO ao criar usuário pelo admin:", error.message);
        res.status(500).json({ error: "Não foi possível criar o usuário." });
    }
});

/* Editar usuário (admin) */
app.put("/api/admin/usuarios/:id", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ error: "ID de usuário inválido." });
        }

        const { nome, email, bloqueado } = req.body;

        // Validações
        if (nome !== undefined) {
            if (typeof nome !== "string" || nome.trim().length < 2 || nome.trim().length > 200) {
                return res.status(400).json({ error: "Nome deve ter entre 2 e 200 caracteres." });
            }
        }

        if (email !== undefined) {
            if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ error: "E-mail inválido." });
            }
        }

        // Verifica se usuário existe
        const checkUser = await pgPool.query("SELECT id FROM usuarios WHERE id = $1", [userId]);
        if (checkUser.rowCount === 0) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        // Constrói UPDATE dinâmico
        const updates = [];
        const params = [];
        let paramIndex = 1;

        if (nome !== undefined) {
            updates.push(`nome = $${paramIndex++}`);
            params.push(nome.trim());
        }
        if (email !== undefined) {
            updates.push(`email = $${paramIndex++}`);
            params.push(email.trim().toLowerCase());
        }
        if (bloqueado !== undefined) {
            updates.push(`bloqueado = $${paramIndex++}`);
            params.push(Boolean(bloqueado));
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: "Nenhum campo para atualizar." });
        }

        params.push(userId);
        const query = `UPDATE usuarios SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING id, nome, email, bloqueado`;
        const result = await pgPool.query(query, params);

        registrarLog("admin_user_edit", {
            admin: req.admin.usuario,
            userId,
            campos: Object.keys(req.body)
        });

        res.json({ ok: true, usuario: result.rows[0] });
    } catch (error) {
        console.error("ERRO ao editar usuário:", error.message);
        res.status(500).json({ error: "Não foi possível editar o usuário." });
    }
});

/* Resetar senha de usuário (admin) */
app.post("/api/admin/usuarios/:id/reset-senha", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ error: "ID de usuário inválido." });
        }

        const { novaSenha } = req.body;
        if (typeof novaSenha !== "string" || novaSenha.length < 6) {
            return res.status(400).json({ error: "Nova senha deve ter pelo menos 6 caracteres." });
        }

        // Verifica se usuário existe
        const checkUser = await pgPool.query("SELECT id FROM usuarios WHERE id = $1", [userId]);
        if (checkUser.rowCount === 0) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        // Gera novo hash de senha
        const senhaHash = await hashSenha(novaSenha);
        await pgPool.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [senhaHash, userId]);

        registrarLog("admin_password_reset", {
            admin: req.admin.usuario,
            userId
        });

        res.json({ ok: true, mensagem: "Senha redefinida com sucesso." });
    } catch (error) {
        console.error("ERRO ao resetar senha:", error.message);
        res.status(500).json({ error: "Não foi possível redefinir a senha." });
    }
});

/* Bloquear/desbloquear usuário (admin) */
app.post("/api/admin/usuarios/:id/bloquear", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ error: "ID de usuário inválido." });
        }

        const { bloqueado } = req.body;
        if (typeof bloqueado !== "boolean") {
            return res.status(400).json({ error: "Campo 'bloqueado' deve ser booleano." });
        }

        // Verifica se usuário existe
        const checkUser = await pgPool.query("SELECT id FROM usuarios WHERE id = $1", [userId]);
        if (checkUser.rowCount === 0) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        await pgPool.query("UPDATE usuarios SET bloqueado = $1 WHERE id = $2", [bloqueado, userId]);

        registrarLog(bloqueado ? "admin_user_block" : "admin_user_unblock", {
            admin: req.admin.usuario,
            userId
        });

        res.json({ ok: true, bloqueado });
    } catch (error) {
        console.error("ERRO ao bloquear usuário:", error.message);
        res.status(500).json({ error: "Não foi possível bloquear o usuário." });
    }
});

/* Excluir usuário (admin) */
app.delete("/api/admin/usuarios/:id", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ error: "ID de usuário inválido." });
        }

        // Verifica se usuário existe
        const checkUser = await pgPool.query("SELECT id, email FROM usuarios WHERE id = $1", [userId]);
        if (checkUser.rowCount === 0) {
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        // Verifica dependências antes de excluir
        const transacoes = await pgPool.query("SELECT COUNT(*) FROM transacoes WHERE usuario_id = $1", [userId]);
        const destaques = await pgPool.query("SELECT COUNT(*) FROM destaques WHERE usuario_id = $1", [userId]);

        // Marca usuário como excluído (soft delete) em vez de deletar fisicamente
        // para preservar integridade de dados financeiros
        const novoEmail = `excluido_${userId}@deleted.local`;
        await pgPool.query(
            "UPDATE usuarios SET bloqueado = TRUE, email = $2, nome = 'Usuário Excluído' WHERE id = $1",
            [userId, novoEmail]
        );

        registrarLog("admin_user_delete", {
            admin: req.admin.usuario,
            userId,
            transacoes: transacoes.rows[0].count,
            destaques: destaques.rows[0].count
        });

        res.json({
            ok: true,
            mensagem: "Usuário marcado como excluído. Dados financeiros preservados para auditoria.",
            transacoesPreservadas: transacoes.rows[0].count,
            destaquesPreservados: destaques.rows[0].count
        });
    } catch (error) {
        console.error("ERRO ao excluir usuário:", error.message);
        res.status(500).json({ error: "Não foi possível excluir o usuário." });
    }
});

/* =========================
   ADMINISTRAÇÃO DE ESPAÇOS
========================= */

/* Editar espaço (admin) */
app.put("/api/admin/spaces/:id", authAdmin, async (req, res) => {
    try {
        const spaceId = String(req.params.id);
        const db = readDB();

        if (!db[spaceId]) {
            return res.status(404).json({ error: "Espaço não encontrado." });
        }

        const { link, status, bloqueado } = req.body;

        if (link !== undefined) {
            const linkNormalizado = link ? normalizarLink(link) : null;
            if (link && !linkNormalizado) {
                return res.status(400).json({ error: "Link inválido." });
            }
            db[spaceId].link = linkNormalizado;
        }

        if (status !== undefined) {
            const statusValidos = ["reserved", "paid", "published", "expired", "blocked"];
            if (!statusValidos.includes(status)) {
                return res.status(400).json({ error: "Status inválido." });
            }
            db[spaceId].status = status;
        }

        if (bloqueado !== undefined) {
            db[spaceId].bloqueado = Boolean(bloqueado);
        }

        writeDB(db);

        registrarLog("admin_space_edit", {
            admin: req.admin.usuario,
            spaceId,
            campos: Object.keys(req.body)
        });

        res.json({ ok: true, space: db[spaceId] });
    } catch (error) {
        console.error("ERRO ao editar espaço:", error.message);
        res.status(500).json({ error: "Não foi possível editar o espaço." });
    }
});

/* Excluir espaço (admin) */
app.delete("/api/admin/spaces/:id", authAdmin, async (req, res) => {
    try {
        const spaceId = String(req.params.id);
        const db = readDB();

        if (!db[spaceId]) {
            return res.status(404).json({ error: "Espaço não encontrado." });
        }

        // Verifica se espaço tem transações associadas
        const transacoes = await pgPool.query(
            "SELECT COUNT(*) FROM transacoes WHERE espacos @> ARRAY[$1::integer]",
            [Number(spaceId)]
        );

        // Remove espaço do banco de dados em memória
        delete db[spaceId];
        writeDB(db);

        registrarLog("admin_space_delete", {
            admin: req.admin.usuario,
            spaceId,
            transacoesAssociadas: transacoes.rows[0].count
        });

        res.json({
            ok: true,
            mensagem: "Espaço excluído.",
            transacoesPreservadas: transacoes.rows[0].count
        });
    } catch (error) {
        console.error("ERRO ao excluir espaço:", error.message);
        res.status(500).json({ error: "Não foi possível excluir o espaço." });
    }
});

/* =========================
   ADMINISTRAÇÃO DE STORIES
========================= */

/* Listar stories (admin) */
app.get("/api/admin/stories", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const status = req.query.status;
        const busca = String(req.query.busca || "").trim().toLowerCase();
        const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
        const limite = Math.min(200, Math.max(1, parseInt(req.query.limite) || 50));
        const offset = (pagina - 1) * limite;

        let where = ["1=1"];
        let params = [];
        let paramIdx = 1;

        if (status) {
            where.push(`d.status = $${paramIdx}`);
            params.push(status);
            paramIdx++;
        }
        if (busca) {
            where.push(`(LOWER(d.titulo) LIKE $${paramIdx} OR LOWER(u.nome) LIKE $${paramIdx} OR LOWER(u.email) LIKE $${paramIdx})`);
            params.push(`%${busca}%`);
            paramIdx++;
        }

        const whereClause = where.join(" AND ");

        const countResult = await pgPool.query(
            `SELECT COUNT(*) as total FROM destaques d LEFT JOIN usuarios u ON u.id = d.usuario_id WHERE ${whereClause}`,
            params
        );
        const total = Number(countResult.rows[0].total);
        const totalPaginas = Math.ceil(total / limite);

        let query = `
            SELECT d.*, u.apelido, u.email as usuario_email
            FROM destaques d
            LEFT JOIN usuarios u ON u.id = d.usuario_id
            WHERE ${whereClause}
            ORDER BY d.criado_em DESC
            LIMIT ${limite} OFFSET ${offset}
        `;

        const result = await pgPool.query(query, params);

        const agora = Date.now();
        const stories = result.rows.map(s => ({
            id: s.id,
            usuarioId: s.usuario_id,
            usuarioApelido: s.apelido,
            usuarioEmail: s.usuario_email,
            tipo: s.tipo,
            duracao: s.duracao,
            titulo: s.titulo,
            subtitulo: s.subtitulo,
            status: s.status,
            precoCents: s.preco_cents,
            criadoEm: s.criado_em,
            pagoEm: s.pago_em,
            expiraEm: s.expira_em,
            tempoRestanteSegundos: s.expira_em ? Math.max(0, Math.floor((new Date(s.expira_em).getTime() - agora) / 1000)) : 0,
            visualizacoes: s.visualizacoes || 0
        }));

        res.json({ ok: true, total, pagina, totalPaginas, limite, stories });
    } catch (error) {
        console.error("ERRO ao listar stories:", error.message);
        res.status(500).json({ error: "Não foi possível listar stories." });
    }
});

/* Desativar story (admin) */
app.post("/api/admin/stories/:id/desativar", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const storyId = Number(req.params.id);
        if (!Number.isInteger(storyId) || storyId < 1) {
            return res.status(400).json({ error: "ID de story inválido." });
        }

        const result = await pgPool.query(
            "UPDATE destaques SET status = 'cancelado' WHERE id = $1 AND status = 'ativo' RETURNING id",
            [storyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Story não encontrado ou não está ativo." });
        }

        registrarLog("admin_story_disable", {
            admin: req.admin.usuario,
            storyId
        });

        res.json({ ok: true, mensagem: "Story desativado." });
    } catch (error) {
        console.error("ERRO ao desativar story:", error.message);
        res.status(500).json({ error: "Não foi possível desativar o story." });
    }
});

/* Remover story (admin) */
app.delete("/api/admin/stories/:id", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const storyId = Number(req.params.id);
        if (!Number.isInteger(storyId) || storyId < 1) {
            return res.status(400).json({ error: "ID de story inválido." });
        }

        const result = await pgPool.query(
            "DELETE FROM destaques WHERE id = $1 RETURNING id, usuario_id, titulo",
            [storyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Story não encontrado." });
        }

        // Remove também o story_event associado
        await pgPool.query(
            "DELETE FROM story_events WHERE event_key = $1",
            [`destaque:${storyId}`]
        );

        registrarLog("admin_story_delete", {
            admin: req.admin.usuario,
            storyId,
            usuarioId: result.rows[0].usuario_id,
            titulo: result.rows[0].titulo
        });

        res.json({ ok: true, mensagem: "Story removido." });
    } catch (error) {
        console.error("ERRO ao remover story:", error.message);
        res.status(500).json({ error: "Não foi possível remover o story." });
    }
});

/* ─── Configuração de preços dos stories (admin) ─── */

/* GET /api/admin/stories/pricing — listar config atual */
app.get("/api/admin/stories/pricing", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const config = await getStoryPricingConfig();
        res.json({ ok: true, config });
    } catch (error) {
        console.error("ERRO ao listar pricing:", error.message);
        res.status(500).json({ error: "Não foi possível listar a configuração de preços." });
    }
});

/* PUT /api/admin/stories/pricing — atualizar configuração */
app.put("/api/admin/stories/pricing", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const { itens } = req.body;
        if (!Array.isArray(itens) || itens.length === 0) {
            return res.status(400).json({ error: "Envie um array 'itens' com as configurações." });
        }

        const duracoesValidas = ["3h", "6h", "12h", "24h"];
        let popularCount = 0;

        for (const item of itens) {
            const duracao = String(item.duracao || "").trim();
            if (!duracoesValidas.includes(duracao)) {
                return res.status(400).json({ error: `Duração inválida: ${duracao}. Use 3h, 6h, 12h ou 24h.` });
            }

            const precoCents = Number(item.precoCents);
            if (!Number.isFinite(precoCents) || precoCents < 0) {
                return res.status(400).json({ error: `Preço inválido para ${duracao}. Use um valor numérico >= 0.` });
            }

            const ativo = item.ativo !== false;
            const popular = item.popular === true;
            if (popular) popularCount++;
        }

        if (popularCount > 1) {
            return res.status(400).json({ error: "Somente uma duração pode ser marcada como POPULAR." });
        }

        for (const item of itens) {
            const duracao = String(item.duracao || "").trim();
            const precoCents = Math.round(Number(item.precoCents));
            const ativo = item.ativo !== false;
            const popular = item.popular === true;

            await pgPool.query(
                `INSERT INTO story_pricing_config (duracao, preco_cents, ativo, popular, atualizado_em)
                 VALUES ($1,$2,$3,$4,NOW())
                 ON CONFLICT (duracao)
                 DO UPDATE SET preco_cents=$2, ativo=$3, popular=$4, atualizado_em=NOW()`,
                [duracao, precoCents, ativo, popular]
            );
        }

        registrarLog("admin_story_price_update", {
            admin: req.admin.usuario,
            alteracoes: itens.map(i => ({
                duracao: i.duracao,
                precoCents: i.precoCents,
                ativo: i.ativo !== false,
                popular: i.popular === true
            }))
        });

        const config = await getStoryPricingConfig();
        res.json({ ok: true, mensagem: "Preços atualizados com sucesso.", config });
    } catch (error) {
        console.error("ERRO ao atualizar pricing:", error.message);
        res.status(500).json({ error: "Não foi possível atualizar os preços." });
    }
});

/* POST /api/admin/stories/pricing/popular — marcar apenas uma duração como popular */
app.post("/api/admin/stories/pricing/popular", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const { duracao } = req.body;
        const duracoesValidas = ["3h", "6h", "12h", "24h"];

        /* Limpa todas as marcações de popular */
        await pgPool.query("UPDATE story_pricing_config SET popular = FALSE");

        /* Se enviou uma duração válida, marca como popular */
        if (duracao && duracoesValidas.includes(duracao)) {
            await pgPool.query(
                "UPDATE story_pricing_config SET popular = TRUE WHERE duracao = $1",
                [duracao]
            );
        }

        registrarLog("admin_story_popular_update", {
            admin: req.admin.usuario,
            duracao: duracao || "nenhuma"
        });

        const config = await getStoryPricingConfig();
        res.json({ ok: true, mensagem: "Destaque popular atualizado.", config });
    } catch (error) {
        console.error("ERRO ao atualizar popular:", error.message);
        res.status(500).json({ error: "Não foi possível atualizar o destaque popular." });
    }
});

/* =========================
   ADMINISTRAÇÃO DE ÚLTIMAS COMPRAS
========================= */

/* Listar últimas compras (admin) */
app.get("/api/admin/ultimas-compras", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
        const limite = Math.min(200, Math.max(1, parseInt(req.query.limite) || 50));
        const offset = (pagina - 1) * limite;
        const busca = String(req.query.busca || "").trim().toLowerCase();
        const visivel = req.query.visivel;

        let where = [];
        let params = [];
        let paramIdx = 1;

        if (busca) {
            where.push(`(LOWER(u.nome) LIKE $${paramIdx} OR LOWER(u.email) LIKE $${paramIdx} OR LOWER(uc.descricao) LIKE $${paramIdx})`);
            params.push(`%${busca}%`);
            paramIdx++;
        }
        if (visivel === "true") {
            where.push(`uc.visivel = TRUE`);
        } else if (visivel === "false") {
            where.push(`uc.visivel = FALSE`);
        }

        const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

        const countResult = await pgPool.query(
            `SELECT COUNT(*) as total FROM ultimas_compras uc LEFT JOIN usuarios u ON u.id = uc.usuario_id ${whereClause}`,
            params
        );
        const total = Number(countResult.rows[0].total);
        const totalPaginas = Math.ceil(total / limite);

        const result = await pgPool.query(
            `SELECT uc.*, u.apelido, u.email as usuario_email
             FROM ultimas_compras uc
             LEFT JOIN usuarios u ON u.id = uc.usuario_id
             ${whereClause}
             ORDER BY uc.criado_em DESC
             LIMIT ${limite} OFFSET ${offset}`,
            params
        );

        const compras = result.rows.map(c => ({
            id: c.id,
            usuarioId: c.usuario_id,
            usuarioApelido: c.apelido,
            usuarioEmail: c.usuario_email,
            tipo: c.tipo,
            descricao: c.descricao,
            quantidade: c.quantidade,
            valorCents: c.valor_cents,
            espacos: c.espacos,
            criadoEm: c.criado_em,
            expiraEm: c.expira_em,
            visivel: c.visivel !== false
        }));

        res.json({ ok: true, total, pagina, totalPaginas, limite, compras });
    } catch (error) {
        console.error("ERRO ao listar últimas compras:", error.message);
        res.status(500).json({ error: "Não foi possível listar últimas compras." });
    }
});

/* Ocultar última compra (admin) */
app.post("/api/admin/ultimas-compras/:id/ocultar", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const compraId = Number(req.params.id);
        if (!Number.isInteger(compraId) || compraId < 1) {
            return res.status(400).json({ error: "ID de compra inválido." });
        }

        const result = await pgPool.query(
            "UPDATE ultimas_compras SET visivel = FALSE WHERE id = $1 RETURNING id",
            [compraId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Compra não encontrada." });
        }

        registrarLog("admin_compra_hide", {
            admin: req.admin.usuario,
            compraId
        });

        res.json({ ok: true, mensagem: "Compra oculta do feed público." });
    } catch (error) {
        console.error("ERRO ao ocultar compra:", error.message);
        res.status(500).json({ error: "Não foi possível ocultar a compra." });
    }
});

/* Mostrar última compra novamente (admin) */
app.post("/api/admin/ultimas-compras/:id/mostrar", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const compraId = Number(req.params.id);
        if (!Number.isInteger(compraId) || compraId < 1) {
            return res.status(400).json({ error: "ID de compra inválido." });
        }

        const result = await pgPool.query(
            "UPDATE ultimas_compras SET visivel = TRUE WHERE id = $1 RETURNING id",
            [compraId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Compra não encontrada." });
        }

        registrarLog("admin_compra_show", {
            admin: req.admin.usuario,
            compraId
        });

        res.json({ ok: true, mensagem: "Compra tornada visível no feed público." });
    } catch (error) {
        console.error("ERRO ao mostrar compra:", error.message);
        res.status(500).json({ error: "Não foi possível mostrar a compra." });
    }
});

/* Remover última compra (admin) */
app.delete("/api/admin/ultimas-compras/:id", authAdmin, async (req, res) => {
    if (!pgDisponivel || !pgPool) return res.status(503).json({ error: "Serviço indisponível." });
    try {
        const compraId = Number(req.params.id);
        if (!Number.isInteger(compraId) || compraId < 1) {
            return res.status(400).json({ error: "ID de compra inválido." });
        }

        const result = await pgPool.query(
            "DELETE FROM ultimas_compras WHERE id = $1 RETURNING id, usuario_id, descricao",
            [compraId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Compra não encontrada." });
        }

        registrarLog("admin_compra_delete", {
            admin: req.admin.usuario,
            compraId,
            usuarioId: result.rows[0].usuario_id,
            descricao: result.rows[0].descricao
        });

        res.json({ ok: true, mensagem: "Compra removida." });
    } catch (error) {
        console.error("ERRO ao remover compra:", error.message);
        res.status(500).json({ error: "Não foi possível remover a compra." });
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
        const mensagens = {
            LIMIT_FILE_SIZE: "A imagem excede o tamanho máximo de 5 MB.",
            LIMIT_FILE_COUNT: "Envie apenas uma imagem por vez.",
            LIMIT_UNEXPECTED_FILE: "Campo de arquivo inesperado. Envie apenas uma imagem.",
            LIMIT_FIELD_COUNT: "Excesso de campos no formulário.",
            LIMIT_FIELD_KEY: "Campo de formulário inválido.",
            LIMIT_FIELD_VALUE: "Valor de campo muito grande.",
            LIMIT_PART_COUNT: "Excesso de partes no formulário."
        };
        return res.status(400).json({
            error: mensagens[err.code] || "Falha no envio do arquivo. Tente novamente."
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

        /* Expira destaques pagos e limpa Stories vencidos. */
        setInterval(expirarDestaquesVencidos, 30 * 1000);

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
