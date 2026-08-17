/* =========================================================
   COMBOS & KITS — MEGAOUTDOOR
   Módulo de Combos & Kits: pacotes de espaços + pacotes de
   figurinhas colecionáveis + licença, pagos via Mercado Pago.

   Pontos de integração:
   - Tabelas `kits` e `kit_compras` (criadas em migrar()).
   - Rotas públicas /api/combos/* e de admin /api/combos/admin/*.
   - processarPagamento({ mpOrderId }) chamado no webhook,
     no polling e no polling de colecionáveis (idempotente).

   O preço dos kits é calculado SEMPRE no backend. O frontend
   envia apenas o id do kit e o plano de licença. Nunca confie
   no preço enviado pelo cliente.
========================================================= */

const crypto = require("crypto");

/* Preço unitário de um espaço avulso. Deve ser igual ao
   BASE_PRICE_PER_BLOCK definido em server.js. */
const PRECO_ESPACO_KIT = 1.00;

/* Licença: taxa adicionada UMA ÚNICA VEZ por pedido
   (nunca multiplicada pela quantidade de espaços). */
const LICENCAS_KIT = {
    "1_year": { label: "1 ANO", months: 12, fee: 0 },
    "3_years": { label: "3 ANOS", months: 36, fee: 20 },
    "5_years": { label: "5 ANOS", months: 60, fee: 40 }
};

/* Desconto real aplicado sobre o preço dos itens comprados separadamente.
   Quanto maior o kit, maior a economia. */
const DESCONTO_KIT = {
    starter: 0.10,
    colecionador: 0.12,
    premium: 0.15,
    mega: 0.15,
    lendario: 0.18
};

