
/* =========================================================
   PERFIL PÚBLICO — página pública (sem login obrigatório)
========================================================= */
function salvarSessao(dados){
    try { localStorage.setItem("mega_conta", JSON.stringify(dados)); } catch(e){}
}
function lerSessao(){
    try { return JSON.parse(localStorage.getItem("mega_conta") || "null"); } catch(e){ return null; }
}
function meuId(){
    const s = lerSessao();
    if (s && s.usuario && s.usuario.id != null) return s.usuario.id;
    if (s && s.id != null) return s.id;
    return null;
}
function minhaConta(){ return lerSessao(); }

function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function fmtR$(v){ return "R$ " + Number(v||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtData(d){ if(!d) return ""; const x=new Date(d); if(isNaN(x)) return ""; return x.toLocaleDateString("pt-BR") + " " + x.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); }
function toast(msg, tipo){
    const el = document.createElement("div");
    el.className = "toast " + (tipo||"info");
    el.textContent = msg;
    document.getElementById("toastWrap").appendChild(el);
    setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(),300); }, 3200);
}
function msgErro(e){
    const m = e && e.message ? String(e.message) : "";
    if (/Cannot read propert|undefined|is not a function|TypeError|ReferenceError|SyntaxError|network|fetch failed/i.test(m)) {
        console.error("[MILHAO-DOOR] erro técnico (oculto do usuário):", e);
        return "Não foi possível concluir esta ação. Tente novamente.";
    }
    return m;
}
function authHeaders(opts){
    const s = minhaConta();
    if (s && s.token) opts.headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + s.token });
    opts.credentials = "include";
    return opts;
}
async function api(url, opts){
    const res = await fetch(url, authHeaders(opts || {}));
    const ct = res.headers.get("content-type") || "";
    const d = ct.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error((d && (d.error || d.message)) || ("Erro " + res.status));
    return d;
}
function apiGet(url){ return api(url, { headers: authHeaders({}) }); }
function apiPost(url, body){ return api(url, { method:"POST", headers: authHeaders({}), body: JSON.stringify(body||{}) }); }

const NOME_RARIDADE = { COMUM:"COMUM", INCOMUM:"INCOMUM", RARA:"RARA", EPICA:"ÉPICA", LENDARIA:"LENDÁRIA", MITICA:"MÍTICA" };
const EMOJI_RARIDADE = { COMUM:"🟢", INCOMUM:"🟡", RARA:"🔵", EPICA:"🟣", LENDARIA:"🟠", MITICA:"🔴" };

let PERFIL = null;
let CARDS = [];

const params = new URLSearchParams(location.search);
const PERFIL_ID = params.get("id");

async function carregar(){
    const header = document.getElementById("perfilHeader");
    const conteudo = document.getElementById("albumConteudo");
    if (!PERFIL_ID) {
        header.innerHTML = "";
        conteudo.innerHTML = '<div class="aviso"><b>Perfil não encontrado</b>Informe o id do colecionador na URL (ex.: /perfil.html?id=1).</div>';
        return;
    }
    try {
        const d = await apiGet("/api/colecionaveis/colecionador/" + encodeURIComponent(PERFIL_ID));
        PERFIL = d.perfil || {};
        CARDS = d.cards || [];
        renderHeader();
        renderAlbum();
    } catch(e){
        header.innerHTML = "";
        conteudo.innerHTML = '<div class="aviso"><b>Colecionador não encontrado</b>Verifique o link ou tente novamente.</div>';
    }
}

