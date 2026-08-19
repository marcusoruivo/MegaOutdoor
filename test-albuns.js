/* =========================================================
   TESTE DE REGRESSÃO — ÁLBUNS: CICLO DE VIDA, COMPLETUDE,
   RECOMPENSA, VENDAS DE ÁLBUM COMPLETO E OFERTAS
   =========================================================
   A) ciclo de vida no /info (theme, starts_at, ends_at, status, serverTime)
   B) encerramento automático por data + bloqueio de pacotes
   C) detecção de álbum completo + recompensa única (idempotente)
   D) vender álbum completo (regras: só completo, 1 anúncio por usuário)
   E) compra direta -> Order MP -> confirmação -> transferência
   F) dupla venda/impossibilidade após reserva e após pagamento
   G) ofertas: criar, duplicada, listar, aceitar, pagar, concluir
   H) expiração de oferta/pedido devolve o anúncio ao mercado
   I) álbum anterior (encerrado) continua podendo ser vendido
   J) endpoints admin de álbuns (colecoes, albuns, vendas, ofertas)
   K) comissão 10% e valores líquidos corretos
   L) vídeos das figurinhas especiais existem

   Usa pg-mem + mocks realistas do Mercado Pago.
   NÃO faz commit/push/deploy.
========================================================= */

process.env.DATABASE_URL = "postgres://memoria";
process.env.ALLOW_TEST_MODE = "true";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "senha123";
process.env.MERCADOPAGO_WEBHOOK_SECRET = "segredo-webhook-teste";
process.env.PORT = process.env.PORT || "3214";

const path = require("path");
const fs = require("fs");

const tmpDir = path.join(process.env.TEMP || "/tmp", "opencode", "albuns-" + Date.now());
fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
fs.mkdirSync(path.join(tmpDir, "uploads"), { recursive: true });
process.env.DATA_DIR = path.join(tmpDir, "data");
process.env.UPLOAD_DIR = path.join(tmpDir, "uploads");
fs.writeFileSync(path.join(process.env.DATA_DIR, "spaces.json"), "{}");

const PORT = process.env.PORT || "3214";
const BASE = "http://localhost:" + PORT;

/* ---- Mock realista da API Orders do Mercado Pago ---- */
let seq = 1;
const ordersCriadas = new Map();
const pedidos = [];
let falharProximaCriacao = false;

