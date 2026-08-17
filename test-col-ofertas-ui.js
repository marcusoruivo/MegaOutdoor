/* Verificações de UI do sistema de OFERTAS + ÁLBUM PÚBLICO. */
const fs = require("fs");
const path = require("path");
const colecao = fs.readFileSync(path.join(__dirname, "public", "colecionaveis.html"), "utf8");
const perfil = fs.existsSync(path.join(__dirname, "public", "perfil.html"))
    ? fs.readFileSync(path.join(__dirname, "public", "perfil.html"), "utf8") : "";

const checks = [
    ["aba OFERTAS existe no topo", /data-aba="ofertas"/.test(colecao)],
    ["seção OFERTAS existe", /id="secao-ofertas"/.test(colecao)],
    ["botão FAZER OFERTA nos anúncios", /abrirModalOferta\(/.test(colecao)],
    ["modal de oferta com valor/mensagem", /ofertaQuantidade/.test(colecao) && /ofertaValor/.test(colecao) && /ofertaMensagem/.test(colecao)],
    ["envio de oferta usa POST /offers", /apiPost\("\/api\/colecionaveis\/offers"/.test(colecao)],
    ["lista ofertas (recebidas/enviadas)", /\/api\/colecionaveis\/offers\/mine/.test(colecao) && /recebidas/.test(colecao) && /enviadas/.test(colecao)],
    ["aceitar/recusar/contrapor/cancelar/pagar", /\/accept/.test(colecao) && /\/decline/.test(colecao) && /\/counter/.test(colecao) && /\/cancel/.test(colecao) && /\/pay/.test(colecao)],
    ["estados de negociação no frontend", /PENDENTE/.test(colecao) && /ACEITA/.test(colecao) && /RECUSADA/.test(colecao) && /CANCELADA/.test(colecao) && /EXPIRADA/.test(colecao) && /CONCLUIDA/.test(colecao)],
    ["erros técnicos viram mensagens amigáveis (msgErro)", /msgErro\(/.test(colecao)],
    ["tipo de pagamento OFERTA suportado", /oferta/.test(colecao) && /offers\/" \+ dados.offerId/.test(colecao)],
    ["apiPut disponível (visibilidade)", /function apiPut\(url, body\)/.test(colecao)],
    ["toggle de visibilidade no perfil", /perfil\/visibilidade/.test(colecao) && /mudarVisibilidade/.test(colecao)],
    ["perfil público privado por padrão (sem cards)", /id="perfilHeader"/.test(perfil) && /id="albumConteudo"/.test(perfil)],
    ["perfil público mostra 'álbum privado'", /álbum privado/.test(perfil)],
    ["perfil público tem FAZER OFERTA e PROPÔR TROCA e COMPRAR", /FAZER OFERTA/.test(perfil) && /PROPÔR TROCA/.test(perfil) && /COMPRAR/.test(perfil)],
    ["perfil público não renderiza email (só usa token p/ header de oferta)", !/perfil\.email|d\.email|p\.email/.test(perfil) && !/access_token|refresh_token/.test(perfil)]
];

const failed = checks.filter(([name, ok]) => { console.log((ok ? "PASS" : "FAIL") + " | " + name); return !ok; }).length;
console.log(`Total: ${checks.length} | Passou: ${checks.length - failed} | Falhou: ${failed}`);
process.exit(failed ? 1 : 0);