function renderHeader(){
    const p = PERFIL;
    const visibilidade = p.privado ? "PRIVADO" : "PÚBLICO";
    const fotoUrl = p.fotoUrl || p.foto_url;
    const avatarHtml = fotoUrl
        ? '<img src="' + esc(fotoUrl) + '" alt="' + esc(p.nome || "Colecionador") + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'"><span class="fallback" style="display:none">👤</span>'
        : '👤';
    const meu = meuId();
    const ehMeu = meu != null && p.id === meu;
    const btnBisbilhotar = !ehMeu && !p.privado
        ? '<button class="btn btn-amarelo" style="margin:4px;padding:8px 14px;font-size:12px" onclick="bisbilhotarAlbum()">👀 BISBILHOTAR</button>'
        : '';
    const btnVerOfertas = !ehMeu && !p.privado && (p.vendas||0) > 0
        ? '<button class="btn btn-ghost" style="margin:4px;padding:8px 14px;font-size:12px" onclick="verOfertasUsuario()">💰 VER OFERTAS</button>'
        : '';
    const btnNegociar = !ehMeu && !p.privado
        ? '<button class="btn btn-amarelo" style="margin:4px;padding:8px 14px;font-size:12px" onclick="abrirNegociacaoUsuario()">🤝 NEGOCIAR</button>'
        : '';
    const botoesContainer = (btnBisbilhotar || btnVerOfertas || btnNegociar)
        ? '<div style="margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' + btnBisbilhotar + btnVerOfertas + btnNegociar + '</div>'
        : '';
    document.getElementById("perfilHeader").innerHTML =
        '<div class="header-perfil">' +
            '<div class="avatar">' + avatarHtml + '</div>' +
            '<div class="header-info">' +
                '<h1>' + esc(p.nome || "Colecionador") + '</h1>' +
                '<div class="sub">Álbum ' + visibilidade + (ehMeu ? " • <b style='color:var(--verde)'>este é você</b>" : "") + '</div>' +
            '</div>' +
            '<div class="stats">' +
                '<div class="stat-box"><div class="v">' + (p.diferentes||0) + '/' + 100 + '</div><div class="l">PROGRESSO</div></div>' +
                '<div class="stat-box"><div class="v">' + (p.figurinhas||0) + '</div><div class="l">DESCOBERTAS</div></div>' +
                '<div class="stat-box"><div class="v">' + (p.repetidas||0) + '</div><div class="l">REPETIDAS</div></div>' +
                '<div class="stat-box"><div class="v">' + (p.disponiveis_troca||0) + '</div><div class="l">P/ TROCA</div></div>' +
                '<div class="stat-box"><div class="v">' + (p.vendas||0) + '</div><div class="l">À VENDA</div></div>' +
            '</div>' +
            botoesContainer +
        '</div>';
}

function bisbilhotarAlbum(){
    if (!PERFIL || !PERFIL.id) return;
    window.open('/perfil.html?id=' + encodeURIComponent(PERFIL.id), '_blank');
}

function verOfertasUsuario(){
    if (!PERFIL || !PERFIL.id) return;
    window.open('/colecionaveis.html?sellerId=' + encodeURIComponent(PERFIL.id) + '#mercado', '_blank');
}

function abrirNegociacaoUsuario(){
    if (!PERFIL || !PERFIL.id) return;
    const meu = meuId();
    if (meu != null && PERFIL.id === meu) {
        toast("Você não pode negociar com você mesmo.", "erro");
        return;
    }
    window.open('/colecionaveis.html?negociarCom=' + encodeURIComponent(PERFIL.id) + '#mercado', '_blank');
}

function renderAlbum(){
    const conteudo = document.getElementById("albumConteudo");
    if (PERFIL.privado) {
        conteudo.innerHTML = '<div class="aviso"><b>🔒 Este colecionador mantém o álbum privado.</b>Habilite seu álbum público em Meu Perfil para compartilhar seu acervo.</div>';
        return;
    }
    if (!CARDS.length) {
        conteudo.innerHTML = '<div class="aviso"><b>Acervo vazio</b>Este colecionador ainda não possui figurinhas.</div>';
        return;
    }
    conteudo.innerHTML = '<div class="grid-album">' + CARDS.map(tileHtml).join("") + '</div>';
}

