/* Verificações estáticas dos fluxos de coleção e modais. */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const colecao = fs.readFileSync(path.join(root, "public", "colecionaveis.html"), "utf8");
const imagens = require(path.join(root, "public", "js", "imagens-animais.js"));
const checks = [];
function t(name, ok) { checks.push((ok ? "PASS" : "FAIL") + " | " + name); }

t("100 imagens reais mapeadas", Object.keys(imagens.IMAGENS_ANIMAIS).length === 100);
t("imagens usam URLs HTTPS", Object.values(imagens.IMAGENS_ANIMAIS).every(url => /^https:\/\//.test(url)));
t("Como Funciona abre modal", /function abrirComoFunciona\s*\(/.test(index) && /abrirComoFunciona\(event\)/.test(index));
t("Combos & Kits abre modal", /function verTodosKits\s*\(/.test(index) && /verTodosKits\(event\)/.test(index));
t("combos exibem breakdown", /kit-breakdown/.test(index) && /spacesPrice/.test(index) && /packsPrice/.test(index));
t("Coleção Completa tem aba e filtros", /data-aba="completa"/.test(colecao) && /completaBusca/.test(colecao) && /completaRaridade/.test(colecao));
t("Coleção Completa inclui novas/repetidas/acabamentos", /completaFiltroChips/.test(colecao) && /setColecaoCompletaFiltro/.test(colecao));
t("modal mostra probabilidades", /abrirModalProbabilidades/.test(colecao) && /Veja o que pode sair/.test(colecao));
t("resumo oferece próximos passos", /verMinhasFigurinhas/.test(colecao) && /abrirOutroPacote/.test(colecao));
t("pagamento fecha antes da abertura", /fecharModal\(\);\s*revelarPacote\(d\.pacote\)/.test(colecao));
t("probabilidades não renderizam objeto cru", !/textContent\s*=\s*r\.nome/.test(colecao));
t("Stories usam endpoint público", /\/api\/stories/.test(index) && /storyViewer/.test(index));
t("consentimento de Story é opcional no checkout", /storyOptIn/.test(index) && /storyOptIn/.test(colecao));
t("navegação de Story não seleciona espaço", /function navegarParaEspaco\s*\(/.test(index) && /centralizarNoEspaco\(id\)/.test(index));
t("viewport inicial aproxima o espaço 1 do início", /function iniciarVista\s*\(/.test(index) && /const margem/.test(index));
t("destaque patrocinado usa configuração central", /STORY_PRICE_5H/.test(fs.readFileSync(path.join(root, "server.js"), "utf8")) && /storyPricing/.test(index));
t("área Mercado Pago existe no topo", /mpRecebimentosBanner/.test(colecao) && /CONECTAR MERCADO PAGO/.test(colecao));
t("hint do mapa não é fixed", /\.hint\{position:relative/.test(index));

console.log(checks.join("\n"));
const failed = checks.filter(line => line.startsWith("FAIL")).length;
console.log(`\nTotal: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);
