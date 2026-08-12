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

function gerarToken() {
    return crypto.randomBytes(16).toString("hex");
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
    const space = db[oferta.spaceId];

    if (!space) {
        return false;
    }

    const novoToken = gerarToken();

    db[oferta.spaceId] = {
        ...space,
        name: oferta.name,
        email: oferta.email,
        orderToken: novoToken,
        transferPaymentId: paymentId,
        transferredAt: new Date().toISOString()
    };

    writeDB(db);

    oferta.status = "paid";
    oferta.paidAt = new Date().toISOString();
    oferta.newOwnerToken = novoToken;

    writeOffers(ofertas);

    console.log(`Oferta ${oferta.id} paga. Espaço transferido.`);

    return true;
}

app.post("/api/offers", (req, res) => {

    try {

        const {
            spaceId,
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

        if (!db[id]) {
            return res.status(404).json({
                error: "Espaço não encontrado."
            });
        }

        if (db[id].status !== "published") {
            return res.status(400).json({
                error:
                    "Este espaço ainda não está publicado " +
                    "para receber ofertas."
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

        const ofertas = readOffers();

        const ofertaId =
            `OFR-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 7)}`;

        ofertas[ofertaId] = {
            id: ofertaId,
            spaceId: id,
            name: name.trim(),
            email: email.trim(),
            value: valor,
            message: (message || "").trim(),
            status: "pending",
            ownerToken: db[id].orderToken || "",
            createdAt: new Date().toISOString()
        };

        writeOffers(ofertas);

        res.json({
            ok: true,
            offerId: ofertaId
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
            .filter(o =>
                meusIds.includes(o.spaceId) &&
                (o.status === "pending" ||
                 o.status === "accepted" ||
                 o.status === "paid")
            )
            .map(o => ({
                id: o.id,
                spaceId: o.spaceId,
                name: o.name,
                email: o.email,
                value: o.value,
                message: o.message,
                status: o.status,
                createdAt: o.createdAt
            }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({
        ok: true,
        offers: lista
    });
});

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

        if (
            !db[oferta.spaceId] ||
            db[oferta.spaceId].orderToken !== token
        ) {
            return res.status(403).json({
                error:
                    "Você não é o proprietário deste espaço."
            });
        }

        /* =========================
           CRIA CLIENTE + PIX PARA O COMPRADOR
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
                    value: oferta.value,
                    dueDate,
                    description:
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

        oferta.status = "accepted";
        oferta.paymentId = payment.id;
        oferta.customerId = customer.id;
        oferta.acceptedAt = new Date().toISOString();

        writeOffers(ofertas);

        res.json({
            ok: true,
            offerId: oferta.id,
            qrCode: pix.encodedImage,
            payload: pix.payload,
            paymentId: payment.id,
            value: oferta.value
        });

    } catch (error) {

        console.error("ERRO OFERTA ACEITA:", error.message);

        res.status(500).json({
            error: error.message
        });
    }
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

    res.json({
        ok: true,
        offerId: oferta.id,
        status: "rejected"
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
        name: oferta.name,
        email: oferta.email,
        value: oferta.value,
        status: oferta.status,
        createdAt: oferta.createdAt,
        newOwnerToken:
            oferta.status === "paid"
                ? oferta.newOwnerToken || ""
                : undefined
    });
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