const fetchOriginal = global.fetch;
global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes("api.mercadopago.com")) {
        return fetchOriginal(url, options);
    }
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const idempotencyKey = (options.headers || {})["X-Idempotency-Key"] || "";

    if (u.endsWith("/v1/orders") && method === "POST") {
        if (falharProximaCriacao) {
            falharProximaCriacao = false;
            pedidos.push({ body, idempotencyKey, falhou: true });
            return {
                ok: false,
                status: 400,
                json: async () => ({
                    status: 400,
                    error: "unsupported_properties",
                    message: "Properties not supported",
                    cause: []
                })
            };
        }
        const id = "ORDA" + String(seq++).padStart(6, "0");
        const order = {
            id,
            status: "open",
            total_amount: body && body.total_amount ? String(body.total_amount) : "1.00",
            external_reference: body.external_reference,
            transactions: {
                payments: [{
                    id: "pay-" + id,
                    status: "pending",
                    status_detail: "pending_waiting_transfer",
                    payment_method: {
                        id: "pix",
                        type: "bank_transfer",
                        qr_code_base64: "bW9jaw==",
                        qr_code: "000201mock",
                        ticket_url: "https://mock.local/ticket/" + id
                    }
                }]
            }
        };
        ordersCriadas.set(id, order);
        pedidos.push({ body, idempotencyKey, orderId: id, falhou: false });
        return { ok: true, status: 201, json: async () => order };
    }

    const m = u.match(/\/v1\/orders\/([^/?#]+)/);
    if (m && method === "GET") {
        const id = m[1];
        const order = ordersCriadas.get(id) || {
            id,
            status: "paid",
            total_amount: "1.00",
            external_reference: "mock",
            transactions: { payments: [{ id: "pay-" + id, status: "paid", status_detail: "accredited" }] }
        };
        return {
            ok: true,
            status: 200,
            json: async () => ({
                ...order,
                status: order.status === "open" ? "paid" : order.status,
                total_amount: order.total_amount || "1.00"
            })
        };
    }

    return { ok: false, status: 404, json: async () => ({ message: "Rota MP não encontrada " + u }) };
};

/* ---- pg-mem antes do require do server ---- */
const { newDb } = require("pg-mem");
const dbmem = newDb();
const adapter = dbmem.adapters.createPg();
const pgReal = require("pg");
pgReal.Pool = adapter.Pool;
pgReal.Client = adapter.Client;
if (adapter.types) {
    pgReal.types = adapter.types;
}

require(path.join(__dirname, "server.js"));

/* ---- helpers de teste ---- */
const log = [];
function t(nome, cond, extra) {
    log.push((cond ? "PASS" : "FAIL") + " | " + nome + (extra ? " | " + extra : ""));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function reqJson(url, opts) {
    const r = await fetch(url, opts);
    const texto = await r.text();
    let body = null;
    try { body = JSON.parse(texto); } catch (e) { body = { raw: texto.slice(0, 160) }; }
    return { r, body };
}
const json = (method, token, payload) => ({
    method,
    headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { "Authorization": "Bearer " + token } : {}
    ),
    body: payload === undefined ? undefined : JSON.stringify(payload)
});

/* Acesso direto ao banco pg-mem (mesmo adapter do server). */
const directPool = new (require("pg").Pool)({ connectionString: "postgres://memoria" });

const cpfValido = "12345678909";

/* Watchdog: se algum passo travar, imprime a localização e sai. */
let passoAtual = "boot";
const watchdog = setTimeout(() => {
    console.error("[albuns-test] TRAVOU em: " + passoAtual);
    process.exit(2);
}, 60000);
watchdog.unref && watchdog.unref();

async function registrarUsuario(nome, email) {
    const r = await reqJson(BASE + "/api/auth/registrar",
        json("POST", null, { nome, email, senha: "senha-teste-123" }));
    const body = r.body || {};
    return {
        token: body.token || "",
        id: body.usuario && body.usuario.id
    };
}

async function concederAlbumCompleto(adminTok, usuarioId) {
    const cards = await reqJson(BASE + "/api/colecionaveis/admin/cards", json("GET", adminTok));
    const ids = (cards.body.cards || []).map(c => c.id);
    const r = await reqJson(BASE + "/api/admin/concessoes/figurinhas",
        json("POST", adminTok, {
            usuarioId,
            cardIds: ids,
            motivo: "Teste de álbuns completos"
        }));
    return { ok: r.r.status === 200, total: ids.length, body: r.body };
}

async function main() {
    await sleep(4500);
    const passo = (m) => {
        console.log("[albuns-test] " + m);
        passoAtual = m;
        watchdog.refresh ? watchdog.refresh() : null;
    };

    const login = await reqJson(BASE + "/api/admin/login",
        json("POST", null, { usuario: "admin", senha: "senha123" }));
    const adminTok = (login.body && login.body.token) || "";
    t("login admin", !!adminTok);
    passo("admin logado");

    const uniq = Date.now();
    const usrA = await registrarUsuario("Vendedor A", "vendedorA-" + uniq + "@teste.com");
    const usrB = await registrarUsuario("Comprador B", "compradorB-" + uniq + "@teste.com");
    const usrC = await registrarUsuario("Comprador C", "compradorC-" + uniq + "@teste.com");
    const tokA = usrA.token, tokB = usrB.token, tokC = usrC.token;
    const idA = usrA.id, idB = usrB.id, idC = usrC.id;
    t("registro usuários", !!tokA && !!tokB && !!tokC && !!idA && !!idB && !!idC,
        "idA=" + idA + " idB=" + idB + " idC=" + idC);

    /* A) ciclo de vida no /info */
    const info = await reqJson(BASE + "/api/colecionaveis/info", json("GET", null));
    passo("info carregado");
    const col = info.body.colecao;
    t("A) /info retorna coleção", !!col);
    t("A) status ATIVO", col && col.status === "ATIVO", "status=" + (col && col.status));
    t("A) tema presente", !!(col && col.theme), "theme=" + (col && col.theme));
    t("A) starts_at presente", !!(col && col.starts_at));
    t("A) ends_at presente", !!(col && col.ends_at));
    t("A) serverTime presente", !!info.body.serverTime, "st=" + info.body.serverTime);
    t("A) encerrado=false", info.body.encerrado === false);
    t("A) recompensa configurada (defaults)", col && col.reward_type && col.reward_enabled !== undefined,
        "reward_type=" + (col && col.reward_type));
    const packs = info.body.packs || [];
    const colecaoId = col.id;

    /* C) completar o álbum de A por concessão administrativa */
    const concessao = await concederAlbumCompleto(adminTok, idA);
    passo("concessão A ok=" + concessao.ok + " total=" + concessao.total + " err=" + (concessao.body && concessao.body.error));
    t("C) concessão das " + concessao.total + " figurinhas", concessao.ok,
        "err=" + (concessao.body && concessao.body.error));

    const meuA1 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", tokA));
    t("C) A completo", meuA1.body.completo === true);
    t("C) completion registrada", !!meuA1.body.completion,
        JSON.stringify(meuA1.body.completion));
    t("C) reward_status gravado", !!meuA1.body.completion &&
        ["CONCEDIDA", "NAO_POSSIVEL"].includes(meuA1.body.completion.reward_status),
        "rs=" + (meuA1.body.completion && meuA1.body.completion.reward_status));

    /* C) recompensa idempotente (segunda leitura não duplica) */
    const meuA2 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", tokA));
    t("C) completion única (idempotente)",
        meuA1.body.completion && meuA2.body.completion &&
        meuA1.body.completion.completed_at === meuA2.body.completion.completed_at,
        "t1=" + (meuA1.body.completion && meuA1.body.completion.completed_at) +
        " t2=" + (meuA2.body.completion && meuA2.body.completion.completed_at));
    const histA = await reqJson(BASE + "/api/colecionaveis/historico", json("GET", tokA));
    const qtdCompletos = (histA.body.historico || histA.body.transacoes || histA.body.itens || []).filter(
        x => x.tipo === "ALBUM_COMPLETO").length;
    t("C) apenas 1 transação ALBUM_COMPLETO", qtdCompletos === 1, "qtd=" + qtdCompletos);

    /* D) vender álbum completo */
    const vender = await reqJson(BASE + "/api/colecionaveis/albuns/" + colecaoId + "/vender",
        json("POST", tokA, { price: 200, accepts_offers: true }));
    t("D) venda criada", vender.r.status === 201, "status=" + vender.r.status + " body=" + JSON.stringify(vender.body));
    const listingId = vender.body && vender.body.listingId;
    t("D) listingId presente", !!listingId);

    const vender2 = await reqJson(BASE + "/api/colecionaveis/albuns/" + colecaoId + "/vender",
        json("POST", tokA, { price: 150, accepts_offers: false }));
    t("D) 2º anúncio do mesmo usuário bloqueado", vender2.r.status === 409,
        "status=" + vender2.r.status);

    const venderB = await reqJson(BASE + "/api/colecionaveis/albuns/" + colecaoId + "/vender",
        json("POST", tokB, { price: 90, accepts_offers: false }));
    t("D) usuário incompleto bloqueado", venderB.r.status === 403,
        "status=" + venderB.r.status + " err=" + (venderB.body && venderB.body.error));

    const albunsB = await reqJson(BASE + "/api/colecionaveis/albuns", json("GET", tokB));
    t("D) mercado lista 1 anúncio", (albunsB.body.anuncios || []).length === 1,
        "body=" + JSON.stringify(albunsB.body));
    const an = (albunsB.body.anuncios || [])[0];
    t("D) anúncio com nome da coleção", !!(an && an.colecaoNome), "nome=" + (an && an.colecaoNome));
    t("D) anúncio com aceita_ofertas", an && an.aceitaOfertas === true);
    t("D) minhasOfertasRecebidas=0", albunsB.body.minhasOfertasRecebidas === 0);

    /* E) compra direta -> Order MP -> confirmação -> transferência */
    const compra = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingId + "/comprar",
        json("POST", tokB, { paymentMethod: "pix", cpfCnpj: cpfValido }));
    t("E) compra direta 200", compra.r.status === 200,
        "status=" + compra.r.status + " err=" + (compra.body && compra.body.error));
    t("E) tipo album", compra.body && compra.body.tipo === "album");
    t("E) externalReference presente", !!compra.body.externalReference);
    t("E) QR/copia-e-cola", compra.body.qrCodeBase64 === "bW9jaw==" && compra.body.payload === "000201mock");
    const refDir = compra.body.externalReference;

    /* K) comissão 10% sobre R$ 200 */
    t("K) fee 10% (20)", compra.body.fee === 20, "fee=" + compra.body.fee);
    t("K) net seller 180", compra.body.netSeller === 180, "net=" + compra.body.netSeller);

    const detRes = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingId,
        json("GET", tokB));
    t("E) anúncio em negociação",
        detRes.body && detRes.body.anuncio && detRes.body.anuncio.status === "negotiation",
        "body=" + JSON.stringify(detRes.body));

    /* F) dupla compra bloqueada */
    const compra2 = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingId + "/comprar",
        json("POST", tokC, { paymentMethod: "pix", cpfCnpj: cpfValido }));
    t("F) compra durante negociação bloqueada", compra2.r.status === 409,
        "status=" + compra2.r.status);

    /* E) confirmar pagamento (mesmo caminho do webhook) */
    const conf = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + refDir,
        json("POST", tokB, {}));
    t("E) confirmação OK", conf.r.status === 200, "status=" + conf.r.status + " body=" + JSON.stringify(conf.body));
    t("E) confirmação tipo album", conf.body && conf.body.tipo === "album");

    const meuB = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", tokB));
    t("E) B completo após transferência", meuB.body.completo === true);

    const meuA3 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", tokA));
    t("E) A deixou de ter álbum completo", meuA3.body.completo === false);

    const detVend = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingId,
        json("GET", tokB));
    t("E) anúncio vendido", detVend.body.anuncio.status === "sold",
        "status=" + (detVend.body.anuncio && detVend.body.anuncio.status));

    /* F) confirmação duplicada rejeitada e sem segunda transferência */
    const conf2 = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + refDir,
        json("POST", tokB, {}));
    t("F) confirmação duplicada rejeitada", conf2.r.status === 400,
        "status=" + conf2.r.status);
    const meuB2 = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", tokB));
    const totalB = (meuB2.body.cards || []).reduce((s, c) => s + Number(c.quantidade || 0), 0);
    t("F) B com exatamente 1 de cada (100)", totalB === 100, "total=" + totalB);

    /* G) OFERTAS — novo vendedor D */
    const usrD = await registrarUsuario("Vendedor D", "vendedorD-" + uniq + "@teste.com");
    const tokD = usrD.token, idD = usrD.id;
    const concessaoD = await concederAlbumCompleto(adminTok, idD);
    t("G) concessão para D", concessaoD.ok);
    const venderD = await reqJson(BASE + "/api/colecionaveis/albuns/" + colecaoId + "/vender",
        json("POST", tokD, { price: 150, accepts_offers: true }));
    const listingD = venderD.body && venderD.body.listingId;
    t("G) D vendeu álbum", venderD.r.status === 201 && !!listingD);

    const of1 = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingD + "/ofertas",
        json("POST", tokC, { amount: 120, message: "Posso pagar hoje" }));
    t("G) oferta de C criada", of1.r.status === 201, "status=" + of1.r.status + " body=" + JSON.stringify(of1.body));
    const ofertaId = of1.body && of1.body.ofertaId;

    const of2 = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingD + "/ofertas",
        json("POST", tokC, { amount: 130 }));
    t("G) oferta duplicada pendente bloqueada", of2.r.status === 409, "status=" + of2.r.status);

    const listaOfertas = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingD + "/ofertas",
        json("GET", tokD));
    t("G) D vê 1 oferta pendente",
        (listaOfertas.body.ofertas || []).length === 1 &&
        listaOfertas.body.ofertas[0].status === "PENDENTE");

    const aceitar = await reqJson(BASE + "/api/colecionaveis/albuns/ofertas/" + ofertaId + "/aceitar",
        json("POST", tokD, {}));
    t("G) oferta aceita", aceitar.r.status === 200, "status=" + aceitar.r.status + " body=" + JSON.stringify(aceitar.body));
    t("K) fee da oferta (10% de 120)", aceitar.body.fee === 12, "fee=" + aceitar.body.fee);
    t("K) net da oferta", aceitar.body.netSeller === 108, "net=" + aceitar.body.netSeller);
    const refOferta = aceitar.body.orderId;

    const minhasC = await reqJson(BASE + "/api/colecionaveis/albuns/ofertas/minhas", json("GET", tokC));
    t("G) C vê oferta aceita",
        (minhasC.body.feitas || []).some(o => o.id === ofertaId && o.status === "ACEITA"));

    /* G) pagamento da oferta */
    const pagOferta = await reqJson(BASE + "/api/colecionaveis/albuns/ofertas/" + ofertaId + "/pagar",
        json("POST", tokC, { paymentMethod: "pix", cpfCnpj: cpfValido }));
    t("G) pagamento da oferta 200", pagOferta.r.status === 200,
        "status=" + pagOferta.r.status + " err=" + (pagOferta.body && pagOferta.body.error));
    t("G) tipo albumOferta", pagOferta.body && pagOferta.body.tipo === "albumOferta");
    t("G) externalReference = pedido da aceitação",
        pagOferta.body.externalReference === refOferta,
        "ext=" + pagOferta.body.externalReference + " esperado=" + refOferta);

    const confOferta = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + refOferta,
        json("POST", tokC, {}));
    t("G) confirmação da oferta OK", confOferta.r.status === 200,
        "status=" + confOferta.r.status + " body=" + JSON.stringify(confOferta.body));

    const meuC = await reqJson(BASE + "/api/colecionaveis/meu-album", json("GET", tokC));
    t("G) C completo após compra via oferta", meuC.body.completo === true);

    const detD = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingD, json("GET", tokD));
    t("G) anúncio de D vendido", detD.body.anuncio.status === "sold");

    const minhasC2 = await reqJson(BASE + "/api/colecionaveis/albuns/ofertas/minhas", json("GET", tokC));
    t("G) oferta concluída",
        (minhasC2.body.feitas || []).some(o => o.id === ofertaId && o.status === "CONCLUIDA"));

    /* H) expiração de negociação devolve o anúncio ao mercado */
    const usrE = await registrarUsuario("Vendedor E", "vendedorE-" + uniq + "@teste.com");
    const tokE = usrE.token, idE = usrE.id;
    await concederAlbumCompleto(adminTok, idE);
    const venderE = await reqJson(BASE + "/api/colecionaveis/albuns/" + colecaoId + "/vender",
        json("POST", tokE, { price: 100, accepts_offers: true }));
    const listingE = venderE.body && venderE.body.listingId;
    const ofE = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingE + "/ofertas",
        json("POST", tokB, { amount: 90 }));
    const ofertaE = ofE.body && ofE.body.ofertaId;
    await reqJson(BASE + "/api/colecionaveis/albuns/ofertas/" + ofertaE + "/aceitar",
        json("POST", tokE, {}));

    /* força a expiração no banco (pedido + oferta vencidos) */
    await directPool.query(
        "UPDATE album_orders SET expires_at = NOW() - INTERVAL '1 hour' WHERE offer_id = $1",
        [ofertaE]);
    await directPool.query(
        "UPDATE album_offers SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
        [ofertaE]);

    const albunsH = await reqJson(BASE + "/api/colecionaveis/albuns", json("GET", tokB));
    const anH = (albunsH.body.anuncios || []).find(a => a.id === listingE);
    t("H) anúncio de E voltou a ficar ativo", anH && anH.meu === false && anH !== undefined,
        "status=" + (anH && JSON.stringify(anH)));

    const minhasE = await reqJson(BASE + "/api/colecionaveis/albuns/ofertas/minhas", json("GET", tokE));
    t("H) oferta de E expirada",
        (minhasE.body.recebidas || []).some(o => o.id === ofertaE && o.status === "EXPIRADA"));

    /* I) álbum anterior (encerrado) continua sendo vendido */
    const usrF = await registrarUsuario("Comprador F", "compradorF-" + uniq + "@teste.com");
    const tokF = usrF.token, idF = usrF.id;
    t("registro de F", !!tokF && !!idF, "idF=" + idF);

    /* B) encerramento automático por data via admin */
    const colNova = await reqJson(BASE + "/api/colecionaveis/admin/albuns/" + colecaoId,
        json("POST", adminTok, { ends_at: new Date(Date.now() - 3600 * 1000).toISOString() }));
    t("B) admin atualizou ends_at para o passado", colNova.r.status === 200,
        "status=" + colNova.r.status + " body=" + JSON.stringify(colNova.body));

    const info2 = await reqJson(BASE + "/api/colecionaveis/info", json("GET", null));
    t("B) /info detecta encerrado", info2.body.encerrado === true &&
        info2.body.colecao && info2.body.colecao.status === "ENCERRADO",
        JSON.stringify(info2.body.colecao));

    const packOld = packs[0];
    const packBloq = await reqJson(BASE + "/api/colecionaveis/packs/" + packOld.id + "/checkout",
        json("POST", tokB, { paymentMethod: "pix", cpfCnpj: cpfValido }));
    t("B) pacote do álbum encerrado bloqueado", packBloq.r.status === 409,
        "status=" + packBloq.r.status + " err=" + (packBloq.body && packBloq.body.error));

    /* I) ainda dá para comprar o álbum antigo (anúncio ativo de E) */
    const compraE = await reqJson(BASE + "/api/colecionaveis/albuns/vendas/" + listingE + "/comprar",
        json("POST", tokF, { paymentMethod: "pix", cpfCnpj: cpfValido }));
    t("I) compra de álbum encerrado permitida", compraE.r.status === 200,
        "status=" + compraE.r.status + " err=" + (compraE.body && compraE.body.error));
    const confE = await reqJson(BASE + "/api/colecionaveis/test/confirm/" + compraE.body.externalReference,
        json("POST", tokF, {}));
    t("I) confirmação da compra do álbum antigo", confE.r.status === 200,
        "status=" + confE.r.status + " body=" + JSON.stringify(confE.body));

    /* J) endpoints admin */
    const admVendas = await reqJson(BASE + "/api/colecionaveis/admin/albuns/vendas", json("GET", adminTok));
    t("J) admin/albuns/vendas", admVendas.r.status === 200 && Array.isArray(admVendas.body.vendas),
        "status=" + admVendas.r.status);

    const admOfertas = await reqJson(BASE + "/api/colecionaveis/admin/albuns/" + colecaoId + "/ofertas",
        json("GET", adminTok));
    t("J) admin/albuns/:id/ofertas", admOfertas.r.status === 200 && Array.isArray(admVendas.body.vendas),
        "status=" + admOfertas.r.status);

    const admAlbuns = await reqJson(BASE + "/api/colecionaveis/admin/albuns/" + colecaoId,
        json("POST", adminTok, { theme: "Seres do Brasil" }));
    t("J) admin atualiza tema", admAlbuns.r.status === 200,
        "status=" + admAlbuns.r.status + " body=" + JSON.stringify(admAlbuns.body));
    const adminCols = await reqJson(BASE + "/api/colecionaveis/admin/colecoes", json("GET", adminTok));
    const colAt = (adminCols.body.colecoes || []).find(c => c.id === colecaoId);
    t("J) tema atualizado", colAt && colAt.theme === "Seres do Brasil",
        "theme=" + (colAt && colAt.theme));

    /* L) vídeos especiais existem */
    t("L) video especial.mp4 existe",
        fs.existsSync(path.join(__dirname, "public", "videos", "video especial.mp4")));
    t("L) video ouro.mp4 existe",
        fs.existsSync(path.join(__dirname, "public", "videos", "videoouro.mp4")));

    /* encerramento */
    const passou = log.filter(l => l.indexOf("PASS") === 0).length;
    const falhou = log.filter(l => l.indexOf("FAIL") === 0).length;
    console.log("\n==== RESULTADO TESTE ÁLBUNS ====");
    console.log("PASS: " + passou + " | FAIL: " + falhou);
    console.log(log.join("\n"));
    console.log("=================================");
    if (falhou > 0) process.exit(1);
    else process.exit(0);
}

main().catch(e => {
    console.error("ERRO FATAL no teste de álbuns:", e);
    process.exitCode = 1;
});