function tileHtml(c){
    const finish = (typeof ColecaoUI !== "undefined" && ColecaoUI.finishDeCard) ? ColecaoUI.finishDeCard(c) : "normal";
    const finLabel = finish === "ouro" ? " OURO" : finish === "cromada" ? " CROMADA" : "";
    const emoji = EMOJI_RARIDADE[c.rarity] || "🃏";
    const imagem = c.image_url
        ? '<img src="' + esc(c.image_url) + '" alt="' + esc(c.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'"><span class="fallback" style="display:none">' + emoji + '</span>'
        : emoji;
    return '<div class="tile" onclick="abrirDetalhe(' + c.id + ')">' +
        '<span class="qtd">' + c.quantity + 'x</span>' +
        (c.listing ? '<span class="venda">À VENDA</span>' : '') +
        '<div class="img">' + imagem + '</div>' +
        '<div class="info"><div class="nome">#' + String(c.number).padStart(3,"0") + ' ' + esc(c.name) + '</div>' +
        '<div class="meta">' + (NOME_RARIDADE[c.rarity] || c.rarity) + finLabel + '</div></div>' +
    '</div>';
}

function cardPorId(id){ return CARDS.find(c => Number(c.id) === Number(id)); }

function abrirDetalhe(cardId){
    const c = cardPorId(cardId);
    if (!c) return;
    const meu = meuId();
    const ehMeu = meu != null && PERFIL.id === meu;
    const fin = (typeof ColecaoUI !== "undefined" && ColecaoUI.finishDeCard) ? ColecaoUI.finishDeCard(c) : "normal";
    const finLabel = fin === "ouro" ? "🏆 OURO" : fin === "cromada" ? "🪞 CROMADA" : "NORMAL";
    const imagem = c.image_url ? '<img src="' + esc(c.image_url) + '" alt="' + esc(c.name) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'">' : '';

    let acoes = '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>';
    if (ehMeu) {
        acoes = '<div class="acoes"><button class="btn btn-ghost" onclick="fecharModal()">Fechar</button></div>';
    } else {
        acoes = '<div class="acoes">' +
            (c.listing ? '<a class="btn btn-laranja" href="/colecionaveis.html" target="_blank">💳 COMPRAR ' + fmtR$(c.listing.unit_price) + '</a>' : '') +
            '<button class="btn btn-amarelo" onclick="abrirModalOferta(' + c.id + ')">💰 FAZER OFERTA</button>' +
            '<a class="btn btn-ghost" href="/colecionaveis.html" target="_blank">🤝 PROPÔR TROCA</a>' +
            '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>' +
        '</div>';
    }

    document.getElementById("modalBody").innerHTML =
        '<div class="num">' + (NOME_RARIDADE[c.rarity] || c.rarity) + ' • ' + finLabel + '</div>' +
        '<h2>#' + String(c.number).padStart(3,"0") + ' — ' + esc(c.name) + '</h2>' +
        (imagem ? '<div style="height:220px;border-radius:14px;overflow:hidden;margin:10px 0;background:var(--painel2)">' + imagem + '</div>' : '') +
        '<div class="desc">' + (PERFIL.nome || "O colecionador") + ' possui <b style="color:var(--amarelo)">' + c.quantity + 'x</b> desta figurinha' +
        (c.listing ? ' e vende por <b style="color:var(--amarelo)">' + fmtR$(c.listing.unit_price) + '</b> cada (Qtd: ' + c.listing.quantity + ').' : '.') + '</div>' +
        acoes;
    document.getElementById("modalOverlay").classList.remove("hidden");
}

function abrirModalOferta(cardId){
    const c = cardPorId(cardId);
    const s = minhaConta();
    if (!s || !s.token) {
        toast("Entre na sua conta para fazer uma oferta.", "erro");
        return;
    }
    const valorSugerido = c && c.listing ? Number(c.listing.unit_price).toFixed(2) : "0.00";
    document.getElementById("modalBody").innerHTML =
        '<div class="num">💰 FAZER OFERTA</div>' +
        '<h2>#' + String((c && c.number) || cardId).padStart(3,"0") + ' ' + esc((c && c.name) || "") + '</h2>' +
        '<label>Vendedor</label><div class="campo">' + esc(PERFIL.nome || "—") + '</div>' +
        (c && c.listing ? '<label>Valor anunciado</label><div class="campo">' + fmtR$(c.listing.unit_price) + '</div>' : '') +
        '<label>Quantidade</label><input id="ofertaQuantidade" type="number" min="1" max="99" value="1">' +
        '<label>Sua oferta (R$)</label><input id="ofertaValor" type="number" min="0.01" step="0.01" value="' + valorSugerido + '">' +
        '<label>Mensagem (opcional)</label><textarea id="ofertaMensagem" maxlength="500" rows="3" placeholder="Ex.: posso fechar por esse valor?"></textarea>' +
        '<div class="acoes"><button class="btn btn-amarelo" onclick="enviarOferta(' + cardId + ')">ENVIAR OFERTA</button>' +
        '<button class="btn btn-ghost" onclick="abrirDetalhe(' + cardId + ')">Voltar</button></div>';
    document.getElementById("modalOverlay").classList.remove("hidden");
}

async function enviarOferta(cardId){
    try {
        const quantidade = Math.max(1, Math.floor(Number(document.getElementById("ofertaQuantidade").value) || 1));
        const valor = Number(document.getElementById("ofertaValor").value);
        const mensagem = document.getElementById("ofertaMensagem").value;
        if (!isFinite(valor) || valor <= 0) { toast("Informe um valor de oferta válido.", "erro"); return; }
        const d = await apiPost("/api/colecionaveis/offers", { cardId, offereeId: Number(PERFIL.id), quantidade, valor, mensagem });
        toast("Oferta enviada para " + esc(PERFIL.nome) + "!", "ok");
        fecharModal();
    } catch(e){ toast(msgErro(e), "erro"); }
}

function fecharModal(){
    document.getElementById("modalOverlay").classList.add("hidden");
}

document.getElementById("modalOverlay").addEventListener("click", function(e){
    if (e.target === this) fecharModal();
});

carregar();