function gerarOrderId(prefixo) {
    return `${prefixo}-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function adicionarMeses(data, meses) {
    const d = new Date(data);
    const diaOriginal = d.getDate();
    d.setMonth(d.getMonth() + meses);
    if (d.getDate() !== diaOriginal) {
        d.setDate(0);
    }
    return d;
}

function escolherLicenca(planoKey) {
    return (
        LICENCAS_KIT[planoKey] ||
        LICENCAS_KIT["1_year"]
    );
}

module.exports = function criarModuloCombos(deps) {

    const {
        express,
        authUsuario,
        authAdmin,
        criarOrderMercadoPago,
        consultarOrderMercadoPago,
        statusOrderPago,
        orderPagaMercadoPago,
        paraCentavos,
        descontoEmCentavos,
        registrarLog,
        obterPool,
        obterPgDisponivel,
        obterAuthUsuario,
        readDB,
        writeDB,
        registrarTransacao,
        salvarChaveUsuario,
        gerarToken,
        gerarAccessCode,
        obterColecionaveis,
        normalizarDadosComprador,
        validarDocumento,
        formatarErroPagamento,
        registrarStoryEvento
    } = deps;

    const router = express.Router();

    const pg = () => obterPool();
    const pgOk = () => !!obterPgDisponivel();

    /* =========================================================
       MIGRAÇÃO DO BANCO
       Chamada pelo server.js dentro de initBanco().
       IF NOT EXISTS apenas (nunca DROP).
    ========================================================= */

    async function migrar() {
        const pool = obterPool();
        if (!pool) return;

        await pool.query(`
            CREATE TABLE IF NOT EXISTS kits (
                id           SERIAL PRIMARY KEY,
                slug         VARCHAR(60) UNIQUE NOT NULL,
                nome         VARCHAR(100) NOT NULL,
                descricao    TEXT,
                destaque     VARCHAR(60),
                preco_normal NUMERIC(10,2) NOT NULL,
                preco        NUMERIC(10,2) NOT NULL,
                espacos      INTEGER NOT NULL DEFAULT 0,
                pacotes      JSONB NOT NULL DEFAULT '[]',
                discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
                spaces_price NUMERIC(10,2) NOT NULL DEFAULT 0,
                packs_price  NUMERIC(10,2) NOT NULL DEFAULT 0,
                package_summary JSONB NOT NULL DEFAULT '[]',
                total_cards  INTEGER NOT NULL DEFAULT 0,
                bonus        TEXT,
                is_active    BOOLEAN NOT NULL DEFAULT TRUE,
                sort_order   INTEGER NOT NULL DEFAULT 0,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS kit_compras (
                id             SERIAL PRIMARY KEY,
                usuario_id     INTEGER NOT NULL
                               REFERENCES usuarios(id) ON DELETE CASCADE,
                kit_id         INTEGER NOT NULL
                               REFERENCES kits(id),
                order_id       VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id    VARCHAR(60),
                payment_id     VARCHAR(60),
                license_plan   VARCHAR(20) NOT NULL DEFAULT '1_year',
                license_months INTEGER NOT NULL DEFAULT 12,
                license_fee    NUMERIC(10,2) NOT NULL DEFAULT 0,
                preco          NUMERIC(10,2) NOT NULL,
                total          NUMERIC(10,2) NOT NULL,
                espacos        INTEGER[] NOT NULL DEFAULT '{}',
                status         VARCHAR(20) NOT NULL DEFAULT 'pending',
                espacos_confirmados BOOLEAN NOT NULL DEFAULT FALSE,
                test           BOOLEAN NOT NULL DEFAULT FALSE,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                paid_at        TIMESTAMPTZ
            )
        `);

        /* Compatibilidade com bancos já existentes (estado de seleção
           manual de espaços dos kits, CORREÇÃO 7). */
        await pool.query(`
            ALTER TABLE kits
                ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS spaces_price NUMERIC(10,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS packs_price NUMERIC(10,2) NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS package_summary JSONB NOT NULL DEFAULT '[]',
                ADD COLUMN IF NOT EXISTS total_cards INTEGER NOT NULL DEFAULT 0
        `);

        await pool.query(`
            ALTER TABLE kit_compras
                ADD COLUMN IF NOT EXISTS espacos_confirmados BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS story_opt_in BOOLEAN NOT NULL DEFAULT FALSE
        `);

        await pool.query(
            "CREATE INDEX IF NOT EXISTS idx_kits_ativo ON kits(is_active)"
        );
        await pool.query(
            "CREATE INDEX IF NOT EXISTS idx_kitcompras_usuario ON kit_compras(usuario_id)"
        );
        await pool.query(
            "CREATE INDEX IF NOT EXISTS idx_kitcompras_status ON kit_compras(status)"
        );

        await semearKits(pool);
    }

    /* Seed idempotente dos kits padrão. Os pacotes são referenciados
       por slug (estável) e resolvidos para id/preço na hora do seed.
       O preço normal é o valor real de cada item comprado separadamente;
       o preço do combo aplica o desconto real correspondente. */
    async function semearKits(pool) {
        const packQ = await pool.query(
            `SELECT id, slug, name, price, sticker_quantity FROM sticker_packs`
        );
        const packId = {};
        const packPrice = {};
        const packName = {};
        const packCards = {};
        for (const p of packQ.rows) {
            packId[p.slug] = p.id;
            packPrice[p.slug] = Number(p.price);
            packName[p.slug] = p.name;
            packCards[p.slug] = Number(p.sticker_quantity);
        }

        const KITS_PADRAO = [
            {
                slug: "starter",
                nome: "KIT STARTER",
                descricao: "O jeito mais barato de começar: espaços + figurinhas + licença de 1 ano.",
                destaque: null,
                espacos: 3,
                pacotes: [
                    { pack_slug: "bronze", quantidade: 1 }
                ],
                bonus: "Licença de 1 ano incluída nos espaços."
            },
            {
                slug: "colecionador",
                nome: "KIT COLECIONADOR",
                descricao: "Para quem quer mais espaços e figurinhas com ótimo custo-benefício.",
                destaque: null,
                espacos: 10,
                pacotes: [
                    { pack_slug: "prata", quantidade: 1 },
                    { pack_slug: "bronze", quantidade: 2 }
                ],
                bonus: "Licença de 1 ano incluída nos espaços."
            },
            {
                slug: "premium",
                nome: "KIT PREMIUM",
                descricao: "O favorito da galera: muitos espaços, pacotes especiais e licença turbinada.",
                destaque: "MAIS VENDIDO",
                espacos: 25,
                pacotes: [
                    { pack_slug: "ouro", quantidade: 1 },
                    { pack_slug: "prata", quantidade: 2 }
                ],
                bonus: "Licença de 1 ano incluída nos espaços."
            },
            {
                slug: "mega",
                nome: "KIT MEGA",
                descricao: "Destaque em grande estilo: dezenas de espaços e pacotes em abundância.",
                destaque: null,
                espacos: 60,
                pacotes: [
                    { pack_slug: "especial", quantidade: 1 },
                    { pack_slug: "ouro", quantidade: 1 },
                    { pack_slug: "prata", quantidade: 2 }
                ],
                bonus: "Licença de 1 ano incluída nos espaços."
            },
            {
                slug: "lendario",
                nome: "KIT LENDÁRIO",
                descricao: "A maior economia: um verdadeiro outdoor inteiro para chamar de seu.",
                destaque: "MAIOR ECONOMIA",
                espacos: 100,
                pacotes: [
                    { pack_slug: "especial", quantidade: 2 },
                    { pack_slug: "ouro", quantidade: 2 }
                ],
                bonus: "Licença de 1 ano incluída nos espaços."
            }
        ];

        function calcularKit(kit) {
            const spacesPrice = Number(kit.espacos || 0) * PRECO_ESPACO_KIT;
            let packsPrice = 0;
            let totalCards = 0;
            const packageSummary = [];
            for (const p of (kit.pacotes || [])) {
                const qtd = Number(p.quantidade || 1);
                const unit = packPrice[p.pack_slug] || 0;
                const cards = packCards[p.pack_slug] || 0;
                const total = Math.round(unit * qtd * 100) / 100;
                packsPrice += total;
                totalCards += cards * qtd;
                packageSummary.push({
                    pack_slug: p.pack_slug,
                    pack_name: packName[p.pack_slug] || p.pack_slug,
                    pack_id: packId[p.pack_slug] || null,
                    quantidade: qtd,
                    unit_price: unit,
                    cards_count: cards,
                    total_price: total
                });
            }
            const subtotalCents = paraCentavos(spacesPrice) + paraCentavos(packsPrice);
            const discountPercent = Math.round((DESCONTO_KIT[kit.slug] || 0.10) * 100);
            const discountCents = descontoEmCentavos(subtotalCents, discountPercent);
            const finalPriceCents = subtotalCents - discountCents;
            const subtotal = subtotalCents / 100;
            const finalPrice = finalPriceCents / 100;
            return { spacesPrice, packsPrice, subtotal, discountPercent, finalPrice, totalCards, packageSummary };
        }

        let ordem = 10;
        for (const k of KITS_PADRAO) {
            const calc = calcularKit(k);
            const pacotes = (k.pacotes || [])
                .map(p => ({
                    pack_id: packId[p.pack_slug],
                    quantidade: p.quantidade
                }))
                .filter(p => p.pack_id);

            await pool.query(
                `INSERT INTO kits
                    (slug, nome, descricao, destaque,
                     preco_normal, preco, espacos, pacotes,
                     discount_percent, spaces_price, packs_price, package_summary, total_cards,
                     bonus, is_active, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,$15)
                 ON CONFLICT (slug) DO UPDATE SET
                     nome = EXCLUDED.nome,
                     descricao = EXCLUDED.descricao,
                     destaque = EXCLUDED.destaque,
                     preco_normal = EXCLUDED.preco_normal,
                     preco = EXCLUDED.preco,
                     espacos = EXCLUDED.espacos,
                     pacotes = EXCLUDED.pacotes,
                     discount_percent = EXCLUDED.discount_percent,
                     spaces_price = EXCLUDED.spaces_price,
                     packs_price = EXCLUDED.packs_price,
                     package_summary = EXCLUDED.package_summary,
                     total_cards = EXCLUDED.total_cards,
                     bonus = EXCLUDED.bonus,
                     updated_at = NOW()
                `,
                [k.slug, k.nome, k.descricao, k.destaque,
                 calc.subtotal, calc.finalPrice, k.espacos,
                 JSON.stringify(pacotes),
                 calc.discountPercent, calc.spacesPrice, calc.packsPrice,
                 JSON.stringify(calc.packageSummary), calc.totalCards,
                 k.bonus, ordem]
            );
            ordem += 10;
        }
    }

    /* =========================================================
       HELPERS
    ========================================================= */

    async function kitPorId(id) {
        const q = await pg().query(
            `SELECT * FROM kits WHERE id = $1`,
            [id]
        );
        return q.rows[0] || null;
    }

    async function kitAtivoPorId(id) {
        const q = await pg().query(
            `SELECT * FROM kits WHERE id = $1 AND is_active = TRUE`,
            [id]
        );
        return q.rows[0] || null;
    }

    async function usuarioPorId(usuarioId) {
        const q = await pg().query(
            `SELECT id, nome, email FROM usuarios WHERE id = $1`,
            [usuarioId]
        );
        return q.rows[0] || null;
    }

    function calcularTotal(kit, planoKey) {
        const licenca = escolherLicenca(planoKey);
        const precoCents = Math.round(Number(kit.preco) * 100);
        const feeCents = Math.round((Number(licenca.fee) || 0) * 100);
        const totalCents = precoCents + feeCents;
        return {
            licenca,
            preco: precoCents / 100,
            total: totalCents / 100,
            precoCents,
            feeCents,
            totalCents
        };
    }

    /* Fila de escrita única para o spaces.json (read-modify-write).
       Serializa confirmações de kits entre requisições concorrentes,
       evitando que dois usuários confirmem o MESMO espaço. */
    let filaEscritaMapa = Promise.resolve();

    function enfileirarEscritaMapa(fn) {
        const exec = filaEscritaMapa.then(() => fn());
        filaEscritaMapa = exec.catch(() => {});
        return exec;
    }

    /* Valida números de espaço recebidos do usuário (1..1.000.000,
       inteiros, sem duplicatas). Aceita também a representação textual
       de array ({1,2,3}) para bancos/adaptadores que a devolvam. */
    function normalizarIdsEspacos(entrada) {
        let lista = entrada;
        if (typeof entrada === "string") {
            try {
                lista = JSON.parse(
                    entrada.trim().replace(/^\{/, "[").replace(/\}$/, "]")
                );
            } catch (e) {
                lista = [];
            }
        }
        if (!Array.isArray(lista)) return [];
        return [...new Set(lista.map(Number))]
            .filter(n => Number.isInteger(n) && n >= 1 && n <= 1000000);
    }

    /* Confirma a seleção de espaços de um kit (CORREÇÃO 7).
       Executado sob a fila de escrita: revalida a disponibilidade
       ATÔMICA de todos os espaços e só então grava no mapa. Lança
       erro se a quantidade não bater com o kit ou se algum espaço
       não estiver mais livre (concorrência). */
    async function alocarEspacosConfirmados(compra) {
        const kit = await kitPorId(compra.kit_id);
        if (!kit) {
            throw new Error("Kit não encontrado para confirmação.");
        }

        const ids = normalizarIdsEspacos(compra.espacos);
        const esperados = Number(kit.espacos);
        if (ids.length !== esperados) {
            throw new Error(`Selecione exatamente ${esperados} espaço(s) para confirmar (${ids.length} selecionado(s)).`);
        }

        const usuario = await usuarioPorId(compra.usuario_id);
        if (!usuario) {
            throw new Error("Usuário do kit não encontrado.");
        }

        return await enfileirarEscritaMapa(async () => {
            const db = readDB();
            const ocupados = new Set(Object.keys(db).map(Number));

            for (const id of ids) {
                if (ocupados.has(id)) {
                    throw new Error(`O espaço ${id} não está mais disponível.`);
                }
            }

            const licenca = escolherLicenca(compra.license_plan);
            const paidAt = new Date();
            const orderToken = gerarToken();
            const accessCode = gerarAccessCode();

            for (const id of ids) {
                db[id] = {
                    id,
                    status: "paid",
                    paidAt: paidAt.toISOString(),
                    purchasedAt: paidAt.toISOString(),
                    expiresAt: adicionarMeses(paidAt, licenca.months).toISOString(),
                    orderId: compra.order_id,
                    mpOrderId: compra.mp_order_id || "",
                    orderToken,
                    accessCode,
                    customerId: "",
                    paymentId: compra.payment_id || "",
                    paymentMethod: "kit",
                    usuarioId: compra.usuario_id,
                    name: usuario.nome,
                    email: usuario.email,
                    createdAt: paidAt.toISOString(),
                    licensePlan: compra.license_plan,
                    licenseDurationMonths: licenca.months,
                    licenseFee: licenca.fee,
                    baseAmount: Number(kit.preco),
                    totalAmount: Number(compra.total),
                    basePricePerBlock: 0,
                    operationType: "kit",
                    originalLicensePlan: compra.license_plan,
                    originalLicenseDurationMonths: licenca.months,
                    originalBasePricePerBlock: 0,
                    originalLicenseFee: licenca.fee,
                    kitId: kit.id,
                    kitNome: kit.nome
                };
            }

            writeDB(db);
            return { ids, orderToken, accessCode };
        });
    }

    /* Entrega física de um kit: cria os espaços pagos com
       licença, entrega os pacotes de figurinhas e registra
       a compra. Idempotente — só roda para pedidos pendentes. */
    async function entregarKit(compra) {
        const kit = await kitPorId(compra.kit_id);
        if (!kit) {
            throw new Error("Kit não encontrado para entrega.");
        }

        const usuario = await usuarioPorId(compra.usuario_id);
        if (!usuario) {
            throw new Error("Usuário do kit não encontrado.");
        }

        const licenca = escolherLicenca(compra.license_plan);
        const pacotes = Array.isArray(kit.pacotes) ? kit.pacotes : [];

        /* 1) NÃO aloca espaços aqui (CORREÇÃO 7). O pagamento aprovado
           libera o BENEFÍCIO do kit; a seleção e a confirmação dos
           espaços acontecem depois, manualmente, via endpoints próprios.
           A alocação física ocorre apenas em alocarEspacosConfirmados. */
        const ids = [];

        const orderToken = gerarToken();
        const accessCode = gerarAccessCode();

        /* 2) Registra a compra */
        await registrarTransacao({
            tipo: "compra",
            accessCode,
            token: orderToken,
            orderId: compra.order_id,
            mpOrderId: compra.mp_order_id || null,
            customerId: "",
            paymentId: compra.payment_id || null,
            metodoPagamento: "kit",
            usuarioId: compra.usuario_id,
            nome: usuario.nome,
            email: usuario.email,
            espacos: ids,
            valorTotal: Number(compra.total),
            comissao: 0,
            status: "pago",
            test: compra.test,
            licensePlan: compra.license_plan,
            licenseDurationMonths: licenca.months,
            licenseFee: licenca.fee,
            baseAmount: Number(kit.preco),
            totalAmount: Number(compra.total),
            originalLicensePlan: compra.license_plan,
            originalLicenseDurationMonths: licenca.months,
            originalBasePricePerBlock: 0,
            originalLicenseFee: licenca.fee,
            operationType: "kit",
            aceiteRegras: true
        });

        await salvarChaveUsuario(compra.usuario_id, "token", orderToken);
        await salvarChaveUsuario(compra.usuario_id, "access", accessCode);

        /* 3) Entrega os pacotes de figurinhas via módulo colecionáveis */
        const colecionaveis = obterColecionaveis();
        let figurinhasEntregues = 0;

        if (colecionaveis && typeof colecionaveis.entregarPacoteParaUsuario === "function") {
            for (const item of pacotes) {
                const packId = Number(item.pack_id);
                const qtd = Math.max(1, Number(item.quantidade) || 1);
                if (!packId) continue;
                try {
                    const r = await colecionaveis.entregarPacoteParaUsuario({
                        usuarioId: compra.usuario_id,
                        packId,
                        quantidade: qtd,
                        refId: compra.order_id
                    });
                    figurinhasEntregues += (r && r.figurinhas) || 0;
                } catch (ePacote) {
                    registrarLog("combo_erro_pacote", {
                        kitId: kit.id,
                        packId,
                        erro: ePacote.message
                    });
                }
            }
        }

        registrarLog("combo_entregue", {
            compraId: compra.id,
            kitId: kit.id,
            kitNome: kit.nome,
            espacos: ids.length,
            figurinhasEntregues,
            total: Number(compra.total)
        });

        return {
            espacos: ids,
            figurinhasEntregues
        };
    }

    /* =========================================================
       PROCESSAMENTO DE PAGAMENTO (idempotente)
       Só processa pedidos pendentes. Chamado no webhook e no
       polling — duplicadas não geram entrega dupla.
    ========================================================= */

    async function processarPagamento({ mpOrderId, totalCents }) {
        if (!pgOk()) return null;

        const q = await pg().query(
            `SELECT * FROM kit_compras
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'pending'
              LIMIT 1`,
            [mpOrderId]
        );
        const compra = q.rows[0];
        if (!compra) return null;

        /* Validação de valor: o total pago no MP precisa bater com o
           total do kit gravado no pedido. Total divergente NÃO entrega. */
        if (
            totalCents != null &&
            paraCentavos(compra.total) !== totalCents
        ) {
            registrarLog("combo_pagamento_valor_divergente", {
                mpOrderId,
                compraId: compra.id,
                cobradoCents: paraCentavos(compra.total),
                pagoCents: totalCents
            });
            console.error(
                "[COMBO] VALOR DIVERGENTE entre o cobrado e o pago. Kit NÃO entregue.",
                {
                    mpOrderId,
                    compraId: compra.id,
                    cobradoCents: paraCentavos(compra.total),
                    pagoCents: totalCents
                }
            );
            return null;
        }

        /* Reserva atômica: evita entrega dupla se o webhook e o
           polling chegarem ao mesmo tempo para o mesmo pedido. */
        const reserva = await pg().query(
            `UPDATE kit_compras
                SET status = 'processing'
              WHERE id = $1 AND status = 'pending'
              RETURNING id`,
            [compra.id]
        );
        if (!reserva.rows.length) {
            return null;
        }

        let entregue;
        try {
            entregue = await entregarKit(compra);
        } catch (eEntrega) {
            /* Devolve para 'pending' para nova tentativa futura. */
            await pg().query(
                `UPDATE kit_compras
                    SET status = 'pending'
                  WHERE id = $1 AND status = 'processing'`,
                [compra.id]
            );
            throw eEntrega;
        }

        await pg().query(
            `UPDATE kit_compras
                SET status = 'paid',
                    paid_at = NOW(),
                    mp_order_id = COALESCE(mp_order_id, $2)
              WHERE id = $1 AND status = 'processing'`,
            [compra.id, mpOrderId]
        );

        if (compra.story_opt_in && typeof registrarStoryEvento === "function") {
            const kit = await kitPorId(compra.kit_id);
            if (!kit) return { tipo: "kit", ...entregue };
            let summary = kit && kit.package_summary;
            if (typeof summary === "string") {
                try { summary = JSON.parse(summary); } catch(e) { summary = []; }
            }
            if (!Array.isArray(summary)) summary = [];
            const totalPacotes = summary.reduce((sum, item) => sum + (Number(item.quantidade) || 0), 0);
            await registrarStoryEvento({
                eventKey: `kit:${compra.order_id}`,
                kind: "purchase",
                title: "🟡 NOVA COMPRA",
                subtitle: `${Number(kit.espacos) || 0} espaços • ${totalPacotes} pacotes`,
                actionType: "purchase",
                actionId: kit.id,
                metadata: { kitId: kit.id, spaces: Number(kit.espacos) || 0, packs: totalPacotes }
            });
        }

        registrarLog("combo_pagamento_confirmado", {
            compraId: compra.id,
            mpOrderId
        });

        return { tipo: "kit", ...entregue };
    }

    /* =========================================================
       ROTAS PÚBLICAS
    ========================================================= */

    /* Lista de kits ativos (preços calculados no backend). */
    router.get("/kits", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT id, slug, nome, descricao, destaque,
                        preco_normal, preco, espacos, pacotes, bonus,
                        discount_percent, spaces_price, packs_price, package_summary, total_cards,
                        is_active, sort_order
                   FROM kits
                  WHERE is_active = TRUE
                  ORDER BY sort_order ASC, id ASC`
            );
            res.json({
                ok: true,
                kits: q.rows.map(k => {
                    const precoNormal = Number(k.preco_normal);
                    const preco = Number(k.preco);
                    const economia = Math.round((precoNormal - preco) * 100) / 100;
                    const pctDesconto = Number(k.discount_percent) || (precoNormal > 0
                        ? Math.round((economia / precoNormal) * 1000) / 10
                        : 0);
                    const summary = Array.isArray(k.package_summary) ? k.package_summary : [];
                    return {
                        id: k.id,
                        slug: k.slug,
                        nome: k.nome,
                        descricao: k.descricao,
                        destaque: k.destaque,
                        precoNormal,
                        preco,
                        precoSeparado: precoNormal,
                        economia,
                        pctDesconto,
                        espacos: k.espacos,
                        pacotes: Array.isArray(k.pacotes) ? k.pacotes : [],
                        totalPacotes: summary.reduce((acc, p) => acc + (Number(p.quantidade) || 0), 0),
                        spacesPrice: Number(k.spaces_price),
                        packsPrice: Number(k.packs_price),
                        discountPercent: pctDesconto,
                        discountAmount: economia,
                        totalCards: Number(k.total_cards),
                        packageSummary: summary,
                        bonus: k.bonus,
                        licencaIncluida: true,
                        licencas: LICENCAS_KIT
                    };
                })
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Checkout de um kit. Preço vem do banco; o frontend envia
       apenas kitId + plano de licença + dados do comprador. */
    router.post("/kits/:id/checkout", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const kit = await kitAtivoPorId(req.params.id);
            if (!kit) {
                return res.status(404).json({ error: "Kit não encontrado." });
            }

            const usuario = await usuarioPorId(req.usuario.id);
            if (!usuario) {
                return res.status(401).json({ error: "Conta não encontrada." });
            }

            const comprador = normalizarDadosComprador(req.body);
            if (!comprador.documento) {
                return res.status(400).json({ error: "Informe CPF ou CNPJ." });
            }
            if (!validarDocumento(comprador.documento)) {
                return res.status(400).json({ error: "CPF ou CNPJ inválido." });
            }

            if (req.body.aceiteRegras !== true && req.body.aceiteRegras !== "true") {
                return res.status(400).json({
                    error: "Você precisa ler e aceitar as regras da licença para continuar."
                });
            }

            const planoKey = req.body.licensePlan || "1_year";
            if (!LICENCAS_KIT[planoKey]) {
                return res.status(400).json({ error: "Plano de licença inválido." });
            }

            const { licenca, total, totalCents } = calcularTotal(kit, planoKey);

            /* Espaços específicos opcionais (validados livres na entrega). */
            const espacosSugeridos = Array.isArray(req.body.spaces)
                ? req.body.spaces.map(Number)
                : [];

            const orderId = gerarOrderId(`KIT-${kit.id}`);
            const paymentId = crypto.randomUUID();

            const mp = await criarOrderMercadoPago({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: total,
                description: `MegaOutdoor — Kit ${kit.nome} (${licenca.label})`,
                customer: {
                    name: comprador.nome || usuario.nome,
                    taxID: comprador.documento,
                    email: comprador.email || usuario.email
                },
                paymentMethod: req.body.paymentMethod || "pix",
                paymentMethodId: req.body.paymentMethodId,
                cardToken: req.body.cardToken,
                installments: req.body.installments
            });

            await pg().query(
                `INSERT INTO kit_compras
                    (usuario_id, kit_id, order_id, mp_order_id, payment_id,
                     license_plan, license_months, license_fee,
                     preco, total, espacos, status, test, story_opt_in)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13)`,
                [req.usuario.id, kit.id, orderId, String(mp.orderId), paymentId,
                 planoKey, licenca.months, licenca.fee,
                 Number(kit.preco), total,
                 espacosSugeridos,
                 !!process.env.ALLOW_TEST_MODE,
                 req.body.storyOptIn === true || req.body.storyOptIn === "true"]
            );

            registrarLog("combo_pedido_criado", {
                usuarioId: req.usuario.id,
                kitId: kit.id,
                orderId,
                valor: total
            });

            res.json({
                ok: true,
                orderId: String(mp.orderId),
                externalReference: orderId,
                qrCodeBase64: mp.qrCodeBase64,
                payload: mp.payload,
                ticketUrl: mp.ticketUrl,
                expiresDate: mp.expirationDate,
                paymentId: mp.paymentId,
                paymentMethod: mp.paymentMethodId || req.body.paymentMethod,
                paymentStatus: mp.paymentStatus || "pending",
                paid: statusOrderPago(mp.paymentStatus || "pending"),
                valor: total,
                valorCents: totalCents,
                preco: Number(kit.preco),
                licenca,
                kitNome: kit.nome
            });
        } catch (error) {
            registrarLog("combo_checkout_erro", {
                erro: error.message,
                kitId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* Status de um pedido de kit (polling do frontend). */
    router.get("/pagamento/:orderId", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const orderId = req.params.orderId;

            const dono = await pg().query(
                `SELECT usuario_id, mp_order_id, order_id, status, espacos_confirmados
                   FROM kit_compras
                  WHERE (mp_order_id = $1 OR order_id = $1)
                    AND usuario_id = $2
                  LIMIT 1`,
                [orderId, req.usuario.id]
            );
            if (!dono.rows.length) {
                return res.status(403).json({ error: "Acesso negado a este pedido." });
            }

            const mpConsultaId = dono.rows[0].mp_order_id || orderId;
            const ordem = await consultarOrderMercadoPago(mpConsultaId);
            const pago = orderPagaMercadoPago(ordem);

            if (pago) {
                const resultado = await processarPagamento({
                    mpOrderId: mpConsultaId,
                    totalCents: paraCentavos(ordem.total_amount)
                });
                if (resultado) {
                    registrarLog("combo_pagamento_confirmado_polling", {
                        orderId: mpConsultaId,
                        usuarioId: req.usuario.id
                    });
                }
            }

            res.json({
                ok: true,
                status: pago ? "RECEIVED" : (ordem.status || "pending"),
                orderId: orderId,
                entrega: pago ? "confirmada" : "aguardando",
                espacosConfirmados: !!dono.rows[0].espacos_confirmados
            });
        } catch (error) {
            if (error && error.status === 404) {
                return res.status(404).json({ error: "Pedido não encontrado no Mercado Pago." });
            }
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       BENEFÍCIOS DE KIT (CORREÇÃO 7)
       Pagamento aprovado libera um BENEFÍCIO sem alocar espaço
       algum automaticamente. O usuário seleciona manualmente e
       confirma. NENHUMA auto-seleção/primeiro disponível/aleatório.
    ========================================================= */

    async function beneficioPorId(usuarioId, compraId) {
        const q = await pg().query(
            `SELECT kc.*, k.nome AS kit_nome, k.slug AS kit_slug,
                    k.espacos AS espacos_kit, k.preco AS kit_preco
               FROM kit_compras kc
               JOIN kits k ON k.id = kc.kit_id
              WHERE kc.id = $1 AND kc.usuario_id = $2
              LIMIT 1`,
            [Number(compraId), usuarioId]
        );
        return q.rows[0] || null;
    }

    function serializarBeneficio(b) {
        const selecionados = normalizarIdsEspacos(b.espacos);
        const esperados = Number(b.espacos_kit);
        return {
            compraId: Number(b.id),
            kitId: Number(b.kit_id),
            kitNome: b.kit_nome,
            kitSlug: b.kit_slug,
            orderId: b.order_id,
            licensePlan: b.license_plan,
            licenseMonths: Number(b.license_months),
            spacesAllowed: esperados,
            espacosSelecionados: selecionados,
            restantes: Math.max(0, esperados - selecionados.length),
            espacosConfirmados: !!b.espacos_confirmados,
            pagoEm: b.paid_at
        };
    }

    /* Lista os benefícios de kit pagos do usuário que ainda aguardam
       a seleção/confirmação manual dos espaços. */
    router.get("/kits/beneficios", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT kc.*, k.nome AS kit_nome, k.slug AS kit_slug,
                        k.espacos AS espacos_kit, k.preco AS kit_preco
                   FROM kit_compras kc
                   JOIN kits k ON k.id = kc.kit_id
                  WHERE kc.usuario_id = $1
                    AND kc.status = 'paid'
                    AND kc.espacos_confirmados = FALSE
                  ORDER BY kc.paid_at ASC, kc.id ASC`,
                [req.usuario.id]
            );
            res.json({
                ok: true,
                beneficios: q.rows.map(serializarBeneficio)
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Grava a SELEÇÃO TEMPORÁRIA de espaços (idempotente: re-enviar
       substitui a seleção anterior). Não aloca nada no mapa. */
    router.post("/kits/beneficios/:compraId/selecionar", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const beneficio = await beneficioPorId(req.usuario.id, req.params.compraId);
            if (!beneficio) {
                return res.status(404).json({ error: "Benefício de kit não encontrado." });
            }
            if (beneficio.status !== "paid") {
                return res.status(400).json({ error: "Este benefício ainda não foi pago." });
            }
            if (beneficio.espacos_confirmados) {
                return res.status(400).json({ error: "Este benefício já teve os espaços confirmados." });
            }

            const esperados = Number(beneficio.espacos_kit);
            const selecionados = normalizarIdsEspacos(req.body && req.body.espacos);
            if (selecionados.length > esperados) {
                return res.status(400).json({
                    error: `Este kit permite até ${esperados} espaço(s). Selecione no máximo ${esperados}.`
                });
            }

            /* Valida que os espaços escolhidos estão livres AGORA. */
            const db = readDB();
            const ocupados = new Set(Object.keys(db).map(Number));
            for (const id of selecionados) {
                if (ocupados.has(id)) {
                    return res.status(400).json({
                        error: `O espaço ${id} não está mais disponível.`
                    });
                }
            }

            await pg().query(
                `UPDATE kit_compras
                    SET espacos = $3
                  WHERE id = $1 AND usuario_id = $2 AND espacos_confirmados = FALSE`,
                [beneficio.id, req.usuario.id, selecionados]
            );

            res.json({
                ok: true,
                ...serializarBeneficio({
                    ...beneficio,
                    espacos: selecionados
                })
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Confirma a seleção: aloca os espaços no mapa (atômico, sob
       fila de escrita) e marca o benefício como confirmado. A
       quantidade precisa bater EXATAMENTE com a do kit (X/X). */
    router.post("/kits/beneficios/:compraId/confirmar", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const beneficio = await beneficioPorId(req.usuario.id, req.params.compraId);
            if (!beneficio) {
                return res.status(404).json({ error: "Benefício de kit não encontrado." });
            }
            if (beneficio.status !== "paid") {
                return res.status(400).json({ error: "Este benefício ainda não foi pago." });
            }
            if (beneficio.espacos_confirmados) {
                return res.status(409).json({ error: "Este benefício já teve os espaços confirmados." });
            }

            let alocados;
            try {
            alocados = await alocarEspacosConfirmados(beneficio);
            } catch (eConf) {
                return res.status(409).json({ error: eConf.message });
            }

            /* Marca como confirmado (após alocação bem-sucedida). */
            await pg().query(
                `UPDATE kit_compras
                    SET espacos_confirmados = TRUE,
                        paid_at = COALESCE(paid_at, NOW())
                  WHERE id = $1 AND usuario_id = $2 AND espacos_confirmados = FALSE`,
                [beneficio.id, req.usuario.id]
            );

            registrarLog("combo_beneficio_confirmado", {
                compraId: beneficio.id,
                usuarioId: req.usuario.id,
                espacos: alocados
            });

            res.json({
                ok: true,
                espacos: alocados.ids,
                orderToken: alocados.orderToken,
                accessCode: alocados.accessCode,
                espacosConfirmados: true,
                kitNome: beneficio.kit_nome
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Meus kits (compras do usuário logado). */
    router.get("/meus", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT kc.id, kc.kit_id, kc.order_id, kc.license_plan,
                        kc.license_months, kc.preco, kc.total, kc.status,
                        kc.created_at, kc.paid_at, kc.espacos, kc.espacos_confirmados,
                        k.nome, k.slug, k.espacos AS espacos_kit
                   FROM kit_compras kc
                   JOIN kits k ON k.id = kc.kit_id
                  WHERE kc.usuario_id = $1
                  ORDER BY kc.created_at DESC
                  LIMIT 100`,
                [req.usuario.id]
            );
            res.json({
                ok: true,
                compras: q.rows.map(c => ({
                    id: c.id,
                    kitId: c.kit_id,
                    kitNome: c.nome,
                    kitSlug: c.slug,
                    orderId: c.order_id,
                    licensePlan: c.license_plan,
                    licenseMonths: c.license_months,
                    preco: Number(c.preco),
                    total: Number(c.total),
                    status: c.status,
                    criadoEm: c.created_at,
                    pagoEm: c.paid_at,
                    espacos: c.espacos || [],
                    espacosConfirmados: !!c.espacos_confirmados,
                    spacesAllowed: Number(c.espacos_kit)
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post("/test/confirm/:orderId", obterAuthUsuario(), async (req, res) => {
        if (process.env.ALLOW_TEST_MODE !== "true") {
            return res.status(403).json({ error: "Modo de teste desativado." });
        }
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const orderId = req.params.orderId;

            const dono = await pg().query(
                `SELECT usuario_id FROM kit_compras WHERE order_id = $1`,
                [orderId]
            );
            if (!dono.rows.length) {
                return res.status(404).json({ error: "Pedido não encontrado." });
            }
            if (dono.rows[0].usuario_id !== req.usuario.id) {
                return res.status(403).json({ error: "Acesso negado a este pedido." });
            }

            const resultado = await processarPagamento({ mpOrderId: orderId });
            if (!resultado) {
                return res.status(400).json({ error: "Nenhum pedido pendente para este código." });
            }

            registrarLog("combo_pagamento_testado", {
                orderId,
                usuarioId: req.usuario.id,
                tipo: resultado.tipo
            });

            res.json({ ok: true, tipo: resultado.tipo });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       ROTAS DE ADMIN
       Protegidas por authAdmin. Um kit com vendas NUNCA é
       apagado fisicamente — apenas desativado.
    ========================================================= */

    router.get("/admin/kits", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT id, slug, nome, descricao, destaque,
                        preco_normal, preco, espacos, pacotes, bonus,
                        is_active, sort_order, created_at, updated_at
                   FROM kits
                  ORDER BY sort_order ASC, id ASC`
            );

            const v = await pg().query(
                `SELECT kit_id,
                        COUNT(CASE WHEN status = 'paid' THEN 1 END) AS vendas,
                        COALESCE(SUM(CASE WHEN status = 'paid' THEN total END), 0) AS receita
                   FROM kit_compras
                  GROUP BY kit_id`
            );
            const agreg = new Map();
            for (const r of v.rows) {
                agreg.set(r.kit_id, { vendas: Number(r.vendas), receita: Number(r.receita) });
            }

            res.json({
                ok: true,
                kits: q.rows.map(k => {
                    const a = agreg.get(k.id) || { vendas: 0, receita: 0 };
                    return {
                        ...k,
                        preco: Number(k.preco),
                        preco_normal: Number(k.preco_normal),
                        vendas: a.vendas,
                        receita: a.receita
                    };
                })
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post("/admin/kits", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const nome = String(req.body.nome || "").trim();
            if (!nome || nome.length > 100) {
                return res.status(400).json({ error: "Nome do kit inválido." });
            }

            const slug = String(req.body.slug || "").trim().toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "");

            if (!slug) {
                return res.status(400).json({ error: "Slug do kit inválido." });
            }

            const precoNormal = Math.round(Number(req.body.precoNormal) * 100) / 100;
            const preco = Math.round(Number(req.body.preco) * 100) / 100;
            if (!(precoNormal >= 0) || !(preco > 0)) {
                return res.status(400).json({ error: "Preços inválidos." });
            }

            const espacos = Number(req.body.espacos);
            if (!Number.isInteger(espacos) || espacos < 1 || espacos > 1000) {
                return res.status(400).json({ error: "Quantidade de espaços inválida." });
            }

            const pacotes = Array.isArray(req.body.pacotes)
                ? req.body.pacotes
                    .map(p => ({
                        pack_id: Number(p.pack_id),
                        quantidade: Math.max(1, Number(p.quantidade) || 1)
                    }))
                    .filter(p => Number.isInteger(p.pack_id) && p.pack_id > 0)
                : [];

            const r = await pg().query(
                `INSERT INTO kits
                    (slug, nome, descricao, destaque,
                     preco_normal, preco, espacos, pacotes, bonus,
                     is_active, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 RETURNING id`,
                [slug, nome, req.body.descricao || null, req.body.destaque || null,
                 precoNormal, preco, espacos, JSON.stringify(pacotes),
                 req.body.bonus || null,
                 req.body.is_active !== false,
                 Number(req.body.sortOrder) || 0]
            );

            registrarLog("combo_admin_criar", {
                kitId: r.rows[0].id,
                slug
            });

            res.json({ ok: true, id: r.rows[0].id });
        } catch (error) {
            if (error.code === "23505") {
                return res.status(400).json({ error: "Já existe um kit com este slug." });
            }
            res.status(500).json({ error: error.message });
        }
    });

    router.post("/admin/kits/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const kitId = Number(req.params.id);
            const campos = [];
            const params = [];

            const adicionar = (campo, valor) => {
                params.push(valor);
                campos.push(`${campo} = $${params.length}`);
            };

            if (req.body.nome !== undefined) {
                const nome = String(req.body.nome).trim();
                if (!nome || nome.length > 100) {
                    return res.status(400).json({ error: "Nome do kit inválido." });
                }
                adicionar("nome", nome);
            }

            if (req.body.slug !== undefined) {
                const slug = String(req.body.slug).trim().toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/-+/g, "-")
                    .replace(/^-|-$/g, "");
                if (!slug) {
                    return res.status(400).json({ error: "Slug do kit inválido." });
                }
                adicionar("slug", slug);
            }

            if (req.body.preco !== undefined) {
                const preco = Math.round(Number(req.body.preco) * 100) / 100;
                if (!(preco > 0)) {
                    return res.status(400).json({ error: "Preço final inválido." });
                }
                adicionar("preco", preco);
            }

            if (req.body.precoNormal !== undefined) {
                const precoNormal = Math.round(Number(req.body.precoNormal) * 100) / 100;
                if (!(precoNormal >= 0)) {
                    return res.status(400).json({ error: "Preço original inválido." });
                }
                adicionar("preco_normal", precoNormal);
            }

            if (req.body.espacos !== undefined) {
                const espacos = Number(req.body.espacos);
                if (!Number.isInteger(espacos) || espacos < 1 || espacos > 1000) {
                    return res.status(400).json({ error: "Quantidade de espaços inválida." });
                }
                adicionar("espacos", espacos);
            }

            if (req.body.pacotes !== undefined) {
                const pacotes = Array.isArray(req.body.pacotes)
                    ? req.body.pacotes
                        .map(p => ({
                            pack_id: Number(p.pack_id),
                            quantidade: Math.max(1, Number(p.quantidade) || 1)
                        }))
                        .filter(p => Number.isInteger(p.pack_id) && p.pack_id > 0)
                    : [];
                adicionar("pacotes", JSON.stringify(pacotes));
            }

            if (req.body.descricao !== undefined) adicionar("descricao", req.body.descricao || null);
            if (req.body.destaque !== undefined) adicionar("destaque", req.body.destaque || null);
            if (req.body.bonus !== undefined) adicionar("bonus", req.body.bonus || null);
            if (req.body.is_active !== undefined) adicionar("is_active", req.body.is_active === true || req.body.is_active === "true");
            if (req.body.sortOrder !== undefined) adicionar("sort_order", Number(req.body.sortOrder) || 0);

            if (!campos.length) {
                return res.status(400).json({ error: "Nenhum campo para atualizar." });
            }

            params.push(kitId);
            campos.push("updated_at = NOW()");

            const r = await pg().query(
                `UPDATE kits SET ${campos.join(", ")} WHERE id = $${params.length}`,
                params
            );
            if (!r.rowCount) {
                return res.status(404).json({ error: "Kit não encontrado." });
            }

            registrarLog("combo_admin_editar", {
                kitId,
                campos: campos.map(c => c.split(" ")[0])
            });

            res.json({ ok: true });
        } catch (error) {
            if (error.code === "23505") {
                return res.status(400).json({ error: "Já existe um kit com este slug." });
            }
            res.status(500).json({ error: error.message });
        }
    });

    router.post("/admin/kits/:id/toggle", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const kitId = Number(req.params.id);
            const q = await pg().query(
                `SELECT is_active FROM kits WHERE id = $1`,
                [kitId]
            );
            if (!q.rows.length) {
                return res.status(404).json({ error: "Kit não encontrado." });
            }
            const novoEstado = !q.rows[0].is_active;
            await pg().query(
                `UPDATE kits SET is_active = $2, updated_at = NOW() WHERE id = $1`,
                [kitId, novoEstado]
            );
            registrarLog("combo_admin_toggle", { kitId, ativo: novoEstado });
            res.json({ ok: true, is_active: novoEstado });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post("/admin/kits/:id/duplicar", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const kitId = Number(req.params.id);
            const q = await pg().query(
                `SELECT * FROM kits WHERE id = $1`,
                [kitId]
            );
            const kit = q.rows[0];
            if (!kit) {
                return res.status(404).json({ error: "Kit não encontrado." });
            }

            const r = await pg().query(
                `INSERT INTO kits
                    (slug, nome, descricao, destaque,
                     preco_normal, preco, espacos, pacotes, bonus,
                     is_active, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10)
                 RETURNING id`,
                [`${kit.slug}-copia-${Date.now().toString(36)}`,
                 `${kit.nome} (Cópia)`,
                 kit.descricao, kit.destaque,
                 kit.preco_normal, kit.preco, kit.espacos,
                 kit.pacotes, kit.bonus,
                 kit.sort_order + 1]
            );

            registrarLog("combo_admin_duplicar", {
                origem: kitId,
                nova: r.rows[0].id
            });

            res.json({ ok: true, id: r.rows[0].id });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Vendas e receita por kit. */
    router.get("/admin/vendas", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT id, nome, slug FROM kits`
            );
            const v = await pg().query(
                `SELECT kit_id,
                        COUNT(CASE WHEN status = 'paid' THEN 1 END) AS vendas,
                        COALESCE(SUM(CASE WHEN status = 'paid' THEN total END), 0) AS receita,
                        COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pendentes
                   FROM kit_compras
                  GROUP BY kit_id`
            );
            const agreg = new Map();
            for (const r of v.rows) {
                agreg.set(r.kit_id, {
                    vendas: Number(r.vendas),
                    receita: Number(r.receita),
                    pendentes: Number(r.pendentes)
                });
            }

            const porKit = q.rows.map(k => {
                const a = agreg.get(k.id) || { vendas: 0, receita: 0, pendentes: 0 };
                return {
                    kitId: k.id,
                    nome: k.nome,
                    slug: k.slug,
                    vendas: a.vendas,
                    receita: a.receita,
                    pendentes: a.pendentes
                };
            });
            const totalVendas = porKit.reduce((s, r) => s + r.vendas, 0);
            const totalReceita = porKit.reduce((s, r) => s + r.receita, 0);

            res.json({
                ok: true,
                totalVendas,
                totalReceita,
                porKit
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Lista os pacotes de figurinhas disponíveis (para montar kits). */
    router.get("/admin/packs", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de Combos & Kits indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT p.id, p.slug, p.name, p.price, p.sticker_quantity,
                        p.is_active, c.name AS colecao
                   FROM sticker_packs p
                   JOIN sticker_collections c ON c.id = p.collection_id
                  ORDER BY p.is_active DESC, p.id ASC`
            );
            res.json({
                ok: true,
                packs: q.rows.map(p => ({
                    id: p.id,
                    slug: p.slug,
                    name: p.name,
                    price: Number(p.price),
                    sticker_quantity: p.sticker_quantity,
                    is_active: p.is_active,
                    colecao: p.colecao
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return {
        router,
        migrar,
        processarPagamento,
        LICENCAS_KIT
    };
};
