/* Regressão das correções da rodada: BUG1 (erro 'undefined' ao trocar),
   BUG2 (fonte gigante no modal da figurinha) e BUG3 (split/mensagens). */
const fs = require("fs");
const path = require("path");
const colecao = fs.readFileSync(path.join(__dirname, "public", "colecionaveis.html"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const backend = fs.readFileSync(path.join(__dirname, "colecionaveis.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const checks = [
    /* BUG 1 */
    ["helper meuUsuarioId() criado", /function meuUsuarioId\(\)/.test(colecao)],
    ["minhaConta.usuario.id só existe dentro do helper usuarioLogado()", (colecao.match(/minhaConta\.usuario\.id/g) || []).length === 1],
    ["abrirModalTroca tem guarda defensiva", /abrirModalTroca\(\)/.test(colecao) && /meuUsuarioId\(\)/.test(colecao) && /Faça login novamente/.test(colecao)],
    ["index.html salva usuario na sessão (login+cadastro)", (index.match(/usuario: data\.usuario/g) || []).length >= 2],
    ["msgErro esconde erros técnicos", /Cannot read propert\|undefined\|is not a function\|TypeError/.test(colecao)],

    /* BUG 2 */
    ["verso do card usa fonte fixa pequena no modal", /\.modal-arte \.cc-verso-lista\{font-size:11px/.test(colecao)],
    ["modal-arte-premium reseta font-size", /\.modal-arte-premium\{[^}]*font-size:14px/.test(colecao)],
    ["CSS de flip 3D presente no modal", /\.cc-flipper\.virado/.test(colecao) && /\.cc-frente,\s*\.cc-verso/.test(colecao)],

    /* BUG 3 */
    ["mensagem amigável vendedor sem MP", /Este vendedor ainda não conectou o Mercado Pago/.test(backend)],
    ["mensagem amigável marketplace não configurado", /O pagamento deste anúncio ainda não está disponível porque o Marketplace não está configurado/.test(backend)],
    ["endpoint de diagnóstico de pagamentos", /diagnostico\/pagamentos/.test(backend)],
    ["diagnóstico nunca expõe tokens", /NUNCA expõe tokens/.test(backend)],
    ["split permanece estrito", /MERCADOPAGO_MARKETPLACE_SPLIT_ENABLED === "true"/.test(server)]
];

const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);