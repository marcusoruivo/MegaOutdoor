require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const ASAAS_API = "https://api.asaas.com/v3";
const ASAAS_KEY = process.env.ASAAS_API_KEY;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "spaces.json");

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

        if (space.status === "published") {
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
            cpfCnpj
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

        if (document.length !== 11 && document.length !== 14) {
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
                        `MEGA-${Date.now()}`
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

        /* =========================
           RESERVA
        ========================= */

        for (const id of ids) {

            db[id] = {
                id,
                status: "reserved",
                orderId,
                customerId: customer.id,
                paymentId: payment.id,
                name: name.trim(),
                email: email.trim(),
                createdAt:
                    new Date().toISOString()
            };
        }

        writeDB(db);

        res.json({
            ok: true,
            orderId,
            paymentId: payment.id,
            spaces: ids,
            total,
            value: total,
            qrCode: pix.encodedImage,
            payload: pix.payload,
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

        for (const id of spaces) {

            db[id] = {
                id,
                status: "paid",
                test: true,
                name: name || "Anunciante",
                createdAt: now
            };
        }

        writeDB(db);

        res.json({
            ok: true,
            spaces,
            test: true
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
   UPLOAD FOTO
========================= */

app.post(
    "/api/upload/:id",
    upload.single("fotos"),
    (req, res) => {

        const id = Number(req.params.id);
        const db = readDB();

        if (!db[id]) {
            return res.status(404).json({
                error:
                    "Espaço não encontrado."
            });
        }

        if (
            db[id].status !== "paid" &&
            db[id].status !== "published"
        ) {
            return res.status(403).json({
                error:
                    "O pagamento deste espaço ainda não foi confirmado."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: "Envie uma imagem."
            });
        }

        db[id] = {
            ...db[id],
            status: "published",
            image:
                `/uploads/${req.file.filename}`,
            title:
                req.body.nome ||
                db[id].name ||
                "Anunciante",
            publishedAt:
                new Date().toISOString()
        };

        writeDB(db);

        res.json({
            ok: true,
            space: db[id]
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

            if (alterado) {
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