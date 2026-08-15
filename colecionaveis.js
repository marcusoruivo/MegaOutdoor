/* =========================================================
   MEGAOUTDOOR COLECIONÁVEIS — Módulo Backend
   Sistema de figurinhas digitais colecionáveis.

   Independe da lógica de espaços/pagamentos existente.
   Reutiliza pgPool, authUsuario e criarOrderMercadoPago
   injetados pelo server.js.

   Este arquivo NÃO modifica nenhum fluxo existente.
   É montado como router em /api/colecionaveis.
========================================================= */

const express = require("express");
const crypto = require("crypto");

/* =========================================================
   CONFIGURAÇÃO
========================================================= */

const RARIDADES = {
    COMUM:    { chave: "COMUM",    nome: "COMUM",    icone: "⚪", cor: "#9e9e9e", peso: 65 },
    INCOMUM:  { chave: "INCOMUM",  nome: "INCOMUM",  icone: "🟢", cor: "#4caf50", peso: 20 },
    RARA:     { chave: "RARA",     nome: "RARA",     icone: "🔵", cor: "#2196f3", peso: 10 },
    EPICA:    { chave: "EPICA",    nome: "ÉPICA",    icone: "🟣", cor: "#9c27b0", peso: 4 },
    LENDARIA: { chave: "LENDARIA", nome: "LENDÁRIA", icone: "🟡", cor: "#ffb300", peso: 0.9 },
    MITICA:   { chave: "MITICA",   nome: "MÍTICA",   icone: "🔴", cor: "#e53935", peso: 0.1 }
};

const RARIDADE_ORDEM = [
    "COMUM", "INCOMUM", "RARA", "EPICA", "LENDARIA", "MITICA"
];

/* Probabilidades em % (somam 100%). Informadas ao usuário
   antes da compra. Configuráveis. */
const PROBABILIDADES = {
    COMUM: 65,
    INCOMUM: 20,
    RARA: 10,
    EPICA: 4,
    LENDARIA: 0.9,
    MITICA: 0.1
};

const PACKS_PADRAO = [
    {
        slug: "bronze",
        nome: "BRONZE",
        preco: 2,
        quantidade: 3,
        descricao: "3 figurinhas para começar sua coleção."
    },
    {
        slug: "prata",
        nome: "PRATA",
        preco: 5,
        quantidade: 8,
        descricao: "8 figurinhas com chances equilibradas."
    },
    {
        slug: "ouro",
        nome: "OURO",
        preco: 10,
        quantidade: 20,
        descricao: "20 figurinhas com melhores chances de raras."
    },
    {
        slug: "especial",
        nome: "ESPECIAL",
        preco: 20,
        quantidade: 45,
        descricao: "45 figurinhas — a melhor relação custo-benefício."
    }
];

const COLECAO_PADRAO = {
    slug: "primeira-edicao",
    nome: "MEGAOUTDOOR — PRIMEIRA EDIÇÃO",
    edicao: "1ª EDIÇÃO",
    total: 100,
    descricao: "A coleção inaugural de figurinhas digitais do universo MegaOutdoor."
};

const MARKETPLACE_FEE_PERCENT = 10;
const TRADE_TTL_HORAS = 24;
const EXPIRA_BLOQUEIO_HORAS = 24;

/* Conquistas (sistema extensível: basta adicionar no array) */
const CONQUISTAS = [
    { slug: "primeira_figurinha",      nome: "PRIMEIRA FIGURINHA",      descricao: "Adquira sua primeira figurinha.",                     icone: "🃏" },
    { slug: "10_figurinhas",           nome: "10 FIGURINHAS",            descricao: "Acumule 10 figurinhas no acervo.",                    icone: "🔟" },
    { slug: "25_figurinhas",           nome: "25 FIGURINHAS",            descricao: "Acumule 25 figurinhas no acervo.",                    icone: "🖐️" },
    { slug: "50_figurinhas",           nome: "50 FIGURINHAS",            descricao: "Acumule 50 figurinhas no acervo.",                    icone: "🎯" },
    { slug: "100_figurinhas",          nome: "100 FIGURINHAS",           descricao: "Acumule 100 figurinhas no acervo.",                   icone: "💯" },
    { slug: "primeira_rara",           nome: "PRIMEIRA RARA",            descricao: "Adquira sua primeira figurinha RARA.",                icone: "🔵" },
    { slug: "primeira_epica",          nome: "PRIMEIRA ÉPICA",           descricao: "Adquira sua primeira figurinha ÉPICA.",               icone: "🟣" },
    { slug: "primeira_lendaria",       nome: "PRIMEIRA LENDÁRIA",        descricao: "Adquira sua primeira figurinha LENDÁRIA.",            icone: "🟡" },
    { slug: "primeira_mitica",         nome: "PRIMEIRA MÍTICA",          descricao: "Adquira sua primeira figurinha MÍTICA.",              icone: "🔴" },
    { slug: "metade_album",            nome: "50% DO ÁLBUM",             descricao: "Complete 50% do álbum (50 de 100).",                  icone: "📗" },
    { slug: "album_completo",          nome: "ÁLBUM COMPLETO",           descricao: "Complete as 100 figurinhas da 1ª edição.",            icone: "🏆" },
    { slug: "primeira_troca",          nome: "PRIMEIRA TROCA",           descricao: "Conclua sua primeira troca.",                         icone: "🔄" },
    { slug: "primeira_venda",          nome: "PRIMEIRA VENDA",           descricao: "Venda sua primeira figurinha no mercado.",            icone: "💰" }
];

/* Catálogo de 100 figurinhas da 1ª edição.
   Distribuição por raridade:
   COMUM 60 · INCOMUM 25 · RARA 9 · ÉPICA 4 · LENDÁRIA 1 · MÍTICA 1 = 100 */
const CATALOGO = (() => {
    const cards = [];

    const comuns = [
        "O Primeiro Outdoor", "Luzes da Cidade", "Horizonte Digital", "Neon Urbano",
        "A Cidade Conectada", "Marquise Iluminada", "Painel Gigante", "LED na Madrugada",
        "Telão da Avenida", "Estrelas de Concreto", "Vitrine da Metrópole", "O Anúncio Clássico",
        "Cruzamento Brilhante", "Fachada Neon", "Sinais da Cidade", "O Letreiro Dourado",
        "Avenida dos Letreiros", "Pixels no Céu", "Tela Viva", "Cores da Noite",
        "Outdoor do Amanhecer", "Prédio Iluminado", "A Esquina Mágica", "Marquise Clássica",
        "O Painel Dourado", "Cartaz Urbano", "Neon Roxo", "A Rua de Luz",
        "Banners do Centro", "Holofote da Praça", "O Letreiro de Vapor", "Publicidade Noturna",
        "Cidade Infinita", "Marquise Digital", "O Painel Holográfico", "LED Verde",
        "A Torre de Sinais", "Outdoor Retrô", "Neon Vermelho", "A Via Iluminada",
        "Painel de Ouro", "Cidade Elétrica", "O Anúncio Atemporal", "Telas do Horizonte",
        "Marquise de Cristal", "O Letreiro Celeste", "Avenida Neon", "Outdoor em Chamas",
        "Cartazes do Tempo", "A Praça de LED", "Painel Espelhado", "O Anúncio Fantasma",
        "Neon Amarelo", "Cidade em Movimento", "Marquise Reluzente", "O Painel do Futuro",
        "Tela de Prata", "Bairro Iluminado", "O Outdoor Inteligente", "Vitrine Noturna"
    ];

    const incomuns = [
        "Marquise Lendária", "O Sinal Dourado", "Painel da Meia-Noite", "A Rota Neon",
        "Cartaz Reluzente", "O Letreiro do Amanhã", "Cidade Neon", "Marquise Mística",
        "Painel do Horizonte", "O Anúncio Cósmico", "LED Estelar", "A Torre Dourada",
        "Outdoor de Prata", "Praça dos Cartazes", "O Painel Celestial", "Neon do Futuro",
        "Marquise Imperial", "A Avenida de Luz", "Cartaz Dourado", "O Letreiro Supremo",
        "Painel Primordial", "Marquise de Ouro", "O Outdoor Legendário", "A Rua Dourada",
        "Painel dos Deuses"
    ];

    const raras = [
        "Cidade de Cristal", "O Painel Épico", "Marquise Real", "A Estrela do Letreiro",
        "Telão de Ouro", "Marquise Suprema", "O Painel Celestial", "A Cidade Dourada",
        "Marquise de Luz"
    ];

    const epicas = [
        "O Outdoor Épico", "Telão das Estrelas", "Painel Solar", "A Marquise Lendária"
    ];

    const lendaria = ["O Painel Lendário"];

    const mitica = ["Marquise Mítica"];

    const descricaoPadrao = (nome) =>
        `${nome}. Uma peça da 1ª edição do universo MegaOutdoor.`;

    let numero = 0;

    const empilhar = (lista, raridade) => {
        for (const nome of lista) {
            numero++;
            cards.push({
                number: numero,
                name: nome,
                rarity: raridade,
                description: descricaoPadrao(nome)
            });
        }
    };

    empilhar(comuns, "COMUM");
    empilhar(incomuns, "INCOMUM");
    empilhar(raras, "RARA");
    empilhar(epicas, "EPICA");
    empilhar(lendaria, "LENDARIA");
    empilhar(mitica, "MITICA");

    return cards;
})();

/* =========================================================
   HELPERS INTERNOS
========================================================= */

function sortearRaridade() {
    const r = Math.random() * 100;
    let acumulado = 0;
    for (const chave of RARIDADE_ORDEM) {
        acumulado += PROBABILIDADES[chave];
        if (r < acumulado) {
            return chave;
        }
    }
    return "COMUM";
}

/* Sorteia `quantidade` cards respeitando as probabilidades.
   Se não houver card disponível da raridade sorteada, cai para
   a mais próxima disponível. */
function sortearCards(colecao, quantidade) {
    const resultado = [];
    const porRaridade = {};
    for (const card of colecao) {
        (porRaridade[card.rarity] = porRaridade[card.rarity] || []).push(card);
    }

    for (let i = 0; i < quantidade; i++) {
        let raridade = sortearRaridade();
        let pool = porRaridade[raridade] || [];

        if (!pool.length) {
            for (let j = 0; j < RARIDADE_ORDEM.length; j++) {
                const chave = RARIDADE_ORDEM[j];
                if (porRaridade[chave] && porRaridade[chave].length) {
                    raridade = chave;
                    pool = porRaridade[chave];
                    break;
                }
            }
        }

        if (!pool.length) {
            pool = colecao;
        }

        const card = pool[Math.floor(Math.random() * pool.length)];
        resultado.push(card);
    }

    return resultado;
}

