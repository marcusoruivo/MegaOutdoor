/* Verificações da infraestrutura OAuth e do bloqueio seguro de vendas. */
const fs = require("fs");
const server = fs.readFileSync("server.js", "utf8");
const colecao = fs.readFileSync("colecionaveis.js", "utf8");
const frontend = fs.readFileSync("public/colecionaveis.html", "utf8");
const accountRoute = server.slice(server.indexOf('app.get("/api/marketplace/account"'), server.indexOf('\napp.', server.indexOf('app.get("/api/marketplace/account"') + 5));
const checks = [
    ["variáveis OAuth centralizadas", /MERCADOPAGO_CLIENT_ID/.test(server) && /MERCADOPAGO_CLIENT_SECRET/.test(server) && /MERCADOPAGO_REDIRECT_URI/.test(server)],
    ["tokens OAuth criptografados", /criptografarMarketplace/.test(server) && /access_token_enc/.test(server)],
    ["rotas connect/callback/status", /marketplace\/oauth\/connect/.test(server) && /marketplace\/oauth\/callback/.test(server) && /marketplace\/account/.test(server)],
    ["PKCE S256 implementado", /code_challenge/.test(server) && /code_challenge_method: "S256"/.test(server) && /code_verifier/.test(server)],
    ["state one-shot persistido", /marketplace_oauth_states/.test(server) && /used_at IS NULL/.test(server) && /FOR UPDATE/.test(server)],
    ["adapter usa token do vendedor", /criarOrderMercadoPagoSplit/.test(server) && /mercadoPagoRequestComToken\(sellerAccount\.accessToken/.test(server)],
    ["adapter envia marketplace_fee", /marketplace_fee: Number\(platformFee\)/.test(server)],
    ["vendedor sem conta é bloqueado", /conecte sua conta do Mercado Pago/.test(colecao)],
    ["split permanece desativado sem configuração oficial", /mercadopagoMarketplaceSplitEnabled/.test(colecao) && /MERCADOPAGO_MARKETPLACE_SPLIT_ENABLED/.test(server)],
    ["nenhum token OAuth é enviado ao frontend", !/access_token|refresh_token/.test(accountRoute)],
    ["frontend solicita URL OAuth com Bearer e credentials", /fetch\("\/api\/marketplace\/oauth\/connect"/.test(frontend) && /credentials: "include"/.test(frontend) && /authorizationUrl/.test(frontend)]
];
const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
