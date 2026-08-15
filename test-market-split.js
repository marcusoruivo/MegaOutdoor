/* Auditoria do adaptador real Checkout Pro Marketplace. */
const fs = require("fs");
const server = fs.readFileSync("server.js", "utf8");
const colecao = fs.readFileSync("colecionaveis.js", "utf8");
const checks = [
    ["Checkout Pro usa /checkout/preferences", /\/checkout\/preferences/.test(server)],
    ["usa token OAuth do vendedor", /mercadoPagoRequestComToken\(sellerAccount\.accessToken/.test(server)],
    ["envia marketplace_fee", /marketplace_fee: Number\(platformFee\)/.test(server)],
    ["comissão centralizada em 10%", /MERCADOPAGO_MARKETPLACE_FEE_PERCENT/.test(server) && /MARKETPLACE_FEE_PERCENT = 10/.test(colecao)],
    ["valor interno não substitui split", /mercadopagoMarketplaceSplitEnabled/.test(colecao) && /criarOrderMercadoPagoSplit/.test(colecao)],
    ["venda bloqueada sem split oficial", /split oficial do marketplace ainda não/.test(colecao)],
    ["webhook payment consulta token do vendedor", /consultarMercadoPagoPayment\(account\.accessToken/.test(colecao)],
    ["webhook idempotente por status pending", /status = 'pending'/.test(colecao)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
