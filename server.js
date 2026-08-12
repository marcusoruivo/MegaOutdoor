require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const ASAAS_API = "https://api.asaas.com/v3";
const ASAAS_KEY = process.env.ASAAS_API_KEY;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "spaces.json");
const OFFERS_FILE = path.join(DATA_DIR, "offers.json");
const COUPONS_FILE = path.join(DATA_DIR, "coupons.json");
const PIXKEYS_FILE = path.join(DATA_DIR, "pixkeys.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `space-${req.params.id}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024
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

/* =========================
   TAXA DE SERVIÇO DO SITE
   20% sobre o valor negociado
========================= */

const TAXA_SITE = 0.2;

function taxaDoSite(valor) {
    return Math.max(
        0.01,
        Math.round(valor * TAXA_SITE * 100) / 100
    );
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
    res.json(readDB());
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

        /* =========================
           RESERVA
        ========================= */

        for (const id of ids) {

            db[id] = {
                id,
                status: "reserved",
                orderId,
                orderToken,
                customerId: customer.id,
                paymentId: payment.id,
                name: name.trim(),
                email: email.trim(),
                createdAt:
                    new Date().toISOString()
            };
        }

        writeDB(db);

        if (cupom) {
            cupom.used += 1;
            const cupons = readCoupons();
            cupons[cupom.codigo] = cupom;
            writeCoupons(cupons);
        }

        const meuCupom =
            gerarCupom(name, orderId);

        res.json({
            ok: true,
            orderId,
            orderToken,
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

        for (const id of spaces) {

            db[id] = {
                id,
                status: "paid",
                test: true,
                orderId,
                orderToken,
                name: name || "Anunciante",
                email: email || "",
                createdAt: now
            };
        }

        writeDB(db);

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

    let transferido = 0;

    for (const sid of alvos) {

        const space = db[sid];

        if (!space) continue;

        db[sid] = {
            ...space,
            name: oferta.name,
            email: oferta.email,
            orderToken: novoToken,
            transferPaymentId: paymentId,
            transferredAt: new Date().toISOString()
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

    writeOffers(ofertas);

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
                ownerPixKey: o.ownerPixKey,
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
           CRIA CLIENTE + PIX DA TAXA (20%)
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
                "Taxa de serviço Milhão Door (20%)"
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
                `E pague a taxa de 20% do site ` +
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
                "Taxa de serviço Milhão Door (20%)"
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
                    `20% ao site. A transferência é feita ao confirmar ` +
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

    res.json({
        ok: true,
        id: oferta.id,
        spaceId: oferta.spaceId,
        spaceIds:
            (Array.isArray(oferta.spaceIds) &&
             oferta.spaceIds.length)
            ? oferta.spaceIds
            : [oferta.spaceId],
        name: oferta.name,
        email: oferta.email,
        value: oferta.value,
        originalValue: oferta.originalValue,
        status: oferta.status,
        feeValue: oferta.feeValue,
        ownerPixKey: oferta.ownerPixKey,
        paymentId: oferta.paymentId,
        createdAt: oferta.createdAt,
        newOwnerToken:
            oferta.status === "paid"
                ? oferta.newOwnerToken || ""
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

        if (oferta.status === "paid") {

            return res.json({
                ok: true,
                status: "paid",
                offerId: oferta.id,
                value: oferta.value,
                feeValue: oferta.feeValue,
                ownerPixKey: oferta.ownerPixKey || "",
                spaceIds: alvos,
                newOwnerToken: oferta.newOwnerToken || ""
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
            ownerPixKey: oferta.ownerPixKey || "",
            spaceIds: alvos
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
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

        const id = Number(req.params.id);
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
           Espaços vizinhos que antes
           faziam parte do grupo do
           espaço editado (e não foram
           incluídos na edição) perdem
           a referência ao espaço
           desmembrado.
        ========================= */

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

        writeDB(db);

        res.json({
            ok: true,
            spaces: ids,
            image
        });
    }
);

/* =========================
   INICIAR SERVIDOR
========================= */

app.post("/webhooks/asaas", (req, res) => {
    const tokenRecebido = req.headers["asaas-access-token"];
    const tokenEsperado = process.env.WEBHOOK_TOKEN;

    if (!tokenEsperado || tokenRecebido !== tokenEsperado) {
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