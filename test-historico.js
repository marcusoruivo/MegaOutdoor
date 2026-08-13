/* =========================================================
   TESTE DE HOMOLOGAÇÃO — CICLO COMPLETO DO HISTÓRICO
   Compra -> Venda (transferência) -> Extrato individual

   Requer o servidor rodando com:
     - ALLOW_TEST_MODE=true  (nunca em produção)
     - DATABASE_URL definido (PostgreSQL conectado)

   Uso:
     node test-historico.js                -> http://localhost:3000
     $env:TEST_BASE_URL="https://..."; node test-historico.js
========================================================= */

require("dotenv").config();

const BASE =
    process.env.TEST_BASE_URL ||
    "http://localhost:3000";

const log = [];

function t(nome, cond, extra) {
    log.push(
        (cond ? "PASS" : "FAIL") +
        " | " + nome +
        (extra ? " | " + extra : "")
    );
}

async function reqJson(url, opts) {
    const r = await fetch(url, opts);
    const texto = await r.text();
    let body = null;
    try {
        body = JSON.parse(texto);
    } catch (e) {
        body = { raw: texto };
    }
    return { r, body };
}

const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

(async () => {

    const rodada = Date.now().toString(36);

    const s1 =
        900000 + Math.floor(Math.random() * 99999);

    const s2 = s1 + 1;

    const donaEmail =
        "dona." + rodada + "@teste.com";

    const compradorEmail =
        "comprador." + rodada + "@teste.com";

    /* -------------------------------------------------
       1) COMPRA (modo teste) — 2 espaços
    ------------------------------------------------- */

    let { r, body } = await reqJson(
        BASE + "/api/test/reserve",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                spaces: [s1, s2],
                name: "Dona de Teste",
                email: donaEmail
            })
        }
    );

    t(
        "1. compra criada (test/reserve)",
        r.ok && !!body.orderToken && !!body.accessCode,
        "spaces=" + JSON.stringify(body.spaces)
    );

    const tokenDona = body.orderToken;
    const accessDona = body.accessCode;

    /* -------------------------------------------------
       2) PUBLICAR espaço s1 (upload com imagem válida)
    ------------------------------------------------- */

    const fd = new FormData();
    fd.append("orderToken", tokenDona);
    fd.append(
        "fotos",
        new Blob([PNG_1x1], { type: "image/png" }),
        "teste.png"
    );

    ({ r, body } = await reqJson(
        BASE + "/api/upload/" + s1,
        { method: "POST", body: fd }
    ));

    t(
        "2. espaço publicado",
        r.ok,
        r.status + " " + JSON.stringify(body).slice(0, 100)
    );

    /* -------------------------------------------------
       3) OFERTA do comprador no espaço s1
    ------------------------------------------------- */

    ({ r, body } = await reqJson(
        BASE + "/api/offers",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                spaceId: s1,
                name: "Comprador de Teste",
                email: compradorEmail,
                value: 100
            })
        }
    ));

    t(
        "3. oferta criada",
        r.ok && !!body.offerId,
        "offerId=" + (body.offerId || "SEM")
    );

    const offerId = body.offerId;

    /* -------------------------------------------------
       4) CONFIRMAR OFERTA (pagamento simulado)
    ------------------------------------------------- */

    ({ r, body } = await reqJson(
        BASE + "/api/test/confirm-offer",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offerId })
        }
    ));

    t(
        "4. transferência confirmada",
        r.ok && body.ok === true && !!body.newOwnerToken,
        JSON.stringify(body).slice(0, 120)
    );

    const tokenNovoDono = body.newOwnerToken;

    /* -------------------------------------------------
       5) EXTRATO DA DONA ORIGINAL
          deve ter: compra (2 espaços, R$ 2)
                    venda (1 espaço, R$ 100, comissão R$ 10)
    ------------------------------------------------- */

    ({ r, body } = await reqJson(
        BASE + "/api/historico",
        { headers: { "x-owner-tokens": tokenDona } }
    ));

    t(
        "5a. extrato da dona carregou",
        r.ok && body.ok === true,
        "total=" + (body.total ?? "SEM")
    );

    const vendaDona = (body.transacoes || [])
        .find(x => x.tipo === "venda");

    const compraDona = (body.transacoes || [])
        .find(x =>
            x.tipo === "compra" &&
            (x.espacos || []).includes(s2)
        );

    t(
        "5b. dona tem a venda com valor/comissão certos",
        !!vendaDona &&
            vendaDona.valorTotal === 100 &&
            vendaDona.comissao === 10 &&
            vendaDona.status === "pago",
        "valor=" + (vendaDona && vendaDona.valorTotal) +
        " comissao=" + (vendaDona && vendaDona.comissao)
    );

    t(
        "5c. dona tem a compra de teste (R$ 2, 2 espaços)",
        !!compraDona &&
            compraDona.valorTotal === 2 &&
            compraDona.quantidade === 2,
        "valor=" + (compraDona && compraDona.valorTotal)
    );

    t(
        "5d. totais do extrato da dona",
        body.gastoTotal === 2 &&
            body.recebidoTotal === 90 &&
            body.comprados === 2 &&
            body.vendidos === 1,
        "gasto=" + body.gastoTotal +
        " recebido=" + body.recebidoTotal +
        " comprados=" + body.comprados +
        " vendidos=" + body.vendidos
    );

    /* -------------------------------------------------
       6) EXTRATO DO NOVO DONO
          deve ter: compra por transferência (R$ 110)
    ------------------------------------------------- */

    ({ r, body } = await reqJson(
        BASE + "/api/historico",
        { headers: { "x-owner-tokens": tokenNovoDono } }
    ));

    const compraNovo = (body.transacoes || [])
        .find(x =>
            x.tipo === "compra" &&
            (x.espacos || []).includes(s1)
        );

    t(
        "6. novo dono tem a compra por transferência (R$ 110)",
        r.ok &&
            !!compraNovo &&
            compraNovo.valorTotal === 110 &&
            compraNovo.status === "pago",
        "valor=" + (compraNovo && compraNovo.valorTotal)
    );

    /* -------------------------------------------------
       7) ACESSO INDIVIDUAL (não vaza entre pessoas)
    ------------------------------------------------- */

    const vazaParaDona =
        (body.transacoes || []).some(x =>
            x.valorTotal === 100
        );

    t(
        "7a. novo dono NÃO vê a venda da dona (R$ 100)",
        !vazaParaDona
    );

    ({ r, body } = await reqJson(
        BASE + "/api/historico",
        { headers: { "x-owner-tokens": tokenDona } }
    ));

    const vazaParaNovo =
        (body.transacoes || []).some(x =>
            x.valorTotal === 110
        );

    t(
        "7b. dona NÃO vê a compra do novo dono (R$ 110)",
        !vazaParaNovo
    );

    /* -------------------------------------------------
       8) SEGURANÇA do endpoint
    ------------------------------------------------- */

    ({ r, body } = await reqJson(
        BASE + "/api/historico"
    ));

    t(
        "8a. sem identificação -> 400",
        r.status === 400
    );

    ({ r, body } = await reqJson(
        BASE + "/api/historico",
        { headers: { "x-owner-tokens": "token-inexistente" } }
    ));

    t(
        "8b. token desconhecido -> extrato vazio",
        r.ok && (body.total === 0)
    );

    ({ r, body } = await reqJson(
        BASE + "/api/historico",
        { headers: { "x-owner-access-code": accessDona } }
    ));

    t(
        "8c. código de acesso via HEADER devolve a compra",
        r.ok &&
            (body.transacoes || []).some(x =>
                x.tipo === "compra" &&
                (x.espacos || []).includes(s2)
            )
    );

    /* -------------------------------------------------
       RESULTADO
    ------------------------------------------------- */

    console.log(log.join("\n"));

    const fails = log.filter(l => l.startsWith("FAIL"));

    console.log(
        "\nRESULTADO: " +
        (log.length - fails.length) +
        "/" + log.length + " passaram"
    );

    process.exit(fails.length ? 1 : 0);

})().catch((e) => {
    console.error("ERRO DE TESTE:", e);
    process.exit(2);
});