function gerarOrderId(prefixo) {
    return `${prefixo}-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/* =========================================================
   MÓDULO
========================================================= */

module.exports = function criarModuloColecionaveis(deps) {

    const {
        express,              // express (Router)
        authUsuario,          // middleware JWT usuário
        authAdmin,            // middleware JWT admin
        criarOrderMercadoPago,
        consultarOrderMercadoPago,
        extrairDadosPagamento,
        statusOrderPago,
        orderPagaMercadoPago,
        paraCentavos,
        registrarLog,
        normalizarDadosComprador,
        validarDocumento,
        formatarErroPagamento
    } = deps;

    const router = express.Router();

    /* Acesso ao pool (dinâmico, pois o server.js pode não ter
       conectado ainda no momento do mount). */
    const obterPool = deps.obterPool;
    const obterPgDisponivel = deps.obterPgDisponivel;
    const obterAuthUsuario = deps.obterAuthUsuario || (() => authUsuario);

    const pg = () => obterPool();
    const pgOk = () => !!obterPgDisponivel();

    /* Validação unificada dos dados do comprador para todos os
       checkouts de colecionáveis (pacotes, mercado e trocas). */
    function validarComprador(req) {
        const comprador = normalizarDadosComprador(req.body);
        if (!comprador.documento) {
            return { ok: false, error: "Informe CPF ou CNPJ." };
        }
        if (!validarDocumento(comprador.documento)) {
            return { ok: false, error: "CPF ou CNPJ inválido." };
        }
        return { ok: true, comprador };
    }

    /* =========================================================
       MIGRAÇÃO DO BANCO
       Chamada pelo server.js dentro de initBanco().
       Apenas CREATE TABLE IF NOT EXISTS / ADD COLUMN.
       NUNCA usa DROP TABLE.
    ========================================================= */

    async function migrar() {
        const pool = obterPool();
        if (!pool) return;

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_collections (
                id          SERIAL PRIMARY KEY,
                slug        VARCHAR(60) UNIQUE NOT NULL,
                name        VARCHAR(200) NOT NULL,
                edition     VARCHAR(60),
                total       INTEGER NOT NULL DEFAULT 0,
                description TEXT,
                is_active   BOOLEAN NOT NULL DEFAULT TRUE,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_cards (
                id            SERIAL PRIMARY KEY,
                collection_id INTEGER NOT NULL
                              REFERENCES sticker_collections(id)
                              ON DELETE CASCADE,
                number        INTEGER NOT NULL,
                name          VARCHAR(200) NOT NULL,
                description   TEXT,
                rarity        VARCHAR(20) NOT NULL,
                image_url     VARCHAR(400),
                is_active     BOOLEAN NOT NULL DEFAULT TRUE,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (collection_id, number)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_packs (
                id                SERIAL PRIMARY KEY,
                collection_id     INTEGER NOT NULL
                                  REFERENCES sticker_collections(id)
                                  ON DELETE CASCADE,
                slug              VARCHAR(60) UNIQUE NOT NULL,
                name              VARCHAR(100) NOT NULL,
                price             NUMERIC(10,2) NOT NULL,
                sticker_quantity  INTEGER NOT NULL,
                description       TEXT,
                is_active         BOOLEAN NOT NULL DEFAULT TRUE,
                created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_pack_purchases (
                id            SERIAL PRIMARY KEY,
                usuario_id    INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                pack_id       INTEGER NOT NULL
                              REFERENCES sticker_packs(id),
                order_id      VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                payment_type  VARCHAR(30) NOT NULL DEFAULT 'STICKER_PACK',
                price         NUMERIC(10,2) NOT NULL,
                quantity      INTEGER NOT NULL,
                status        VARCHAR(20) NOT NULL DEFAULT 'pending',
                test          BOOLEAN NOT NULL DEFAULT FALSE,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                paid_at       TIMESTAMPTZ
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_stickers (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL
                            REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id     INTEGER NOT NULL
                            REFERENCES sticker_cards(id) ON DELETE CASCADE,
                quantity    INTEGER NOT NULL DEFAULT 0,
                acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (usuario_id, card_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_listings (
                id          SERIAL PRIMARY KEY,
                seller_id   INTEGER NOT NULL
                            REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id     INTEGER NOT NULL
                            REFERENCES sticker_cards(id) ON DELETE CASCADE,
                unit_price  NUMERIC(10,2) NOT NULL,
                quantity    INTEGER NOT NULL,
                status      VARCHAR(20) NOT NULL DEFAULT 'active',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_orders (
                id            SERIAL PRIMARY KEY,
                buyer_id      INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                seller_id     INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id       INTEGER NOT NULL
                              REFERENCES sticker_cards(id) ON DELETE CASCADE,
                listing_id    INTEGER NOT NULL
                              REFERENCES sticker_listings(id),
                quantity      INTEGER NOT NULL,
                unit_price    NUMERIC(10,2) NOT NULL,
                total         NUMERIC(10,2) NOT NULL,
                fee           NUMERIC(10,2) NOT NULL,
                net_seller    NUMERIC(10,2) NOT NULL,
                order_id      VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                payment_type  VARCHAR(30) NOT NULL DEFAULT 'STICKER_PURCHASE',
                status        VARCHAR(20) NOT NULL DEFAULT 'pending',
                test          BOOLEAN NOT NULL DEFAULT FALSE,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                paid_at       TIMESTAMPTZ
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_trades (
                id            SERIAL PRIMARY KEY,
                proposer_id   INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                receiver_id   INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                status        VARCHAR(30) NOT NULL DEFAULT 'PENDING',
                cash_direction VARCHAR(20),
                cash_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
                order_id      VARCHAR(60),
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                payment_type  VARCHAR(30) NOT NULL DEFAULT 'STICKER_TRADE',
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at    TIMESTAMPTZ NOT NULL,
                completed_at  TIMESTAMPTZ,
                history       TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_trade_items (
                id          SERIAL PRIMARY KEY,
                trade_id    INTEGER NOT NULL
                            REFERENCES sticker_trades(id) ON DELETE CASCADE,
                owner_id    INTEGER NOT NULL,
                card_id     INTEGER NOT NULL
                            REFERENCES sticker_cards(id) ON DELETE CASCADE,
                side        VARCHAR(20) NOT NULL
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_trade_messages (
                id          SERIAL PRIMARY KEY,
                trade_id    INTEGER NOT NULL
                            REFERENCES sticker_trades(id) ON DELETE CASCADE,
                usuario_id  INTEGER NOT NULL,
                text        TEXT NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_transactions (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL
                            REFERENCES usuarios(id) ON DELETE CASCADE,
                tipo        VARCHAR(40) NOT NULL,
                detalhe     TEXT,
                valor       NUMERIC(10,2) NOT NULL DEFAULT 0,
                ref_id      VARCHAR(60),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_achievements (
                id          SERIAL PRIMARY KEY,
                slug        VARCHAR(60) UNIQUE NOT NULL,
                name        VARCHAR(120) NOT NULL,
                description TEXT,
                icon        VARCHAR(10)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_user_achievements (
                id             SERIAL PRIMARY KEY,
                usuario_id     INTEGER NOT NULL
                               REFERENCES usuarios(id) ON DELETE CASCADE,
                achievement_id INTEGER NOT NULL
                               REFERENCES sticker_achievements(id) ON DELETE CASCADE,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (usuario_id, achievement_id)
            )
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_stickers_usuario
                ON user_stickers(usuario_id)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_listings_status
                ON sticker_listings(status)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_trades_status
                ON sticker_trades(status)
        `);

        /* Ajustes de compatibilidade (colunas existentes em produção). */
        try {
            await pool.query(
                `ALTER TABLE sticker_trades
                   ALTER COLUMN cash_direction TYPE VARCHAR(20)`
            );
        } catch (e) { /* ignora se o PostgreSQL não permitir direto */ }

        await semearBanco(pool);
    }

    /* Seed idempotente: coleção, cards, pacotes, conquistas.
       Não recria nada que já exista. */
    async function semearBanco(pool) {
        const colecaoQ = await pool.query(
            `SELECT id FROM sticker_collections WHERE slug = $1`,
            [COLECAO_PADRAO.slug]
        );
        let colecaoId = colecaoQ.rows[0]?.id;

        if (!colecaoId) {
            const q = await pool.query(
                `INSERT INTO sticker_collections (slug, name, edition, total, description)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                [COLECAO_PADRAO.slug, COLECAO_PADRAO.nome, COLECAO_PADRAO.edicao,
                 COLECAO_PADRAO.total, COLECAO_PADRAO.descricao]
            );
            colecaoId = q.rows[0].id;
        }

        /* Figurinhas */
        for (const card of CATALOGO) {
            await pool.query(
                `INSERT INTO sticker_cards
                    (collection_id, number, name, description, rarity)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (collection_id, number) DO NOTHING`,
                [colecaoId, card.number, card.name, card.description, card.rarity]
            );
        }

        /* Pacotes */
        for (const p of PACKS_PADRAO) {
            await pool.query(
                `INSERT INTO sticker_packs
                    (collection_id, slug, name, price, sticker_quantity, description)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (slug) DO NOTHING`,
                [colecaoId, p.slug, p.nome, p.preco, p.quantidade, p.descricao]
            );
        }

        /* Conquistas */
        for (const c of CONQUISTAS) {
            await pool.query(
                `INSERT INTO sticker_achievements (slug, name, description, icon)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (slug) DO NOTHING`,
                [c.slug, c.nome, c.descricao, c.icone]
            );
        }
    }

    /* =========================================================
       HELPERS DE NEGÓCIO
    ========================================================= */

    async function colecaoAtiva() {
        const q = await pg().query(
            `SELECT * FROM sticker_collections
              WHERE is_active = TRUE
              ORDER BY id LIMIT 1`
        );
        return q.rows[0] || null;
    }

    async function cardPorId(cardId) {
        const q = await pg().query(
            `SELECT * FROM sticker_cards WHERE id = $1`,
            [cardId]
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

    /* Quantidade que o usuário possui de uma figurinha. */
    async function quantidadePossuida(usuarioId, cardId) {
        const q = await pg().query(
            `SELECT quantity FROM user_stickers
              WHERE usuario_id = $1 AND card_id = $2`,
            [usuarioId, cardId]
        );
        return q.rows[0] ? Number(q.rows[0].quantity) : 0;
    }

    /* Quantidade bloqueada por listagens ativas do usuário. */
    async function bloqueadoPorListagem(usuarioId, cardId) {
        const q = await pg().query(
            `SELECT COALESCE(SUM(quantity),0) AS qtd
               FROM sticker_listings
              WHERE seller_id = $1 AND card_id = $2
                AND status = 'active'`,
            [usuarioId, cardId]
        );
        return Number(q.rows[0]?.qtd || 0);
    }

    /* Quantidade bloqueada por negociações ativas do usuário
       (propondo ou recebendo, ainda não concluídas). */
    async function bloqueadoPorTrocas(usuarioId, cardId, excluirTradeId = null) {
        const params = [usuarioId, cardId];
        let excluirSql = "";
        if (excluirTradeId) {
            params.push(excluirTradeId);
            excluirSql = `AND ti.trade_id <> $${params.length}`;
        }
        const q = await pg().query(
            `SELECT COALESCE(SUM(1),0) AS qtd
               FROM sticker_trade_items ti
               JOIN sticker_trades t ON t.id = ti.trade_id
              WHERE ti.owner_id = $1
                AND ti.card_id = $2
                ${excluirSql}
                AND t.status IN
                    ('PENDING','COUNTER_OFFER','ACCEPTED',
                     'WAITING_PAYMENT','PAID','PROCESSING')`,
            params
        );
        return Number(q.rows[0]?.qtd || 0);
    }

    /* Quantidade disponível (possui - bloqueada). */
    async function quantidadeDisponivel(usuarioId, cardId, excluirTradeId = null) {
        const possui = await quantidadePossuida(usuarioId, cardId);
        const bloqListagem = await bloqueadoPorListagem(usuarioId, cardId);
        const bloqTrocas = await bloqueadoPorTrocas(usuarioId, cardId, excluirTradeId);
        return Math.max(0, possui - bloqListagem - bloqTrocas);
    }

    async function registrarTransacaoCol(usuarioId, tipo, detalhe, valor = 0, refId = null) {
        return pg().query(
            `INSERT INTO sticker_transactions (usuario_id, tipo, detalhe, valor, ref_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [usuarioId, tipo, detalhe, valor, refId]
        );
    }

    /* Registra transação para os dois lados de uma negociação. */
    async function registrarTransacaoDupla(usuarioA, usuarioB, tipo, detalhe, valor = 0, refId = null) {
        await registrarTransacaoCol(usuarioA, tipo, detalhe, valor, refId);
        await registrarTransacaoCol(usuarioB, tipo, detalhe, valor, refId);
    }

    /* Adiciona figurinhas ao acervo do usuário (upsert). */
    async function adicionarFigurinha(usuarioId, cardId, quantidade = 1) {
        await pg().query(
            `INSERT INTO user_stickers (usuario_id, card_id, quantity)
             VALUES ($1,$2,$3)
             ON CONFLICT (usuario_id, card_id)
             DO UPDATE SET quantity =
                 user_stickers.quantity + EXCLUDED.quantity`,
            [usuarioId, cardId, quantidade]
        );
    }

    /* Remove figurinhas do acervo (apenas se houver saldo).
       Retorna true se conseguiu remover tudo. */
    async function removerFigurinhas(usuarioId, cardId, quantidade) {
        const q = await pg().query(
            `UPDATE user_stickers
                SET quantity = quantity - $3
              WHERE usuario_id = $1 AND card_id = $2
                AND quantity >= $3
              RETURNING quantity`,
            [usuarioId, cardId, quantidade]
        );
        return q.rows.length > 0;
    }

    /* =========================================================
       CONQUISTAS
    ========================================================= */

    async function desbloquearConquista(usuarioId, slug) {
        const aq = await pg().query(
            `SELECT id FROM sticker_achievements WHERE slug = $1`,
            [slug]
        );
        if (!aq.rows[0]) return false;
        const aid = aq.rows[0].id;
        const q = await pg().query(
            `INSERT INTO sticker_user_achievements (usuario_id, achievement_id)
             VALUES ($1,$2)
             ON CONFLICT (usuario_id, achievement_id) DO NOTHING
             RETURNING id`,
            [usuarioId, aid]
        );
        if (q.rows.length) {
            registrarLog("colecionavel_conquista", { usuarioId, slug });
        }
        return q.rows.length > 0;
    }

    async function verificarConquistas(usuarioId, colecaoId) {
        if (!pgOk()) return [];

        const desbloqueadas = [];

        /* Totais do usuário na coleção */
        const totais = await pg().query(
            `SELECT
                 COALESCE(SUM(us.quantity),0)::int AS total_figurinhas,
                 COUNT(DISTINCT us.card_id)::int    AS diferentes
              FROM user_stickers us
              JOIN sticker_cards c ON c.id = us.card_id
              WHERE us.usuario_id = $1
                AND c.collection_id = $2
                AND us.quantity > 0`,
            [usuarioId, colecaoId]
        );

        const totalFigurinhas = Number(totais.rows[0]?.total_figurinhas || 0);
        const diferentes = Number(totais.rows[0]?.diferentes || 0);

        const raridades = await pg().query(
            `SELECT c.rarity, COUNT(DISTINCT us.card_id)::int AS qtd
               FROM user_stickers us
               JOIN sticker_cards c ON c.id = us.card_id
              WHERE us.usuario_id = $1
                AND c.collection_id = $2
                AND us.quantity > 0
              GROUP BY c.rarity`,
            [usuarioId, colecaoId]
        );

        const rarSet = new Set(raridades.rows.map(r => r.rarity));

        if (totalFigurinhas >= 1) {
            const ok = await desbloquearConquista(usuarioId, "primeira_figurinha");
            if (ok) desbloqueadas.push("primeira_figurinha");
        }
        if (totalFigurinhas >= 10) {
            const ok = await desbloquearConquista(usuarioId, "10_figurinhas");
            if (ok) desbloqueadas.push("10_figurinhas");
        }
        if (totalFigurinhas >= 25) {
            const ok = await desbloquearConquista(usuarioId, "25_figurinhas");
            if (ok) desbloqueadas.push("25_figurinhas");
        }
        if (totalFigurinhas >= 50) {
            const ok = await desbloquearConquista(usuarioId, "50_figurinhas");
            if (ok) desbloqueadas.push("50_figurinhas");
        }
        if (totalFigurinhas >= 100) {
            const ok = await desbloquearConquista(usuarioId, "100_figurinhas");
            if (ok) desbloqueadas.push("100_figurinhas");
        }
        if (rarSet.has("RARA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_rara");
            if (ok) desbloqueadas.push("primeira_rara");
        }
        if (rarSet.has("EPICA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_epica");
            if (ok) desbloqueadas.push("primeira_epica");
        }
        if (rarSet.has("LENDARIA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_lendaria");
            if (ok) desbloqueadas.push("primeira_lendaria");
        }
        if (rarSet.has("MITICA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_mitica");
            if (ok) desbloqueadas.push("primeira_mitica");
        }
        if (diferentes >= 50) {
            const ok = await desbloquearConquista(usuarioId, "metade_album");
            if (ok) desbloqueadas.push("metade_album");
        }
        if (diferentes >= 100) {
            const ok = await desbloquearConquista(usuarioId, "album_completo");
            if (ok) desbloqueadas.push("album_completo");
        }

        return desbloqueadas;
    }

    /* =========================================================
       EXPIRE NEGOCIAÇÕES VENCIDAS
    ========================================================= */

    async function expirarNegociacoesVencidas() {
        if (!pgOk()) return;
        try {
            await pg().query(
                `UPDATE sticker_trades
                    SET status = 'EXPIRED',
                        updated_at = NOW(),
                        history = COALESCE(history,'') ||
                                   E'\n[EXPIRADO] Proposta expirou automaticamente.'
                  WHERE status IN
                        ('PENDING','COUNTER_OFFER','ACCEPTED',
                         'WAITING_PAYMENT','PAID','PROCESSING')
                    AND expires_at < NOW()`
            );
        } catch (e) {
            console.error("ERRO ao expirar negociações:", e.message);
        }
    }

    /* =========================================================
       PAGAMENTO — PROCESSAR CONFIRMAÇÃO
       Chamado pelo webhook (e pelo polling de status).
       Só executa após a Order estar paga.
    ========================================================= */

    async function processarPagamento({ mpOrderId, totalCents }) {
        if (!pgOk()) return null;

        await expirarNegociacoesVencidas();

        const pool = pg();

        const cobradoIgual = (valorReal) =>
            totalCents == null ||
            paraCentavos(valorReal) === totalCents;

        /* 1) Pacote de figurinhas */
        const packQ = await pool.query(
            `SELECT * FROM sticker_pack_purchases
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'pending'
              LIMIT 1`,
            [mpOrderId]
        );
        if (packQ.rows[0]) {
            if (!cobradoIgual(packQ.rows[0].price)) {
                registrarLog("colecionavel_pagamento_valor_divergente", {
                    mpOrderId,
                    tipo: "pack",
                    pedidoId: packQ.rows[0].id,
                    cobradoCents: paraCentavos(packQ.rows[0].price),
                    pagoCents: totalCents
                });
                console.error(
                    "[COLECIONAVEL] VALOR DIVERGENTE (pacote). NÃO entregue.",
                    { mpOrderId, cobradoCents: paraCentavos(packQ.rows[0].price), pagoCents: totalCents }
                );
                return null;
            }
            await confirmarCompraPacote(packQ.rows[0], mpOrderId);
            return { tipo: "pack" };
        }

        /* 2) Compra no mercado (anúncio) */
        const orderQ = await pool.query(
            `SELECT * FROM sticker_orders
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'pending'
              LIMIT 1`,
            [mpOrderId]
        );
        if (orderQ.rows[0]) {
            if (!cobradoIgual(orderQ.rows[0].total)) {
                registrarLog("colecionavel_pagamento_valor_divergente", {
                    mpOrderId,
                    tipo: "purchase",
                    pedidoId: orderQ.rows[0].id,
                    cobradoCents: paraCentavos(orderQ.rows[0].total),
                    pagoCents: totalCents
                });
                console.error(
                    "[COLECIONAVEL] VALOR DIVERGENTE (mercado). NÃO entregue.",
                    { mpOrderId, cobradoCents: paraCentavos(orderQ.rows[0].total), pagoCents: totalCents }
                );
                return null;
            }
            await confirmarCompraMercado(orderQ.rows[0], mpOrderId);
            return { tipo: "purchase" };
        }

        /* 3) Troca com diferença (pagamento da diferença) */
        const tradeQ = await pool.query(
            `SELECT * FROM sticker_trades
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'WAITING_PAYMENT'
              LIMIT 1`,
            [mpOrderId]
        );
        if (tradeQ.rows[0]) {
            if (!cobradoIgual(tradeQ.rows[0].cash_amount)) {
                registrarLog("colecionavel_pagamento_valor_divergente", {
                    mpOrderId,
                    tipo: "trade",
                    pedidoId: tradeQ.rows[0].id,
                    cobradoCents: paraCentavos(tradeQ.rows[0].cash_amount),
                    pagoCents: totalCents
                });
                console.error(
                    "[COLECIONAVEL] VALOR DIVERGENTE (troca). NÃO confirmada.",
                    { mpOrderId, cobradoCents: paraCentavos(tradeQ.rows[0].cash_amount), pagoCents: totalCents }
                );
                return null;
            }
            await confirmarPagamentoTroca(tradeQ.rows[0], mpOrderId);
            return { tipo: "trade" };
        }

        return null;
    }

    /* Entrega figurinhas de um pacote diretamente ao acervo do usuário,
       SEM passar por cobrança (usada pelos Combos & Kits). Idempotente:
       chamada apenas uma vez por pedido pago. */
    async function entregarPacoteParaUsuario({ usuarioId, packId, quantidade = 1, refId = null }) {
        if (!pgOk()) {
            throw new Error("Sistema de colecionáveis indisponível no momento.");
        }

        const pool = pg();

        const packQ = await pool.query(
            `SELECT * FROM sticker_packs WHERE id = $1 AND is_active = TRUE`,
            [packId]
        );
        const pack = packQ.rows[0];
        if (!pack) {
            throw new Error("Pacote de figurinhas não encontrado.");
        }

        const colQ = await pool.query(
            `SELECT * FROM sticker_cards
              WHERE collection_id = $1 AND is_active = TRUE
              ORDER BY id`,
            [pack.collection_id]
        );
        const cards = colQ.rows;

        const sorteadas = sortearCards(cards, quantidade);

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            for (const card of sorteadas) {
                await client.query(
                    `INSERT INTO user_stickers (usuario_id, card_id, quantity)
                     VALUES ($1,$2,1)
                     ON CONFLICT (usuario_id, card_id)
                     DO UPDATE SET quantity =
                         user_stickers.quantity + 1`,
                    [usuarioId, card.id]
                );
            }

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        await registrarTransacaoCol(
            usuarioId,
            "PACOTE_KIT_RECEBIDO",
            `Recebeu ${sorteadas.length} figurinha(s) do pacote ${pack.name} (Kit).`,
            0,
            refId
        );

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(usuarioId, colecao.id);
        }

        return {
            packId: pack.id,
            packName: pack.name,
            figurinhas: sorteadas.length,
            cards: sorteadas.map(c => c.id)
        };
    }

    async function confirmarCompraPacote(compra, mpOrderId) {
        const pool = pg();
        const packQ = await pool.query(
            `SELECT * FROM sticker_packs WHERE id = $1`,
            [compra.pack_id]
        );
        const pack = packQ.rows[0];
        if (!pack) return;

        const colQ = await pool.query(
            `SELECT * FROM sticker_cards
              WHERE collection_id = $1 AND is_active = TRUE
              ORDER BY id`,
            [pack.collection_id]
        );
        const cards = colQ.rows;

        const sorteadas = sortearCards(cards, compra.quantity);

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            for (const card of sorteadas) {
                await client.query(
                    `INSERT INTO user_stickers (usuario_id, card_id, quantity)
                     VALUES ($1,$2,1)
                     ON CONFLICT (usuario_id, card_id)
                     DO UPDATE SET quantity =
                         user_stickers.quantity + 1`,
                    [compra.usuario_id, card.id]
                );
            }

            await client.query(
                `UPDATE sticker_pack_purchases
                    SET status = 'paid', paid_at = NOW(),
                        mp_order_id = COALESCE(mp_order_id, $2)
                  WHERE id = $1`,
                [compra.id, mpOrderId]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        await registrarTransacaoCol(
            compra.usuario_id,
            "PACOTE_COMPRADO",
            `Comprou o pacote ${pack.name} com ${sorteadas.length} figurinhas.`,
            Number(pack.price),
            compra.order_id
        );

        for (const card of sorteadas) {
            await registrarTransacaoCol(
                compra.usuario_id,
                "FIGURINHA_RECEBIDA",
                `Recebeu a figurinha #${String(card.number).padStart(3, "0")} ${card.name}.`,
                0,
                compra.order_id
            );
        }

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(compra.usuario_id, colecao.id);
        }

        registrarLog("colecionavel_pacote_pago", {
            compraId: compra.id,
            mpOrderId,
            usuarioId: compra.usuario_id,
            figurinhas: sorteadas.length
        });
    }

    async function confirmarCompraMercado(order, mpOrderId) {
        const pool = pg();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            /* Bloqueia a linha da listagem para evitar race condition */
            const lq = await client.query(
                `SELECT * FROM sticker_listings
                  WHERE id = $1 FOR UPDATE`,
                [order.listing_id]
            );
            const listing = lq.rows[0];

            if (!listing || listing.status !== "active") {
                throw new Error("Anúncio não está mais ativo.");
            }

            if (listing.quantity < order.quantity) {
                throw new Error("Quantidade insuficiente no anúncio.");
            }

            const novaQtd = listing.quantity - order.quantity;

            if (novaQtd === 0) {
                await client.query(
                    `UPDATE sticker_listings
                        SET status = 'sold'
                      WHERE id = $1`,
                    [listing.id]
                );
            } else {
                await client.query(
                    `UPDATE sticker_listings
                        SET quantity = $2
                      WHERE id = $1`,
                    [listing.id, novaQtd]
                );
            }

            /* Transfere do vendedor para o comprador */
            await client.query(
                `UPDATE user_stickers
                    SET quantity = quantity - $3
                  WHERE usuario_id = $1 AND card_id = $2
                    AND quantity >= $3`,
                [listing.seller_id, order.card_id, order.quantity]
            );

            await client.query(
                `INSERT INTO user_stickers (usuario_id, card_id, quantity)
                 VALUES ($1,$2,$3)
                 ON CONFLICT (usuario_id, card_id)
                 DO UPDATE SET quantity =
                     user_stickers.quantity + EXCLUDED.quantity`,
                [order.buyer_id, order.card_id, order.quantity]
            );

            await client.query(
                `UPDATE sticker_orders
                    SET status = 'paid', paid_at = NOW(),
                        mp_order_id = COALESCE(mp_order_id, $2)
                  WHERE id = $1`,
                [order.id, mpOrderId]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        const card = await cardPorId(order.card_id);
        const cardLabel = card
            ? `#${String(card.number).padStart(3, "0")} ${card.name}`
            : `#${order.card_id}`;

        await registrarTransacaoCol(
            order.buyer_id,
            "COMPRA_MERCADO",
            `Comprou ${order.quantity}x ${cardLabel} por R$ ${Number(order.total).toFixed(2)}.`,
            Number(order.total),
            order.order_id
        );

        await registrarTransacaoCol(
            order.seller_id,
            "VENDA_MERCADO",
            `Vendeu ${order.quantity}x ${cardLabel} por R$ ${Number(order.total).toFixed(2)} (líquido R$ ${Number(order.net_seller).toFixed(2)}).`,
            Number(order.net_seller),
            order.order_id
        );

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(order.buyer_id, colecao.id);
            await desbloquearConquista(order.seller_id, "primeira_venda");
        }

        registrarLog("colecionavel_compra_paga", {
            orderId: order.order_id,
            mpOrderId,
            comprador: order.buyer_id,
            vendedor: order.seller_id
        });
    }

    async function confirmarPagamentoTroca(trade, mpOrderId) {
        const pool = pg();

        await executarTroca(trade, mpOrderId);

        await registrarTransacaoDupla(
            trade.proposer_id,
            trade.receiver_id,
            "TROCA_DIFERENCA",
            `Troca com diferença de R$ ${Number(trade.cash_amount).toFixed(2)} concluída.`,
            Number(trade.cash_amount),
            trade.order_id
        );

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(trade.proposer_id, colecao.id);
            await verificarConquistas(trade.receiver_id, colecao.id);
            await desbloquearConquista(trade.proposer_id, "primeira_troca");
            await desbloquearConquista(trade.receiver_id, "primeira_troca");
        }

        registrarLog("colecionavel_troca_paga", {
            tradeId: trade.id,
            mpOrderId,
            valor: Number(trade.cash_amount)
        });
    }

    /* Executa a transferência de figurinhas de uma negociação
       ACEITA. Usada tanto para troca simples quanto com dinheiro. */
    async function executarTroca(trade, mpOrderId = null) {
        const pool = pg();

        const itemsQ = await pool.query(
            `SELECT * FROM sticker_trade_items WHERE trade_id = $1`,
            [trade.id]
        );
        const items = itemsQ.rows;

        const oferecidas = items.filter(i => i.side === "proposer");
        const recebidas = items.filter(i => i.side === "receiver");

        /* Proposer entrega as que oferece e recebe as que o receiver oferece */
        for (const item of oferecidas) {
            await removerFigurinhas(item.owner_id, item.card_id, 1);
            await adicionarFigurinha(trade.receiver_id, item.card_id, 1);
        }

        for (const item of recebidas) {
            await removerFigurinhas(item.owner_id, item.card_id, 1);
            await adicionarFigurinha(trade.proposer_id, item.card_id, 1);
        }

        await pool.query(
            `UPDATE sticker_trades
                SET status = 'COMPLETED',
                    updated_at = NOW(),
                    completed_at = NOW(),
                    mp_order_id = COALESCE($2, mp_order_id)
              WHERE id = $1`,
            [trade.id, mpOrderId]
        );
    }

    /* =========================================================
       EXPORTAÇÕES PARA O SERVER.JS
    ========================================================= */

    /* Rotas públicas e autenticadas */
    router.get("/info", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();
            const packsQ = await pg().query(
                `SELECT * FROM sticker_packs
                  WHERE collection_id = $1 AND is_active = TRUE
                  ORDER BY price`,
                [colecao.id]
            );
            const cardsQ = await pg().query(
                `SELECT id, number, name, rarity, image_url
                   FROM sticker_cards
                  WHERE collection_id = $1 AND is_active = TRUE
                  ORDER BY number`,
                [colecao.id]
            );
            const cards = cardsQ.rows.map(c => ({
                ...c,
                number: Number(c.number)
            }));

            res.json({
                ok: true,
                colecao: {
                    id: colecao.id,
                    slug: colecao.slug,
                    name: colecao.name,
                    edition: colecao.edition,
                    total: Number(colecao.total),
                    description: colecao.description
                },
                packs: packsQ.rows.map(p => ({
                    id: p.id,
                    slug: p.slug,
                    name: p.name,
                    price: Number(p.price),
                    sticker_quantity: Number(p.sticker_quantity),
                    description: p.description
                })),
                cards,
                raridades: RARIDADE_ORDEM.map(chave => ({
                    chave,
                    nome: RARIDADES[chave].nome,
                    icone: RARIDADES[chave].icone,
                    cor: RARIDADES[chave].cor
                })),
                probabilidades: PROBABILIDADES,
                marketplaceFeePercent: MARKETPLACE_FEE_PERCENT
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.get("/catalogo", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();
            const cardsQ = await pg().query(
                `SELECT id, number, name, description, rarity, image_url
                   FROM sticker_cards
                  WHERE collection_id = $1 AND is_active = TRUE
                  ORDER BY number`,
                [colecao.id]
            );
            res.json({
                ok: true,
                colecao: { id: colecao.id, name: colecao.name, total: Number(colecao.total) },
                cards: cardsQ.rows.map(c => ({ ...c, number: Number(c.number) }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* MEU ÁLBUM — figurinhas possuídas (quantidade). */
    router.get("/meu-album", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const colecao = await colecaoAtiva();
            const q = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.image_url,
                        COALESCE(us.quantity,0) AS quantidade
                   FROM sticker_cards c
                   LEFT JOIN user_stickers us
                          ON us.card_id = c.id
                         AND us.usuario_id = $1
                  WHERE c.collection_id = $2 AND c.is_active = TRUE
                  ORDER BY c.number`,
                [req.usuario.id, colecao.id]
            );
            res.json({
                ok: true,
                colecao: {
                    name: colecao.name,
                    edition: colecao.edition,
                    total: Number(colecao.total)
                },
                cards: q.rows.map(c => ({
                    id: c.id,
                    number: Number(c.number),
                    name: c.name,
                    rarity: c.rarity,
                    image_url: c.image_url,
                    quantidade: Number(c.quantidade)
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* MEU ACERVO — resumo, filtros, busca, ordenação. */
    router.get("/acervo", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const colecao = await colecaoAtiva();

            const {
                raridade, busca, ordenar, pagina = 1
            } = req.query;

            const limite = 60;
            const offset = Math.max(0, (Number(pagina) || 1) - 1) * limite;

            const params = [req.usuario.id, colecao.id];
            let where = `us.quantity > 0
                         AND us.usuario_id = $1
                         AND c.collection_id = $2`;

            if (raridade) {
                params.push(raridade);
                where += ` AND c.rarity = $${params.length}`;
            }
            if (busca) {
                params.push(`%${busca}%`);
                where += ` AND (c.name ILIKE $${params.length}
                                OR c.number::text ILIKE $${params.length})`;
            }

            let order = "c.number ASC";
            if (ordenar === "raridade") {
                order = "CASE c.rarity WHEN 'COMUM' THEN 1 WHEN 'INCOMUM' THEN 2 WHEN 'RARA' THEN 3 WHEN 'EPICA' THEN 4 WHEN 'LENDARIA' THEN 5 WHEN 'MITICA' THEN 6 ELSE 7 END DESC, c.number ASC";
            } else if (ordenar === "recentes") {
                order = "us.acquired_at DESC, c.number ASC";
            }

            const q = await pg().query(
                `SELECT c.id, c.number, c.name, c.description, c.rarity, c.image_url,
                        us.quantity, us.acquired_at
                   FROM user_stickers us
                   JOIN sticker_cards c ON c.id = us.card_id
                  WHERE ${where}
                  ORDER BY ${order}
                  LIMIT ${limite} OFFSET ${offset}`,
                params
            );

            /* Listagens ativas do usuário (para calcular disponível). */
            const listaQ = await pg().query(
                `SELECT card_id, COALESCE(SUM(quantity),0)::int AS qtd
                   FROM sticker_listings
                  WHERE seller_id = $1 AND status = 'active'
                  GROUP BY card_id`,
                [req.usuario.id]
            );
            const listadas = new Map(listaQ.rows.map(r => [r.card_id, Number(r.qtd)]));

            const totalQ = await pg().query(
                `SELECT COUNT(*)::int AS total
                   FROM user_stickers us
                   JOIN sticker_cards c ON c.id = us.card_id
                  WHERE ${where}`,
                params
            );

            const statsQ = await pg().query(
                `SELECT
                     COALESCE(SUM(us.quantity),0)::int AS total,
                     COUNT(DISTINCT us.card_id)::int   AS diferentes,
                     COALESCE(SUM(CASE WHEN us.quantity > 1 THEN us.quantity - 1 ELSE 0 END),0)::int AS repetidas,
                     COALESCE(SUM(CASE WHEN c.rarity IN ('RARA','EPICA','LENDARIA','MITICA') THEN 1 ELSE 0 END),0)::int AS raras
                  FROM user_stickers us
                  JOIN sticker_cards c ON c.id = us.card_id
                 WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2`,
                [req.usuario.id, colecao.id]
            );

            res.json({
                ok: true,
                stats: {
                    total: Number(statsQ.rows[0]?.total || 0),
                    diferentes: Number(statsQ.rows[0]?.diferentes || 0),
                    repetidas: Number(statsQ.rows[0]?.repetidas || 0),
                    raras: Number(statsQ.rows[0]?.raras || 0)
                },
                cards: q.rows.map(c => ({
                    id: c.id,
                    number: Number(c.number),
                    name: c.name,
                    description: c.description,
                    rarity: c.rarity,
                    image_url: c.image_url,
                    quantidade: Number(c.quantity),
                    disponivel: Math.max(0, Number(c.quantity) - Number(listadas.get(c.id) || 0)),
                    acquired_at: c.acquired_at
                })),
                pagina: Number(pagina) || 1,
                totalItems: Number(totalQ.rows[0]?.total || 0),
                totalPaginas: Math.max(1, Math.ceil((Number(totalQ.rows[0]?.total || 0)) / limite))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* DETALHE de uma figurinha do acervo. */
    router.get("/figurinha/:id", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const card = await cardPorId(req.params.id);
            if (!card) {
                return res.status(404).json({ error: "Figurinha não encontrada." });
            }

            const q = await pg().query(
                `SELECT quantity, acquired_at FROM user_stickers
                  WHERE usuario_id = $1 AND card_id = $2`,
                [req.usuario.id, card.id]
            );

            const circulQ = await pg().query(
                `SELECT COALESCE(SUM(quantity),0)::int AS total
                   FROM user_stickers WHERE card_id = $1`,
                [card.id]
            );

            res.json({
                ok: true,
                card: {
                    id: card.id,
                    number: Number(card.number),
                    name: card.name,
                    description: card.description,
                    rarity: card.rarity,
                    image_url: card.image_url,
                    quantidade: q.rows[0] ? Number(q.rows[0].quantity) : 0,
                    acquired_at: q.rows[0]?.acquired_at || null,
                    disponivel: await quantidadeDisponivel(req.usuario.id, card.id),
                    total_em_circulacao: Number(circulQ.rows[0]?.total || 0)
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       PACOTES — CHECKOUT
    ========================================================= */

    router.post("/packs/:id/checkout", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const validacao = validarComprador(req);
            if (!validacao.ok) {
                return res.status(400).json({ error: validacao.error });
            }
            const comprador = validacao.comprador;

            const packQ = await pg().query(
                `SELECT * FROM sticker_packs
                  WHERE id = $1 AND is_active = TRUE`,
                [req.params.id]
            );
            const pack = packQ.rows[0];
            if (!pack) {
                return res.status(404).json({ error: "Pacote não encontrado." });
            }

            const usuario = await usuarioPorId(req.usuario.id);
            if (!usuario) {
                return res.status(401).json({ error: "Conta não encontrada." });
            }

            const valor = Number(pack.price);
            const orderId = gerarOrderId("COL-PACK");
            const paymentId = crypto.randomUUID();

            /* Preço vem do banco, nunca do frontend. */
            const mp = await criarOrderMercadoPago({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: valor,
                description: `MegaOutdoor Colecionáveis — Pacote ${pack.name}`,
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
                `INSERT INTO sticker_pack_purchases
                    (usuario_id, pack_id, order_id, mp_order_id, payment_id,
                     payment_type, price, quantity, status, test)
                 VALUES ($1,$2,$3,$4,$5,'STICKER_PACK',$6,$7,'pending',$8)`,
                [req.usuario.id, pack.id, orderId, String(mp.orderId), paymentId,
                 valor, Number(pack.sticker_quantity),
                 !!process.env.ALLOW_TEST_MODE]
            );

            await registrarTransacaoCol(
                req.usuario.id,
                "PACOTE_PEDIDO",
                `Pedido do pacote ${pack.name} criado.`,
                valor,
                orderId
            );

            registrarLog("colecionavel_pacote_pedido", {
                usuarioId: req.usuario.id,
                packId: pack.id,
                orderId
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
                valor: valor
            });
        } catch (error) {
            registrarLog("colecionavel_pacote_erro", {
                erro: error.message,
                packId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* Status de um pedido de colecionável (polling do frontend). */
    router.get("/pagamento/:orderId", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const orderId = req.params.orderId;

            /* Verifica se a Order pertence a algum pedido do usuário.
               Aceita tanto o id numérico do Mercado Pago (mp_order_id)
               quanto o externalReference (order_id) usado no frontend. */
            const dono = await pg().query(
                `SELECT usuario_id, mp_order_id, order_id, status
                   FROM sticker_pack_purchases
                  WHERE (mp_order_id = $1 OR order_id = $1) AND usuario_id = $2
                 UNION ALL
                 SELECT buyer_id, mp_order_id, order_id, status
                   FROM sticker_orders
                  WHERE (mp_order_id = $1 OR order_id = $1) AND buyer_id = $2
                 UNION ALL
                 SELECT proposer_id, mp_order_id, order_id, status
                   FROM sticker_trades
                  WHERE (mp_order_id = $1 OR order_id = $1) AND proposer_id = $2`,
                [orderId, req.usuario.id]
            );

            if (!dono.rows.length) {
                return res.status(403).json({ error: "Acesso negado a este pedido." });
            }

            /* Consulta no MP pelo id numérico real da Order. */
            const mpConsultaId = dono.rows[0].mp_order_id || orderId;
            const ordem = await consultarOrderMercadoPago(mpConsultaId);
            const pago = orderPagaMercadoPago(ordem);

            if (pago) {
                const resultado = await processarPagamento({
                    mpOrderId: mpConsultaId,
                    totalCents: paraCentavos(ordem.total_amount)
                });
                if (resultado) {
                    registrarLog("colecionavel_pagamento_confirmado_polling", {
                        orderId: mpConsultaId,
                        usuarioId: req.usuario.id
                    });
                }
            }

            res.json({
                ok: true,
                status: pago ? "RECEIVED" : (ordem.status || "pending"),
                orderId
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       MERCADO DE FIGURINHAS
    ========================================================= */

    /* Lista anúncios ativos com paginação e filtros. */
    router.get("/marketplace", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const { pagina = 1, raridade, precoMin, precoMax, busca, vendedor } = req.query;
            const limite = 24;
            const offset = Math.max(0, (Number(pagina) || 1) - 1) * limite;

            const params = [];
            let where = `l.status = 'active' AND c.is_active = TRUE`;

            if (raridade) {
                params.push(raridade);
                where += ` AND c.rarity = $${params.length}`;
            }
            if (precoMin) {
                params.push(Number(precoMin));
                where += ` AND l.unit_price >= $${params.length}`;
            }
            if (precoMax) {
                params.push(Number(precoMax));
                where += ` AND l.unit_price <= $${params.length}`;
            }
            if (busca) {
                params.push(`%${busca}%`);
                where += ` AND (c.name ILIKE $${params.length}
                                OR c.number::text ILIKE $${params.length})`;
            }
            if (vendedor) {
                params.push(`%${vendedor}%`);
                where += ` AND u.nome ILIKE $${params.length}`;
            }

            const q = await pg().query(
                `SELECT l.id, l.seller_id, l.unit_price, l.quantity,
                        c.id AS card_id, c.number, c.name, c.rarity, c.image_url,
                        u.nome AS vendedor_nome, u.email AS vendedor_email
                   FROM sticker_listings l
                   JOIN sticker_cards c ON c.id = l.card_id
                   JOIN usuarios u ON u.id = l.seller_id
                  WHERE ${where}
                  ORDER BY l.created_at DESC
                  LIMIT ${limite} OFFSET ${offset}`,
                params
            );

            const totalQ = await pg().query(
                `SELECT COUNT(*)::int AS total
                   FROM sticker_listings l
                   JOIN sticker_cards c ON c.id = l.card_id
                   JOIN usuarios u ON u.id = l.seller_id
                  WHERE ${where}`,
                params
            );

            res.json({
                ok: true,
                listings: q.rows.map(l => ({
                    id: l.id,
                    seller_id: l.seller_id,
                    seller_nome: l.vendedor_nome,
                    unit_price: Number(l.unit_price),
                    quantity: Number(l.quantity),
                    card_id: l.card_id,
                    number: Number(l.number),
                    name: l.name,
                    rarity: l.rarity,
                    image_url: l.image_url
                })),
                pagina: Number(pagina) || 1,
                totalItems: Number(totalQ.rows[0]?.total || 0),
                totalPaginas: Math.max(1, Math.ceil((Number(totalQ.rows[0]?.total || 0)) / limite))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Cria anúncio de venda. */
    router.post("/listings", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const { cardId, quantidade, preco } = req.body;

            const card = await cardPorId(cardId);
            if (!card || !card.is_active) {
                return res.status(400).json({ error: "Figurinha inválida." });
            }

            const qtd = Number(quantidade);
            const precoUnit = Number(preco);

            if (!Number.isInteger(qtd) || qtd < 1) {
                return res.status(400).json({ error: "Quantidade inválida." });
            }
            if (!isFinite(precoUnit) || precoUnit <= 0 || precoUnit > 99999) {
                return res.status(400).json({ error: "Preço inválido." });
            }

            const disponivel = await quantidadeDisponivel(req.usuario.id, card.id);
            if (qtd > disponivel) {
                return res.status(400).json({
                    error: `Você possui apenas ${disponivel} disponível(s) desta figurinha.`
                });
            }

            const insert = await pg().query(
                `INSERT INTO sticker_listings
                    (seller_id, card_id, unit_price, quantity, status)
                 VALUES ($1,$2,$3,$4,'active')
                 RETURNING id`,
                [req.usuario.id, card.id, precoUnit, qtd]
            );
            const listingId = insert.rows[0].id;

            await registrarTransacaoCol(
                req.usuario.id,
                "ANUNCIO_CRIADO",
                `Colocou ${qtd}x #${String(card.number).padStart(3, "0")} ${card.name} à venda por R$ ${precoUnit.toFixed(2)}.`,
                0
            );

            registrarLog("colecionavel_listing_criado", {
                usuarioId: req.usuario.id,
                cardId: card.id,
                quantidade: qtd,
                preco: precoUnit
            });

            res.json({ ok: true, id: listingId });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Meus anúncios. */
    router.get("/listings/mine", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT l.id, l.unit_price, l.quantity, l.status, l.created_at,
                        c.number, c.name, c.rarity, c.image_url
                   FROM sticker_listings l
                   JOIN sticker_cards c ON c.id = l.card_id
                  WHERE l.seller_id = $1
                  ORDER BY l.created_at DESC`,
                [req.usuario.id]
            );
            res.json({
                ok: true,
                listings: q.rows.map(l => ({
                    id: l.id,
                    unit_price: Number(l.unit_price),
                    quantity: Number(l.quantity),
                    status: l.status,
                    created_at: l.created_at,
                    number: Number(l.number),
                    name: l.name,
                    rarity: l.rarity,
                    image_url: l.image_url
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Cancela anúncio (devolve figurinhas à disponibilidade). */
    router.delete("/listings/:id", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_listings WHERE id = $1`,
                [req.params.id]
            );
            const listing = q.rows[0];
            if (!listing) {
                return res.status(404).json({ error: "Anúncio não encontrado." });
            }
            if (listing.seller_id !== req.usuario.id) {
                return res.status(403).json({ error: "Este anúncio não é seu." });
            }
            if (listing.status !== "active") {
                return res.status(400).json({ error: "Este anúncio não está ativo." });
            }

            await pg().query(
                `UPDATE sticker_listings SET status = 'cancelled'
                  WHERE id = $1`,
                [listing.id]
            );

            const card = await cardPorId(listing.card_id);
            await registrarTransacaoCol(
                req.usuario.id,
                "ANUNCIO_CANCELADO",
                `Cancelou o anúncio de ${listing.quantity}x ${card ? card.name : "figurinha"}.`,
                0
            );

            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Compra de um anúncio — cria pedido com pagamento. */
    router.post("/listings/:id/buy", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const validacao = validarComprador(req);
            if (!validacao.ok) {
                return res.status(400).json({ error: validacao.error });
            }
            const comprador = validacao.comprador;

            const q = await pg().query(
                `SELECT * FROM sticker_listings WHERE id = $1`,
                [req.params.id]
            );
            const listing = q.rows[0];
            if (!listing || listing.status !== "active") {
                return res.status(404).json({ error: "Anúncio não disponível." });
            }

            if (listing.seller_id === req.usuario.id) {
                return res.status(400).json({ error: "Você não pode comprar do próprio anúncio." });
            }

            const qtd = Math.max(1, Math.min(Number(req.body.quantidade) || 1, Number(listing.quantity)));

            const total = Math.round(listing.unit_price * qtd * 100) / 100;
            const fee = Math.round(total * MARKETPLACE_FEE_PERCENT) / 100;
            const netSeller = Math.round((total - fee) * 100) / 100;

            const usuario = await usuarioPorId(req.usuario.id);
            if (!usuario) {
                return res.status(401).json({ error: "Conta não encontrada." });
            }

            const orderId = gerarOrderId("COL-BUY");
            const paymentId = crypto.randomUUID();

            const mp = await criarOrderMercadoPago({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: total,
                description: `MegaOutdoor Colecionáveis — Compra no mercado`,
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
                `INSERT INTO sticker_orders
                    (buyer_id, seller_id, card_id, listing_id, quantity,
                     unit_price, total, fee, net_seller, order_id, mp_order_id, payment_id,
                     payment_type, status, test)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                         'STICKER_PURCHASE','pending',$13)`,
                [req.usuario.id, listing.seller_id, listing.card_id, listing.id,
                 qtd, Number(listing.unit_price), total, fee, netSeller,
                 orderId, String(mp.orderId), paymentId, !!process.env.ALLOW_TEST_MODE]
            );

            await registrarTransacaoCol(
                req.usuario.id,
                "PEDIDO_MERCADO",
                `Pedido de compra no mercado (${qtd}x) criado.`,
                total,
                orderId
            );

            registrarLog("colecionavel_pedido_mercado", {
                usuarioId: req.usuario.id,
                listingId: listing.id,
                orderId
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
                total,
                fee,
                netSeller
            });
        } catch (error) {
            registrarLog("colecionavel_mercado_erro", {
                erro: error.message,
                listingId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* =========================================================
       NEGOCIAÇÕES (TROCAS)
       ========================================================= */

    async function validarItemsTroca(items) {
        if (!Array.isArray(items) || !items.length) {
            return { error: "Selecione pelo menos uma figurinha." };
        }
        const norm = [];
        const vistos = new Set();
        for (const item of items) {
            const cardId = Number(item?.cardId);
            if (!Number.isInteger(cardId) || cardId < 1) {
                return { error: "Figurinha inválida na proposta." };
            }
            if (vistos.has(cardId)) continue;
            vistos.add(cardId);
            norm.push({ cardId });
        }
        return { items: norm };
    }

    /* Cria proposta de troca. */
    router.post("/trades", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();

            const receiverId = Number(req.body.receiverId);
            if (!Number.isInteger(receiverId) || receiverId === req.usuario.id) {
                return res.status(400).json({ error: "Destinatário inválido." });
            }
            const receptor = await usuarioPorId(receiverId);
            if (!receptor) {
                return res.status(404).json({ error: "Usuário não encontrado." });
            }

            const minhas = await validarItemsTroca(req.body.ofereco);
            if (minhas.error) return res.status(400).json({ error: minhas.error });
            const delas = await validarItemsTroca(req.body.recebo);
            if (delas.error) return res.status(400).json({ error: delas.error });

            let cashAmount = Math.max(0, Number(req.body.cashAmount) || 0);
            if (cashAmount > 0) {
                cashAmount = Math.round(cashAmount * 100) / 100;
                if (cashAmount > 5000) {
                    return res.status(400).json({ error: "Valor da diferença muito alto." });
                }
            }
            const cashDirection = req.body.cashDirection || null;
            if (cashAmount > 0 && cashDirection !== "proposer_pays" && cashDirection !== "receiver_pays") {
                return res.status(400).json({ error: "Defina quem paga a diferença." });
            }

            /* Valida propriedade e disponibilidade (race-safe via lock) */
            for (const item of minhas.items) {
                const possuo = await quantidadeDisponivel(req.usuario.id, item.cardId);
                if (possuo < 1) {
                    return res.status(400).json({ error: "Uma figurinha que você oferece não está disponível." });
                }
                const card = await cardPorId(item.cardId);
                if (!card) return res.status(400).json({ error: "Figurinha inválida." });
            }

            /* O destinatário precisa possuir as figurinhas pedidas */
            for (const item of delas.items) {
                const possuo = await quantidadePossuida(receiverId, item.cardId);
                if (possuo < 1) {
                    return res.status(400).json({ error: "O destinatário não possui uma das figurinhas pedidas." });
                }
            }

            const expiresAt = new Date(Date.now() + TRADE_TTL_HORAS * 3600 * 1000);

            const tQ = await pg().query(
                `INSERT INTO sticker_trades
                    (proposer_id, receiver_id, status, cash_direction,
                     cash_amount, order_id, payment_type, expires_at)
                 VALUES ($1,$2,'PENDING',$3,$4,$5,'STICKER_TRADE',$6)
                 RETURNING id`,
                [req.usuario.id, receiverId, cashDirection,
                 cashAmount, cashAmount > 0 ? gerarOrderId("COL-TRADE") : null,
                 expiresAt]
            );
            const tradeId = tQ.rows[0].id;

            for (const item of minhas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'proposer')`,
                    [tradeId, req.usuario.id, item.cardId]
                );
            }
            for (const item of delas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'receiver')`,
                    [tradeId, receiverId, item.cardId]
                );
            }

            const hist = `[CRIADA] Proposta de troca criada por ${req.usuario.nome}.`;
            await pg().query(
                `UPDATE sticker_trades SET history = $2 WHERE id = $1`,
                [tradeId, hist]
            );

            await registrarTransacaoDupla(
                req.usuario.id,
                receiverId,
                "TROCA_PROPOSTA",
                `Proposta de troca ${cashAmount > 0 ? "com diferença de R$ " + cashAmount.toFixed(2) : "simples"} criada.`,
                cashAmount
            );

            registrarLog("colecionavel_troca_criada", {
                tradeId,
                proposer: req.usuario.id,
                receiver: receiverId,
                comDinheiro: cashAmount > 0
            });

            res.json({ ok: true, tradeId });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Lista negociações em que o usuário participa. */
    router.get("/trades/mine", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const q = await pg().query(
                `SELECT t.*, pu.nome AS proposer_nome, ru.nome AS receiver_nome
                   FROM sticker_trades t
                   JOIN usuarios pu ON pu.id = t.proposer_id
                   JOIN usuarios ru ON ru.id = t.receiver_id
                  WHERE t.proposer_id = $1 OR t.receiver_id = $1
                  ORDER BY t.updated_at DESC
                  LIMIT 100`,
                [req.usuario.id]
            );

            /* Itens e mensagens de cada negociação (para o card completo). */
            const trades = [];
            for (const t of q.rows) {
                const itemsQ = await pg().query(
                    `SELECT ti.owner_id, ti.card_id, c.number, c.name, c.rarity
                       FROM sticker_trade_items ti
                       JOIN sticker_cards c ON c.id = ti.card_id
                      WHERE ti.trade_id = $1`,
                    [t.id]
                );
                const msgsQ = await pg().query(
                    `SELECT m.id, m.usuario_id, m.text, m.created_at, u.nome AS autor_nome
                       FROM sticker_trade_messages m
                       JOIN usuarios u ON u.id = m.usuario_id
                      WHERE m.trade_id = $1
                      ORDER BY m.created_at ASC`,
                    [t.id]
                );
                trades.push({
                    id: t.id,
                    proposer_id: t.proposer_id,
                    proposer_nome: t.proposer_nome,
                    receiver_id: t.receiver_id,
                    receiver_nome: t.receiver_nome,
                    status: t.status,
                    cash_direction: t.cash_direction,
                    cash_amount: Number(t.cash_amount),
                    created_at: t.created_at,
                    updated_at: t.updated_at,
                    expires_at: t.expires_at,
                    history: t.history || "",
                    items: itemsQ.rows,
                    messages: msgsQ.rows
                });
            }

            res.json({
                ok: true,
                trades
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Detalhe de uma negociação (itens + histórico + chat). */
    router.get("/trades/:id", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const q = await pg().query(
                `SELECT t.*, pu.nome AS proposer_nome, ru.nome AS receiver_nome
                   FROM sticker_trades t
                   JOIN usuarios pu ON pu.id = t.proposer_id
                   JOIN usuarios ru ON ru.id = t.receiver_id
                  WHERE t.id = $1`,
                [req.params.id]
            );
            const trade = q.rows[0];
            if (!trade) {
                return res.status(404).json({ error: "Negociação não encontrada." });
            }
            if (trade.proposer_id !== req.usuario.id && trade.receiver_id !== req.usuario.id) {
                return res.status(403).json({ error: "Acesso negado a esta negociação." });
            }

            const itemsQ = await pg().query(
                `SELECT ti.id, ti.owner_id, ti.card_id, ti.side,
                        c.number, c.name, c.rarity, c.image_url
                   FROM sticker_trade_items ti
                   JOIN sticker_cards c ON c.id = ti.card_id
                  WHERE ti.trade_id = $1`,
                [trade.id]
            );

            const msgsQ = await pg().query(
                `SELECT m.id, m.usuario_id, m.text, m.created_at, u.nome
                   FROM sticker_trade_messages m
                   JOIN usuarios u ON u.id = m.usuario_id
                  WHERE m.trade_id = $1
                  ORDER BY m.created_at ASC`,
                [trade.id]
            );

            res.json({
                ok: true,
                trade: {
                    id: trade.id,
                    proposer_id: trade.proposer_id,
                    proposer_nome: trade.proposer_nome,
                    receiver_id: trade.receiver_id,
                    receiver_nome: trade.receiver_nome,
                    status: trade.status,
                    cash_direction: trade.cash_direction,
                    cash_amount: Number(trade.cash_amount),
                    order_id: trade.order_id,
                    created_at: trade.created_at,
                    updated_at: trade.updated_at,
                    expires_at: trade.expires_at,
                    history: trade.history || "",
                    euSouProposer: trade.proposer_id === req.usuario.id,
                    items: itemsQ.rows,
                    messages: msgsQ.rows
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Chat da negociação. */
    router.post("/trades/:id/messages", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_trades WHERE id = $1`,
                [req.params.id]
            );
            const trade = q.rows[0];
            if (!trade) {
                return res.status(404).json({ error: "Negociação não encontrada." });
            }
            if (trade.proposer_id !== req.usuario.id && trade.receiver_id !== req.usuario.id) {
                return res.status(403).json({ error: "Acesso negado." });
            }

            const texto = String(req.body.text || "").trim();
            if (!texto || texto.length > 500) {
                return res.status(400).json({ error: "Mensagem inválida." });
            }

            const mQ = await pg().query(
                `INSERT INTO sticker_trade_messages (trade_id, usuario_id, text)
                 VALUES ($1,$2,$3)
                 RETURNING id, usuario_id, text, created_at`,
                [trade.id, req.usuario.id, texto]
            );

            res.json({ ok: true, message: mQ.rows[0] });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    async function podeAtualizarTrade(tradeId, usuarioId, roles) {
        const q = await pg().query(
            `SELECT * FROM sticker_trades WHERE id = $1`,
            [tradeId]
        );
        const trade = q.rows[0];
        if (!trade) return { trade: null };
        const ehProposer = trade.proposer_id === usuarioId;
        const ehReceiver = trade.receiver_id === usuarioId;
        const ok = (roles.proposer && ehProposer) || (roles.receiver && ehReceiver);
        return { trade, ok };
    }

    async function registrarHistoricoTrade(tradeId, linha) {
        await pg().query(
            `UPDATE sticker_trades
                SET history = COALESCE(history,'') || E'\n' || $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [tradeId, linha]
        );
    }

    /* Aceitar proposta. Se houver diferença em dinheiro, cria
       cobrança e aguarda pagamento (WAITING_PAYMENT). Caso contrário,
       executa a troca imediatamente. */
    router.post("/trades/:id/accept", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();

            const { trade, ok } = await podeAtualizarTrade(
                req.params.id, req.usuario.id, { proposer: false, receiver: true }
            );

            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (!ok) return res.status(403).json({ error: "Somente o destinatário pode aceitar." });

            if (trade.status !== "PENDING" && trade.status !== "COUNTER_OFFER") {
                return res.status(400).json({ error: "Esta proposta não pode mais ser aceita." });
            }
            if (new Date(trade.expires_at) < new Date()) {
                return res.status(400).json({ error: "Esta proposta expirou." });
            }

            /* Revalida disponibilidade das figurinhas antes de aceitar.
               A própria troca ainda está PENDING — exclui-a do bloqueio. */
            const itemsQ = await pg().query(
                `SELECT * FROM sticker_trade_items WHERE trade_id = $1`,
                [trade.id]
            );
            for (const item of itemsQ.rows) {
                const disp = await quantidadeDisponivel(item.owner_id, item.card_id, trade.id);
                if (disp < 1) {
                    return res.status(400).json({
                        error: "Uma das figurinhas não está mais disponível."
                    });
                }
            }

            if (Number(trade.cash_amount) > 0) {
                const validacao = validarComprador(req);
                if (!validacao.ok) {
                    return res.status(400).json({ error: validacao.error });
                }
                const comprador = validacao.comprador;

                /* Cobrança da diferença. Quem paga = cash_direction */
                const paganteId = trade.cash_direction === "proposer_pays"
                    ? trade.proposer_id : trade.receiver_id;

                const pagante = await usuarioPorId(paganteId);
                const orderId = trade.order_id || gerarOrderId("COL-TRADE-PAY");

                const mp = await criarOrderMercadoPago({
                    idempotencyKey: orderId,
                    externalReference: orderId,
                    value: Number(trade.cash_amount),
                    description: `MegaOutdoor Colecionáveis — Diferença de troca`,
                    customer: {
                        name: comprador.nome || pagante.nome,
                        taxID: comprador.documento,
                        email: comprador.email || pagante.email
                    },
                    paymentMethod: req.body.paymentMethod || "pix",
                    paymentMethodId: req.body.paymentMethodId,
                    cardToken: req.body.cardToken,
                    installments: req.body.installments
                });

                await pg().query(
                    `UPDATE sticker_trades
                        SET status = 'WAITING_PAYMENT',
                            order_id = $2,
                            mp_order_id = $3,
                            updated_at = NOW()
                      WHERE id = $1`,
                    [trade.id, orderId, String(mp.orderId)]
                );

                await registrarHistoricoTrade(trade.id, `[ACEITA] Negociação aceita. Aguardando pagamento da diferença.`);
                await registrarTransacaoCol(
                    paganteId,
                    "TROCA_DIFERENCA_PEDIDO",
                    `Cobrança da diferença de R$ ${Number(trade.cash_amount).toFixed(2)} criada.`,
                    Number(trade.cash_amount),
                    orderId
                );

                registrarLog("colecionavel_troca_aguardando_pagamento", {
                    tradeId: trade.id,
                    orderId,
                    paganteId
                });

                return res.json({
                    ok: true,
                    status: "WAITING_PAYMENT",
                    orderId: String(mp.orderId),
                    externalReference: orderId,
                    qrCodeBase64: mp.qrCodeBase64,
                    payload: mp.payload,
                    ticketUrl: mp.ticketUrl,
                    expiresDate: mp.expirationDate,
                    paymentId: mp.paymentId,
                    valor: Number(trade.cash_amount)
                });
            }

            /* Troca simples — executa imediatamente */
            await executarTroca(trade);

            await registrarHistoricoTrade(trade.id, `[CONCLUÍDA] Troca executada.`);
            await registrarTransacaoDupla(
                trade.proposer_id,
                trade.receiver_id,
                "TROCA_CONCLUIDA",
                "Troca de figurinhas concluída.",
                0
            );

            const colecao = await colecaoAtiva();
            if (colecao) {
                await verificarConquistas(trade.proposer_id, colecao.id);
                await verificarConquistas(trade.receiver_id, colecao.id);
                await desbloquearConquista(trade.proposer_id, "primeira_troca");
                await desbloquearConquista(trade.receiver_id, "primeira_troca");
            }

            registrarLog("colecionavel_troca_concluida", { tradeId: trade.id });

            res.json({ ok: true, status: "COMPLETED" });
        } catch (error) {
            registrarLog("colecionavel_troca_erro", {
                erro: error.message,
                tradeId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* Recusar proposta. */
    router.post("/trades/:id/decline", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const { trade, ok } = await podeAtualizarTrade(
                req.params.id, req.usuario.id, { proposer: true, receiver: true }
            );
            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (!ok) return res.status(403).json({ error: "Você não participa desta negociação." });

            if (["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED"].includes(trade.status)) {
                return res.status(400).json({ error: "Esta negociação já foi finalizada." });
            }

            await pg().query(
                `UPDATE sticker_trades SET status = 'DECLINED', updated_at = NOW()
                  WHERE id = $1`,
                [trade.id]
            );
            await registrarHistoricoTrade(trade.id, `[RECUSADA] Proposta recusada.`);

            registrarLog("colecionavel_troca_recusada", { tradeId: trade.id });

            res.json({ ok: true, status: "DECLINED" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Cancelar proposta (apenas o proponente). */
    router.post("/trades/:id/cancel", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_trades WHERE id = $1`,
                [req.params.id]
            );
            const trade = q.rows[0];
            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (trade.proposer_id !== req.usuario.id) {
                return res.status(403).json({ error: "Somente quem propôs pode cancelar." });
            }
            if (["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED"].includes(trade.status)) {
                return res.status(400).json({ error: "Esta negociação já foi finalizada." });
            }

            await pg().query(
                `UPDATE sticker_trades SET status = 'CANCELLED', updated_at = NOW()
                  WHERE id = $1`,
                [trade.id]
            );
            await registrarHistoricoTrade(trade.id, `[CANCELADA] Proposta cancelada pelo proponente.`);

            registrarLog("colecionavel_troca_cancelada", { tradeId: trade.id });

            res.json({ ok: true, status: "CANCELLED" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Contraproposta. */
    router.post("/trades/:id/counter", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();

            const { trade, ok } = await podeAtualizarTrade(
                req.params.id, req.usuario.id, { proposer: false, receiver: true }
            );
            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (!ok) return res.status(403).json({ error: "Somente o destinatário pode contrapor." });

            if (trade.status !== "PENDING" && trade.status !== "COUNTER_OFFER") {
                return res.status(400).json({ error: "Esta proposta não pode mais receber contraproposta." });
            }
            if (new Date(trade.expires_at) < new Date()) {
                return res.status(400).json({ error: "Esta proposta expirou." });
            }

            const minhas = await validarItemsTroca(req.body.recebo);   // novo: o que o receiver oferece
            if (minhas.error) return res.status(400).json({ error: minhas.error });
            const delas = await validarItemsTroca(req.body.ofereco);   // novo: o que pede do proposer
            if (delas.error) return res.status(400).json({ error: delas.error });

            let cashAmount = Math.max(0, Number(req.body.cashAmount) || 0);
            if (cashAmount > 0) {
                cashAmount = Math.round(cashAmount * 100) / 100;
                if (cashAmount > 5000) return res.status(400).json({ error: "Valor da diferença muito alto." });
            }
            const cashDirection = req.body.cashDirection || null;
            if (cashAmount > 0 && cashDirection !== "proposer_pays" && cashDirection !== "receiver_pays") {
                return res.status(400).json({ error: "Defina quem paga a diferença." });
            }

            for (const item of minhas.items) {
                const disp = await quantidadeDisponivel(req.usuario.id, item.cardId, trade.id);
                if (disp < 1) return res.status(400).json({ error: "Uma figurinha que você oferece não está disponível." });
            }
            for (const item of delas.items) {
                const possuo = await quantidadePossuida(trade.proposer_id, item.cardId);
                if (possuo < 1) return res.status(400).json({ error: "O proponente não possui uma figurinha pedida." });
            }

            /* Substitui os itens da negociação */
            await pg().query(`DELETE FROM sticker_trade_items WHERE trade_id = $1`, [trade.id]);

            for (const item of minhas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'receiver')`,
                    [trade.id, req.usuario.id, item.cardId]
                );
            }
            for (const item of delas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'proposer')`,
                    [trade.id, trade.proposer_id, item.cardId]
                );
            }

            const novoExpira = new Date(Date.now() + TRADE_TTL_HORAS * 3600 * 1000);

            await pg().query(
                `UPDATE sticker_trades
                    SET status = 'COUNTER_OFFER',
                        cash_direction = $2,
                        cash_amount = $3,
                        order_id = $4,
                        expires_at = $5,
                        updated_at = NOW()
                  WHERE id = $1`,
                [trade.id, cashDirection, cashAmount,
                 cashAmount > 0 ? gerarOrderId("COL-TRADE") : null,
                 novoExpira]
            );

            await registrarHistoricoTrade(trade.id,
                `[CONTRAPROPOSTA] ${req.usuario.nome} fez uma contraproposta.` +
                (cashAmount > 0 ? ` Diferença de R$ ${cashAmount.toFixed(2)}.` : ""));

            await registrarTransacaoDupla(
                trade.proposer_id,
                trade.receiver_id,
                "TROCA_CONTRAPROPOSTA",
                `Contraproposta ${cashAmount > 0 ? "com diferença de R$ " + cashAmount.toFixed(2) : "simples"}.`,
                cashAmount
            );

            registrarLog("colecionavel_troca_contraproposta", { tradeId: trade.id });

            res.json({ ok: true, status: "COUNTER_OFFER" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       PERFIL DO COLECIONADOR
    ========================================================= */

    router.get("/perfil", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const colecao = await colecaoAtiva();

            const statsQ = await pg().query(
                `SELECT
                     COALESCE(SUM(us.quantity),0)::int AS total,
                     COUNT(DISTINCT us.card_id)::int AS diferentes,
                     COALESCE(SUM(GREATEST(us.quantity - 1, 0)),0)::int AS repetidas,
                     COUNT(DISTINCT CASE WHEN c.rarity='RARA'     THEN us.card_id END)::int AS raras,
                     COUNT(DISTINCT CASE WHEN c.rarity='EPICA'    THEN us.card_id END)::int AS epicas,
                     COUNT(DISTINCT CASE WHEN c.rarity='LENDARIA' THEN us.card_id END)::int AS lendarias,
                     COUNT(DISTINCT CASE WHEN c.rarity='MITICA'   THEN us.card_id END)::int AS miticas
                  FROM user_stickers us
                  JOIN sticker_cards c ON c.id = us.card_id
                 WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2`,
                [req.usuario.id, colecao.id]
            );

            const st = statsQ.rows[0] || {};

            const tradesQ = await pg().query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS trocas,
                     COUNT(*) FILTER (WHERE status = 'COMPLETED' AND cash_amount > 0)::int AS trocas_dinheiro
                  FROM sticker_trades
                 WHERE (proposer_id = $1 OR receiver_id = $1)`,
                [req.usuario.id]
            );

            const vendasQ = await pg().query(
                `SELECT COUNT(*)::int AS vendas
                   FROM sticker_orders
                  WHERE seller_id = $1 AND status = 'paid'`,
                [req.usuario.id]
            );

            const comprasQ = await pg().query(
                `SELECT COUNT(*)::int AS compras
                   FROM sticker_orders
                  WHERE buyer_id = $1 AND status = 'paid'`,
                [req.usuario.id]
            );

            const conquistasQ = await pg().query(
                `SELECT a.slug, a.name, a.icon
                   FROM sticker_user_achievements ua
                   JOIN sticker_achievements a ON a.id = ua.achievement_id
                  WHERE ua.usuario_id = $1
                  ORDER BY a.id`,
                [req.usuario.id]
            );

            /* Ranking: posição entre todos os colecionadores
               (ordenado por quantidade de figurinhas diferentes). */
            const rankQ = await pg().query(
                `SELECT 1 + COUNT(*)::int AS posicao
                   FROM (
                       SELECT usuario_id, COUNT(DISTINCT card_id) AS dif
                         FROM user_stickers
                        WHERE quantity > 0
                        GROUP BY usuario_id
                   ) t
                  WHERE t.dif > $1`,
                [Number(st.diferentes || 0)]
            );

            const totalColecionadores = await pg().query(
                `SELECT COUNT(*)::int AS total
                   FROM (
                       SELECT usuario_id
                         FROM user_stickers
                        WHERE quantity > 0
                        GROUP BY usuario_id
                   ) t`
            );

            const completas = Number(st.diferentes) >= Number(colecao.total) ? 1 : 0;

            /* Todas as conquistas com status (para o perfil do frontend). */
            const todasQ = await pg().query(
                `SELECT * FROM sticker_achievements ORDER BY id`
            );
            const desbloqueadasSet = new Set(conquistasQ.rows.map(r => r.slug));

            res.json({
                ok: true,
                perfil: {
                    nome: req.usuario.nome,
                    email: req.usuario.email,
                    figurinhas: Number(st.total || 0),
                    diferentes: Number(st.diferentes || 0),
                    repetidas: Number(st.repetidas || 0),
                    raras: Number(st.raras || 0),
                    epicas: Number(st.epicas || 0),
                    lendarias: Number(st.lendarias || 0),
                    miticas: Number(st.miticas || 0),
                    colecoes_completas: completas,
                    album_completo: completas === 1,
                    trocas: Number(tradesQ.rows[0]?.trocas || 0),
                    trocas_dinheiro: Number(tradesQ.rows[0]?.trocas_dinheiro || 0),
                    vendas: Number(vendasQ.rows[0]?.vendas || 0),
                    compras: Number(comprasQ.rows[0]?.compras || 0),
                    ranking: Number(rankQ.rows[0]?.posicao || 1),
                    total_colecionadores: Number(totalColecionadores.rows[0]?.total || 0),
                    stats: {
                        total: Number(st.total || 0),
                        diferentes: Number(st.diferentes || 0),
                        repetidas: Number(st.repetidas || 0),
                        raras: Number(st.raras || 0)
                    },
                    conquistas: conquistasQ.rows
                },
                conquistas: todasQ.rows.map(a => ({
                    id: a.id,
                    slug: a.slug,
                    name: a.name,
                    description: a.description,
                    icon: a.icon,
                    desbloqueada: desbloqueadasSet.has(a.slug)
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Perfil público de outro usuário (para o marketplace/trocas). */
    router.get("/colecionador/:id", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const usuario = await usuarioPorId(req.params.id);
            if (!usuario) {
                return res.status(404).json({ error: "Usuário não encontrado." });
            }
            const colecao = await colecaoAtiva();

            const statsQ = await pg().query(
                `SELECT
                     COALESCE(SUM(us.quantity),0)::int AS total,
                     COUNT(DISTINCT us.card_id)::int AS diferentes
                  FROM user_stickers us
                  JOIN sticker_cards c ON c.id = us.card_id
                 WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2`,
                [usuario.id, colecao.id]
            );

            res.json({
                ok: true,
                perfil: {
                    id: usuario.id,
                    nome: usuario.nome,
                    figurinhas: Number(statsQ.rows[0]?.total || 0),
                    diferentes: Number(statsQ.rows[0]?.diferentes || 0)
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       CONQUISTAS
    ========================================================= */

    router.get("/conquistas", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const allQ = await pg().query(
                `SELECT * FROM sticker_achievements ORDER BY id`
            );
            const haveQ = await pg().query(
                `SELECT achievement_id, created_at
                   FROM sticker_user_achievements
                  WHERE usuario_id = $1`,
                [req.usuario.id]
            );
            const have = new Map(haveQ.rows.map(r => [r.achievement_id, r.created_at]));

            res.json({
                ok: true,
                conquistas: allQ.rows.map(a => ({
                    id: a.id,
                    slug: a.slug,
                    name: a.name,
                    description: a.description,
                    icon: a.icon,
                    desbloqueada: have.has(a.id),
                    desbloqueada_em: have.get(a.id) || null
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       HISTÓRICO
    ========================================================= */

    router.get("/historico", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_transactions
                  WHERE usuario_id = $1
                  ORDER BY created_at DESC
                  LIMIT 200`,
                [req.usuario.id]
            );
            res.json({
                ok: true,
                historico: q.rows
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       MODO TESTE (ALLOW_TEST_MODE)
       Simula a confirmação de pagamento SEM pagamento real.
       NUNCA ativo em produção.
    ========================================================= */

    router.post("/test/confirm/:orderId", obterAuthUsuario(), async (req, res) => {
        if (process.env.ALLOW_TEST_MODE !== "true") {
            return res.status(403).json({ error: "Modo de teste desativado." });
        }
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const orderId = req.params.orderId;

            const dono = await pg().query(
                `SELECT usuario_id FROM sticker_pack_purchases WHERE order_id = $1
                 UNION ALL
                 SELECT buyer_id AS usuario_id FROM sticker_orders WHERE order_id = $1
                 UNION ALL
                 SELECT proposer_id AS usuario_id FROM sticker_trades WHERE (order_id = $1 OR mp_order_id = $1) AND status = 'WAITING_PAYMENT'`,
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

            registrarLog("colecionavel_pagamento_testado", {
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
       ADMIN (protegido por authAdmin)
       Leitura/escrita administrativa do sistema de colecionáveis.
       Todas as rotas exigem o token JWT de administrador.
    ========================================================= */

    router.get("/admin/resumo", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();

            const cardsQ = await pg().query(
                `SELECT rarity, COUNT(*)::int AS qtd,
                        SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS ativos
                   FROM sticker_cards WHERE collection_id = $1 GROUP BY rarity`,
                [colecao.id]
            );

            const circulacaoQ = await pg().query(
                `SELECT COALESCE(SUM(quantity),0)::int AS total
                   FROM user_stickers`
            );

            const colecionadoresQ = await pg().query(
                `SELECT COUNT(*)::int AS total FROM
                   (SELECT DISTINCT usuario_id FROM user_stickers) s`
            );

            const compradoresQ = await pg().query(
                `SELECT COUNT(DISTINCT usuario_id)::int AS total
                   FROM sticker_pack_purchases`
            );

            const pacotesQ = await pg().query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'paid')::int AS vendas_pacotes,
                     COALESCE(SUM(price) FILTER (WHERE status = 'paid'),0)::numeric AS receita_pacotes
                  FROM sticker_pack_purchases
                 WHERE test = FALSE`
            );

            const mercadoQ = await pg().query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'paid')::int AS vendas_mercado,
                     COALESCE(SUM(total) FILTER (WHERE status = 'paid'),0)::numeric AS receita_mercado
                  FROM sticker_orders
                 WHERE test = FALSE`
            );

            const trocasQ = await pg().query(
                `SELECT
                     COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE status IN
                         ('PENDING','COUNTER_OFFER','ACCEPTED',
                          'WAITING_PAYMENT','PAID','PROCESSING'))::int AS em_andamento,
                     COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS concluidas
                   FROM sticker_trades`
            );

            const conquistasQ = await pg().query(
                `SELECT COUNT(*)::int AS desbloqueadas
                   FROM sticker_user_achievements`
            );

            const pacotesAtivosQ = await pg().query(
                `SELECT COUNT(*)::int AS ativos FROM sticker_packs
                  WHERE collection_id = $1 AND is_active = TRUE`,
                [colecao.id]
            );

            res.json({
                ok: true,
                colecao: {
                    name: colecao.name,
                    total: Number(colecao.total),
                    cards: cardsQ.rows.reduce((s, r) => s + Number(r.qtd), 0),
                    packs_ativos: Number(pacotesAtivosQ.rows[0].ativos)
                },
                cardsPorRaridade: cardsQ.rows,
                figurinhas_em_circulacao: Number(circulacaoQ.rows[0].total),
                colecionadores: Number(colecionadoresQ.rows[0].total),
                compradores: Number(compradoresQ.rows[0].total),
                pacotes: pacotesQ.rows[0],
                mercado: mercadoQ.rows[0],
                trocas: trocasQ.rows[0],
                conquistas: {
                    desbloqueadas: Number(conquistasQ.rows[0].desbloqueadas),
                    total: CONQUISTAS.length
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar colecionadores (admin). */
    router.get("/admin/colecionadores", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT u.id, u.nome, u.email, u.criado_em,
                        COALESCE(s.diferentes,0)::int AS diferentes,
                        COALESCE(s.total,0)::int AS total_figurinhas,
                        COALESCE(s.repetidas,0)::int AS repetidas,
                        COALESCE(a.conquistas,0)::int AS conquistas
                   FROM usuarios u
                   LEFT JOIN (
                       SELECT usuario_id,
                              COUNT(*) FILTER (WHERE quantity > 0)::int AS diferentes,
                              SUM(quantity)::int AS total,
                              SUM(quantity) - COUNT(*) FILTER (WHERE quantity > 0)::int AS repetidas
                         FROM user_stickers GROUP BY usuario_id
                   ) s ON s.usuario_id = u.id
                   LEFT JOIN (
                       SELECT usuario_id, COUNT(*)::int AS conquistas
                         FROM sticker_user_achievements GROUP BY usuario_id
                   ) a ON a.usuario_id = u.id
                  ORDER BY s.diferentes DESC NULLS LAST, u.nome
                  LIMIT 500`
            );
            res.json({ ok: true, colecionadores: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Álbum/progresso de um usuário específico (admin). */
    router.get("/admin/usuario/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const usuarioId = Number(req.params.id);
            if (!Number.isInteger(usuarioId)) {
                return res.status(400).json({ error: "ID de usuário inválido." });
            }
            const colecao = await colecaoAtiva();
            const usuario = await usuarioPorId(usuarioId);
            if (!usuario) {
                return res.status(404).json({ error: "Usuário não encontrado." });
            }

            const cardsQ = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.image_url,
                        COALESCE(us.quantity,0)::int AS quantidade
                   FROM sticker_cards c
                   LEFT JOIN user_stickers us
                          ON us.card_id = c.id AND us.usuario_id = $2
                  WHERE c.collection_id = $1
                  ORDER BY c.number`,
                [colecao.id, usuarioId]
            );
            const cards = cardsQ.rows.map(c => ({ ...c, number: Number(c.number) }));

            const conquistasQ = await pg().query(
                `SELECT a.slug, a.name, a.icon
                   FROM sticker_achievements a
                   JOIN sticker_user_achievements ua ON ua.achievement_id = a.id
                  WHERE ua.usuario_id = $1
                  ORDER BY a.id`,
                [usuarioId]
            );

            const diferentes = cards.filter(c => c.quantidade > 0).length;
            const total = Number(colecao.total);
            const repetidas = cards.reduce((s, c) => s + Math.max(0, c.quantidade - 1), 0);

            res.json({
                ok: true,
                usuario,
                progresso: {
                    diferentes,
                    total,
                    repetidas,
                    album_completo: diferentes >= total
                },
                cards,
                conquistas: conquistasQ.rows
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Estoque/disponibilidade por figurinha (admin). */
    router.get("/admin/estoque", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();
            const q = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.is_active,
                        COALESCE(s.total,0)::int AS em_circulacao,
                        COALESCE(l.listado,0)::int AS listado,
                        COALESCE(t.em_troca,0)::int AS em_troca
                   FROM sticker_cards c
                   LEFT JOIN (
                       SELECT card_id, SUM(quantity)::int AS total
                         FROM user_stickers GROUP BY card_id
                   ) s ON s.card_id = c.id
                   LEFT JOIN (
                       SELECT card_id, SUM(quantity)::int AS listado
                         FROM sticker_listings WHERE status = 'active'
                        GROUP BY card_id
                   ) l ON l.card_id = c.id
                   LEFT JOIN (
                       SELECT ti.card_id, COUNT(*)::int AS em_troca
                         FROM sticker_trade_items ti
                         JOIN sticker_trades t ON t.id = ti.trade_id
                        WHERE t.status IN
                             ('PENDING','COUNTER_OFFER','ACCEPTED',
                              'WAITING_PAYMENT','PAID','PROCESSING')
                        GROUP BY ti.card_id
                   ) t ON t.card_id = c.id
                  WHERE c.collection_id = $1
                  ORDER BY c.number`,
                [colecao.id]
            );
            const rows = q.rows.map(r => ({
                ...r,
                number: Number(r.number),
                em_circulacao: Number(r.em_circulacao),
                listado: Number(r.listado),
                em_troca: Number(r.em_troca),
                disponivel: Math.max(0,
                    Number(r.em_circulacao) - Number(r.listado) - Number(r.em_troca))
            }));
            res.json({ ok: true, cards: rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Compras de pacotes (admin). */
    router.get("/admin/compras", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT p.id, p.order_id, p.pack_id, pk.name AS pack_name,
                        p.price, p.quantity, p.status, p.test, p.created_at,
                        u.id AS usuario_id, u.nome, u.email
                   FROM sticker_pack_purchases p
                   JOIN usuarios u ON u.id = p.usuario_id
                   LEFT JOIN sticker_packs pk ON pk.id = p.pack_id
                  ORDER BY p.created_at DESC
                  LIMIT 500`
            );
            res.json({ ok: true, compras: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Vendas no marketplace (admin). */
    router.get("/admin/vendas", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT o.id, o.order_id, o.card_id, c.number, c.name AS card_name,
                        c.rarity, o.quantity, o.unit_price, o.total, o.fee,
                        o.net_seller, o.status, o.test, o.created_at,
                        cb.id AS buyer_id, cb.nome AS buyer_nome, cb.email AS buyer_email,
                        sv.id AS seller_id, sv.nome AS seller_nome, sv.email AS seller_email
                   FROM sticker_orders o
                   JOIN usuarios cb ON cb.id = o.buyer_id
                   JOIN usuarios sv ON sv.id = o.seller_id
                   JOIN sticker_cards c ON c.id = o.card_id
                  ORDER BY o.created_at DESC
                  LIMIT 500`
            );
            res.json({ ok: true, vendas: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Transações do sistema de colecionáveis (admin). */
    router.get("/admin/transacoes", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT t.*, u.nome, u.email
                   FROM sticker_transactions t
                   JOIN usuarios u ON u.id = t.usuario_id
                  ORDER BY t.created_at DESC
                  LIMIT 500`
            );
            res.json({ ok: true, transacoes: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Conquistas (admin). */
    router.get("/admin/conquistas", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT a.id, a.slug, a.name, a.description, a.icon,
                        COUNT(ua.id)::int AS desbloqueios
                   FROM sticker_achievements a
                   LEFT JOIN sticker_user_achievements ua ON ua.achievement_id = a.id
                  GROUP BY a.id
                  ORDER BY a.id`
            );
            res.json({ ok: true, conquistas: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Atualizar figurinha (admin): nome, número, raridade, arte,
       descrição e status ativo/inativo. */
    router.post("/admin/cards/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const cardId = Number(req.params.id);
            if (!Number.isInteger(cardId)) {
                return res.status(400).json({ error: "ID de figurinha inválido." });
            }
            const card = await cardPorId(cardId);
            if (!card) {
                return res.status(404).json({ error: "Figurinha não encontrada." });
            }

            const campos = [];
            const params = [cardId];

            if (req.body.name !== undefined) {
                const name = String(req.body.name).trim();
                if (!name || name.length > 200) {
                    return res.status(400).json({ error: "Nome inválido." });
                }
                params.push(name);
                campos.push(`name = $${params.length}`);
            }

            if (req.body.number !== undefined) {
                const number = Number(req.body.number);
                if (!Number.isInteger(number) || number < 1 || number > 9999) {
                    return res.status(400).json({ error: "Número inválido." });
                }
                const dup = await pg().query(
                    `SELECT COUNT(*)::int AS qtd FROM sticker_cards
                      WHERE collection_id = $1 AND number = $2 AND id <> $3`,
                    [card.collection_id, number, cardId]
                );
                if (Number(dup.rows[0].qtd) > 0) {
                    return res.status(400).json({ error: "Já existe outra figurinha com este número." });
                }
                params.push(number);
                campos.push(`number = $${params.length}`);
            }

            if (req.body.rarity !== undefined) {
                const rarity = String(req.body.rarity).trim().toUpperCase();
                if (!RARIDADES[rarity]) {
                    return res.status(400).json({ error: "Raridade inválida." });
                }
                params.push(rarity);
                campos.push(`rarity = $${params.length}`);
            }

            if (req.body.description !== undefined) {
                const description = req.body.description === null ? null : String(req.body.description);
                params.push(description);
                campos.push(`description = $${params.length}`);
            }

            if (req.body.image_url !== undefined) {
                const img = String(req.body.image_url || "").trim();
                if (img && !/^https?:\/\//i.test(img)) {
                    return res.status(400).json({ error: "URL de imagem inválida." });
                }
                params.push(img || null);
                campos.push(`image_url = $${params.length}`);
            }

            if (req.body.is_active !== undefined) {
                const ativo = req.body.is_active === true || req.body.is_active === "true";
                params.push(ativo);
                campos.push(`is_active = $${params.length}`);
            }

            if (!campos.length) {
                return res.status(400).json({ error: "Nenhum campo para atualizar." });
            }

            await pg().query(
                `UPDATE sticker_cards SET ${campos.join(", ")} WHERE id = $1`,
                params
            );

            registrarLog("colecionavel_admin_cards", {
                cardId,
                campos: campos.map(c => c.split(" ")[0])
            });

            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar pacotes (admin). */
    router.get("/admin/packs", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT p.*, c.name AS collection_name
                   FROM sticker_packs p
                   LEFT JOIN sticker_collections c ON c.id = p.collection_id
                  ORDER BY p.collection_id, p.price`
            );
            res.json({ ok: true, packs: q.rows.map(p => ({
                ...p,
                price: Number(p.price),
                sticker_quantity: Number(p.sticker_quantity),
                is_active: !!p.is_active
            })) });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar coleções (admin). */
    router.get("/admin/colecoes", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT c.*,
                        (SELECT COUNT(*) FROM sticker_cards WHERE collection_id = c.id) AS cards,
                        (SELECT COUNT(*) FROM sticker_packs WHERE collection_id = c.id) AS packs
                   FROM sticker_collections c
                  ORDER BY c.id`
            );
            res.json({ ok: true, colecoes: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar cards (admin). */
    router.get("/admin/cards", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_cards ORDER BY number LIMIT 500`
            );
            res.json({ ok: true, cards: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar negociações (admin, moderação). */
    router.get("/admin/trades", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT t.*, pu.nome AS proposer_nome, ru.nome AS receiver_nome
                   FROM sticker_trades t
                   JOIN usuarios pu ON pu.id = t.proposer_id
                   JOIN usuarios ru ON ru.id = t.receiver_id
                  ORDER BY t.updated_at DESC
                  LIMIT 200`
            );
            res.json({ ok: true, trades: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Atualizar pacote (admin): preço, quantidade, nome, descrição e
       status ativo/inativo. */
    router.post("/admin/packs/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const packId = Number(req.params.id);
            if (!Number.isInteger(packId)) {
                return res.status(400).json({ error: "ID de pacote inválido." });
            }

            const campos = [];
            const params = [packId];

            if (req.body.price !== undefined) {
                const preco = Number(req.body.price);
                if (!isFinite(preco) || preco <= 0) {
                    return res.status(400).json({ error: "Preço inválido." });
                }
                params.push(Math.round(preco * 100) / 100);
                campos.push(`price = $${params.length}`);
            }

            if (req.body.sticker_quantity !== undefined) {
                const qtd = Number(req.body.sticker_quantity);
                if (!Number.isInteger(qtd) || qtd < 1 || qtd > 100) {
                    return res.status(400).json({ error: "Quantidade inválida." });
                }
                params.push(qtd);
                campos.push(`sticker_quantity = $${params.length}`);
            }

            if (req.body.name !== undefined) {
                const name = String(req.body.name).trim();
                if (!name || name.length > 100) {
                    return res.status(400).json({ error: "Nome inválido." });
                }
                params.push(name);
                campos.push(`name = $${params.length}`);
            }

            if (req.body.description !== undefined) {
                const description = req.body.description === null ? null : String(req.body.description);
                params.push(description);
                campos.push(`description = $${params.length}`);
            }

            if (req.body.is_active !== undefined) {
                const ativo = req.body.is_active === true || req.body.is_active === "true";
                params.push(ativo);
                campos.push(`is_active = $${params.length}`);
            }

            if (!campos.length) {
                return res.status(400).json({ error: "Nenhum campo para atualizar." });
            }

            const r = await pg().query(
                `UPDATE sticker_packs SET ${campos.join(", ")} WHERE id = $1`,
                params
            );
            if (!r.rowCount) {
                return res.status(404).json({ error: "Pacote não encontrado." });
            }

            registrarLog("colecionavel_admin_packs", {
                packId,
                campos: campos.map(c => c.split(" ")[0])
            });

            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return {
        router,
        migrar,
        processarPagamento,
        sortearRaridade,
        sortearCards,
        entregarPacoteParaUsuario
    };
};
