
/* =========================================================
   MEGAOUTDOOR COLECIONÁVEIS — FRONTEND
   Lê o token de /api/auth (localStorage "mega_conta").
========================================================= */

let minhaConta = null;
try {
    minhaConta = JSON.parse(localStorage.getItem("mega_conta") || "null");
} catch(e){ minhaConta = null; }

// Iniciar polling de notificações se já estiver logado
if (minhaConta && minhaConta.token) {
    setTimeout(() => {
        if (typeof iniciarPollingNotificacoes === "function") {
            iniciarPollingNotificacoes();
        }
    }, 1000);
}

/* Resolve o usuário logado de forma defensiva.
   A sessão pode ter sido criada por index.html como { token, nome, email }
   (sem o sub-objeto usuario). Neste caso decodifica o JWT para obter o id
   e normaliza o formato salvo. Retorna null se não houver sessão válida. */
function usuarioLogado(){
    if (minhaConta && minhaConta.usuario && minhaConta.usuario.id) {
        return minhaConta.usuario;
    }
    if (!minhaConta || !minhaConta.token) return null;
    try {
        const part = String(minhaConta.token).split(".")[1];
        if (!part) return null;
        const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
        if (payload && payload.usuarioId) {
            minhaConta.usuario = {
                id: Number(payload.usuarioId),
                nome: minhaConta.nome || payload.nome || "",
                email: minhaConta.email || payload.email || ""
            };
            localStorage.setItem("mega_conta", JSON.stringify(minhaConta));
            return minhaConta.usuario;
        }
    } catch(e) { /* sessão inválida — segue sem usuario */ }
    return null;
}
function meuUsuarioId(){
    const u = usuarioLogado();
    return u ? u.id : null;
}

let INFO = null;
let MEU_ALBUM = null;
let estado = {
    aba: "album",
    acervo: { pagina: 1 },
    mercado: { pagina: 1, filtroVendedor: null },
    cartModal: null,
    modoTroca: null
};

function authHeaders(extra){
    const h = extra || {};
    if (minhaConta && minhaConta.token) h["Authorization"] = "Bearer " + minhaConta.token;
    if (!h["Content-Type"]) { h["Content-Type"] = "application/json"; }
    return h;
}

/* ===== API ===== */
async function api(url, opts = {}) {
    const res = await fetch(url, Object.assign({ credentials: "include" }, opts));
    let data = null;
    const texto = await res.text();
    try { data = JSON.parse(texto); } catch(e){ data = { raw: texto }; }
    if (!res.ok) {
        if (res.status === 401 && /sess[aã]o|expir|entrar novamente|login/i.test((data && data.error) || "")) {
            minhaConta = null;
            localStorage.removeItem("mega_conta");
            atualizarHeader();
        }
        const err = new Error((data && data.error) || "Erro na requisição");
        err.status = res.status;
        throw err;
    }
    return data;
}
function apiGet(url){ return api(url, { headers: authHeaders({}) }); }
function apiPost(url, body){ return api(url, { method:"POST", headers: authHeaders({}), body: JSON.stringify(body||{}) }); }
function apiPut(url, body){ return api(url, { method:"PUT", headers: authHeaders({}), body: JSON.stringify(body||{}) }); }
function apiDelete(url){ return api(url, { method:"DELETE", headers: authHeaders({}) }); }

/* ===== UI HELPERS ===== */
function toast(msg, tipo){
    const el = document.createElement("div");
    el.className = "toast " + (tipo || "info");
    el.textContent = msg;
    document.getElementById("toastWrap").appendChild(el);
    setTimeout(()=>{ el.style.opacity = "0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(),300); }, 3200);
}

/* Converte exceções em mensagens amigáveis. Erros técnicos de JavaScript
   nunca vão para o usuário; são registrados no console (backend faz o log
   seguro no servidor). */
function msgErro(e){
    const m = e && e.message ? String(e.message) : "";
    if (/Cannot read propert|undefined|is not a function|TypeError|ReferenceError|SyntaxError|network|fetch failed/i.test(m)) {
        if (window.console && console.error) console.error("[MILHAO-DOOR] erro técnico (oculto do usuário):", e);
        return "Não foi possível concluir esta ação. Tente novamente.";
    }
    return m;
}
function fmtR$(v){ return "R$ " + Number(v||0).toFixed(2).replace(".", ","); }
function emojiRaridade(r){
    return { COMUM:"🟤", INCOMUM:"🟢", RARA:"🔵", EPICA:"🟣", LENDARIA:"🟡", MITICA:"🔴" }[r] || "🃏";
}
function nomeRaridade(r){
    return { COMUM:"COMUM", INCOMUM:"INCOMUM", RARA:"RARA", EPICA:"ÉPICA", LENDARIA:"LENDÁRIA", MITICA:"MÍTICA" }[r] || r;
}
function cardModalArte(card){
    const r = card.rarity;
    return '<div class="modal-arte modal-arte-premium r-' + r + '" id="modalArte">' +
        '<div class="cc-flip-container" id="modalFlipContainer">' +
            '<div class="cc-flipper">' +
                '<div class="cc-frente">' + ColecaoUI.cardGrandeHtml(card) + '</div>' +
                '<div class="cc-verso">' + ColecaoUI.cardVersoHtml(card) + '</div>' +
            '</div>' +
        '</div>' +
    '</div>';
}
function toggleModalFlip(){
    const container = document.getElementById("modalFlipContainer");
    if (container) {
        const flipper = container.querySelector(".cc-flipper") || container;
        flipper.classList.toggle("virado");
    }
}

function atualizarHeader(){
    const bt = document.getElementById("btnConta");
    if (minhaConta && minhaConta.token) {
        const u = (minhaConta.usuario && minhaConta.usuario.nome) || minhaConta.nome || "";
        bt.innerHTML = '🔐 <span class="conta-nome">' + esc(u || "Minha conta") + '</span>';
        bt.title = "Sessão iniciada — clique para ver sua conta";
    } else {
        bt.innerHTML = "👤 ENTRAR";
    }
    carregarContaRecebimento();
}

/* ===== VALIDAÇÃO DE CPF/CNPJ (espelho do backend) ===== */
function _validarCpf(cpf){
    cpf = String(cpf).replace(/\D/g, "");
    if (cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += Number(cpf[i]) * (10 - i);
    let digito = (soma * 10) % 11 % 10;
    if (digito !== Number(cpf[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += Number(cpf[i]) * (11 - i);
    digito = (soma * 10) % 11 % 10;
    return digito === Number(cpf[10]);
}
function _validarCnpj(cnpj){
    cnpj = String(cnpj).replace(/\D/g, "");
    if (cnpj.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(cnpj)) return false;
    const pesos1 = [5,4,3,2,9,8,7,6,5,4,3,2];
    let soma = 0;
    for (let i = 0; i < 12; i++) soma += Number(cnpj[i]) * pesos1[i];
    let digito = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (digito !== Number(cnpj[12])) return false;
    const pesos2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
    soma = 0;
    for (let i = 0; i < 13; i++) soma += Number(cnpj[i]) * pesos2[i];
    digito = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    return digito === Number(cnpj[13]);
}
function validarCpfCnpj(v){
    const d = String(v).replace(/\D/g, "");
    return d.length === 11 ? _validarCpf(d) : (d.length === 14 ? _validarCnpj(d) : false);
}

function exigirLogin(){
    if (minhaConta && minhaConta.token) return true;
    abrirModalLogin();
    return false;
}

function mudarAba(aba){
    estado.aba = aba;
    document.querySelectorAll(".aba-btn").forEach(b => b.classList.toggle("ativa", b.dataset.aba === aba));
    document.querySelectorAll(".secao").forEach(s => s.classList.remove("ativa"));
    document.getElementById("secao-" + aba).classList.add("ativa");
    if (aba === "album") carregarAlbum();
    if (aba === "completa") carregarColecaoCompleta();
    if (aba === "acervo") carregarAcervo();
    if (aba === "packs") carregarPacks();
    if (aba === "mercado") carregarMercado(1);
    if (aba === "leiloes") carregarLeiloes();
    if (aba === "trocas") carregarTrocas();
    if (aba === "ofertas") carregarOfertas();
    if (aba === "perfil") carregarPerfil();
}

/* =========================================================
   INFO + ÁLBUM
========================================================= */
async function carregarInfo(){
    try {
        INFO = await apiGet("/api/colecionaveis/info");
        document.getElementById("colecaoNome").textContent = INFO.colecao ? INFO.colecao.name : "Minha coleção";
    } catch(e){
        document.getElementById("colecaoNome").textContent = "Coleção indisponível";
    }
}

async function carregarAlbum(){
    const grid = document.getElementById("albumGrid");
    if (!exigirLogin()) { grid.innerHTML = ""; return; }
    try {
        const d = await apiGet("/api/colecionaveis/meu-album");
        MEU_ALBUM = d;
        const cards = d.cards || [];
        const total = d.colecao ? d.colecao.total : 100;

        /* estatísticas visuais (descobertas / repetidas / especiais / pacotes) */
        const res = ColecaoUI.resumoColecao(cards, total);
        document.getElementById("progressoNum").textContent = res.diferentes + "/" + total;
        document.getElementById("progressoFill").style.width = res.progresso + "%";
        document.getElementById("legendaDiferentes").textContent = res.diferentes;
        document.getElementById("legendaRepetidas").textContent = res.repetidas;
        document.getElementById("legendaEspeciais").textContent = res.especiais;
        try {
            const pf = await apiGet("/api/colecionaveis/perfil");
            document.getElementById("legendaPacotes").textContent = (pf.perfil && pf.perfil.pacotes_abertos) || 0;
        } catch(e){}

        const statusEl = document.getElementById("albumStatus");
        if (res.completo) {
            statusEl.classList.remove("hidden");
            statusEl.innerHTML = '<div style="background:linear-gradient(90deg,rgba(46,204,113,.18),rgba(255,212,0,.12));' +
                'border:1px solid rgba(46,204,113,.5);border-radius:12px;padding:12px 16px;text-align:center;">' +
                '<b style="color:var(--verde);font-size:15px;">🏆 ÁLBUM COMPLETO!</b>' +
                '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' +
                'Você completou todas as ' + total + ' figurinhas. Parabéns, colecionador! 🎉</div></div>';
        } else {
            statusEl.classList.remove("hidden");
            statusEl.innerHTML = '<div style="background:rgba(255,122,0,.08);border:1px solid rgba(255,122,0,.35);' +
                'border-radius:12px;padding:10px 16px;text-align:center;font-size:12px;color:var(--muted);">' +
                '🎯 Faltam <b style="color:var(--laranja);">' + (total - res.diferentes) + '</b> figurinha(s) para completar o álbum. ' +
                'Abra pacotinhos, compre no mercado ou troque para acelerar!</div>';
        }

        /* filtros + pesquisa do álbum */
        const busca = document.getElementById("albumBusca").value;
        const filtradas = ColecaoUI.filtrarCards(cards, { filtro: albumFiltro, busca });
        document.getElementById("albumResultado").textContent = filtradas.length + " de " + cards.length + " figurinha(s)";
        grid.innerHTML = filtradas.map(cardHtml).join("")
            || '<div style="color:var(--muted);padding:20px">Nenhuma figurinha encontrada com esse filtro.</div>';
    } catch(e){
        grid.innerHTML = '<div style="color:var(--muted);padding:20px">' + (e.message || "Erro") + '</div>';
    }
}

let albumFiltro = "todas";
function setAlbumFiltro(f, btn){
    albumFiltro = f;
    document.querySelectorAll("#albumFiltroChips .filtro-chip").forEach(b => b.classList.toggle("ativa", b === btn));
    carregarAlbum();
}

function mostrarBloqueada(){
    toast("🔒 Figurinha bloqueada. Abra um pacotinho para descobrir!", "info");
}

function cardHtml(card){
    return ColecaoUI.cardColecaoHtml(card);
}

function completaCardHtml(card){
    const owned = Number(card.quantidade || 0);
    const image = card.image_url || (window.ANIMAIS_DADOS && window.ANIMAIS_DADOS.IMAGENS_ANIMAIS && window.ANIMAIS_DADOS.IMAGENS_ANIMAIS[card.name]) || "";
    const imageHtml = image
        ? '<img src="' + esc(image) + '" alt="' + esc(card.name) + '" loading="lazy" onerror="this.style.display=\'none\'">'
        : '<span style="font-size:42px">🐾</span>';
    return '<article class="completa-card">' +
        (owned ? '<span class="completa-posse">' + owned + 'x</span>' : '') +
        '<div class="completa-arte">' + imageHtml + '</div>' +
        '<div class="completa-info"><div class="completa-num">#' + String(card.number).padStart(3,"0") + ' · ' + esc(card.rarity) + '</div>' +
        '<div class="completa-nome">' + esc(card.name) + '</div>' +
        '<div class="completa-meta">' + (owned ? '✅ Na sua coleção' : '🔒 Ainda não descoberta') + '</div></div></article>';
}

let completaFiltro = "todas";
function setColecaoCompletaFiltro(filtro, btn){
    completaFiltro = filtro;
    document.querySelectorAll("#completaFiltroChips .filtro-chip").forEach(b => b.classList.toggle("ativa", b === btn));
    carregarColecaoCompleta();
}

async function carregarColecaoCompleta(){
    const grid = document.getElementById("completaGrid");
    if (!grid) return;
    try {
        const info = INFO || await apiGet("/api/colecionaveis/info");
        INFO = info;
        let cards = (info.cards || []).map(c => Object.assign({}, c));
        if (minhaConta && minhaConta.token) {
            try {
                const album = MEU_ALBUM || await apiGet("/api/colecionaveis/meu-album");
                MEU_ALBUM = album;
                const posse = new Map((album.cards || []).map(c => [Number(c.id), Number(c.quantidade || 0)]));
                cards = cards.map(c => Object.assign(c, { quantidade: posse.get(Number(c.id)) || 0 }));
            } catch(e) {}
        }
        const busca = (document.getElementById("completaBusca").value || "").trim().toLowerCase();
        const raridade = document.getElementById("completaRaridade").value;
        cards = cards.filter(c => (!raridade || c.rarity === raridade) &&
            (!busca || String(c.number).includes(busca) || String(c.name || "").toLowerCase().includes(busca)));
        cards = cards.filter(c => {
            const owned = Number(c.quantidade || 0);
            if(completaFiltro === "novas") return owned === 1;
            if(completaFiltro === "repetidas") return owned > 1;
            if(completaFiltro === "ouro") return ColecaoUI.finishDeCard(c) === "ouro";
            if(completaFiltro === "cromada") return ColecaoUI.finishDeCard(c) === "cromada";
            return true;
        });
        document.getElementById("completaResultado").textContent = cards.length + " espécie(s)";
        grid.innerHTML = cards.length ? cards.map(completaCardHtml).join("") : '<div style="color:var(--muted);padding:20px">Nenhuma espécie encontrada.</div>';
    } catch(e) {
        grid.innerHTML = '<div style="color:var(--muted);padding:20px">' + esc(e.message || "Erro") + '</div>';
    }
}

function esc(s){
    return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* =========================================================
   ACERVO
========================================================= */
let acervoFiltroRepetidas = "todas";
function setAcervoRepetidas(f, btn){
    acervoFiltroRepetidas = f;
    document.querySelectorAll("#acervoRepetidasChips .filtro-chip").forEach(b => b.classList.toggle("ativa", b === btn));
    estado.acervo.pagina = 1;
    carregarAcervo();
}
function negociarRepetidas(){
    acervoFiltroRepetidas = "repetidas";
    document.querySelectorAll("#acervoRepetidasChips .filtro-chip").forEach(b =>
        b.classList.toggle("ativa", b.getAttribute("data-f") === "repetidas"));
    estado.acervo.pagina = 1;
    carregarAcervo();
    document.getElementById("secao-acervo").scrollIntoView({ behavior: "smooth" });
}

async function carregarAcervo(){
    if (!exigirLogin()) return;
    const busca = document.getElementById("acervoBusca").value.trim();
    const raridade = document.getElementById("acervoRaridade").value;
    const ordenar = document.getElementById("acervoOrdenar").value;
    const p = estado.acervo.pagina;
    const q = new URLSearchParams({ pagina:p });
    if (busca) q.set("busca", busca);
    if (raridade) q.set("raridade", raridade);
    if (ordenar !== "numero") q.set("ordenar", ordenar);
    if (acervoFiltroRepetidas !== "todas") q.set("repetidas", acervoFiltroRepetidas);
    try {
        const d = await apiGet("/api/colecionaveis/acervo?" + q.toString());
        const stats = d.stats || {};
        const paraTroca = Math.max(0, Number(stats.repetidas || 0) - (d.cards || []).reduce((a,c)=>a+Math.max(0, c.quantidade - 1 - (c.disponivel||0)), 0));
        document.getElementById("acervoStats").innerHTML =
            '<span class="as-box"><b>' + (stats.total || 0) + '</b> figurinha(s)</span>' +
            '<span class="as-box"><b>' + (stats.diferentes || 0) + '</b> espécie(s)</span>' +
            '<span class="as-box"><b>' + (stats.repetidas || 0) + '</b> unidade(s) repetida(s)</span>' +
            '<span class="as-box"><b>' + paraTroca + '</b> disponível(is) para troca</span>';
        document.getElementById("acervoGrid").innerHTML = d.cards.length
            ? d.cards.map(c => ColecaoUI.cardColecaoHtml(c)).join("")
            : '<div style="color:var(--muted);padding:16px">Nenhuma figurinha encontrada com esse filtro.</div>';
        renderPag(d, "acervo");
        carregarMinhasVendas();
    } catch(e){
        document.getElementById("acervoGrid").innerHTML = '<div style="color:var(--muted);padding:16px">' + esc(e.message) + '</div>';
    }
}

async function carregarMinhasVendas(){
    try {
        const d = await apiGet("/api/colecionaveis/listings/mine");
        const lista = d.listings || [];
        document.getElementById("minhasVendasLista").innerHTML = lista.length
            ? lista.map(l => {
                const st = l.status;
                const stCls = st === "active" ? "status-ativo" : (st === "sold" ? "status-sold" : "status-cancelled");
                const stTxt = st === "active" ? "ATIVO" : (st === "sold" ? "VENDIDO" : "CANCELADO");
                return '<div class="venda-item">' +
                    '<div class="listing-mini-arte r-' + l.rarity + '">' + emojiRaridade(l.rarity) + '</div>' +
                    '<div class="info"><div class="n">#' + String(l.number).padStart(3,"0") + ' — ' + esc(l.name) + '</div>' +
                    '<div class="muted">' + l.quantity + 'x • ' + fmtR$((l.unit_price||0)) + ' cada</div></div>' +
                    '<div class="status-pill ' + stCls + '">' + stTxt + '</div>' +
                    (st === "active" ? '<button class="btn btn-ghost" style="font-size:11px;padding:6px 10px" onclick="cancelarVenda(' + l.id + ')">Cancelar</button>' : '') +
                '</div>';
            }).join("")
            : '<div style="color:var(--muted);font-size:12px">Você ainda não tem anúncios ativos.</div>';
    } catch(e){}
}

async function cancelarVenda(id){
    try {
        await apiDelete("/api/colecionaveis/listings/" + id);
        toast("Anúncio cancelado. Figurinhas liberadas.", "ok");
        carregarAcervo();
    } catch(e){ toast(e.message, "erro"); }
}

function renderPag(d, alvo){
    const el = document.getElementById(alvo + "Pag");
    if (!d.totalPaginas || d.totalPaginas <= 1) { el.innerHTML = ""; return; }
    const cur = d.pagina || 1;
    let html = '<button class="btn btn-ghost" ' + (cur<=1?'disabled':'') + ' onclick="' + alvo + 'PagGo(' + (cur-1) + ')">←</button>';
    html += '<span>Página ' + cur + ' de ' + d.totalPaginas + '</span>';
    html += '<button class="btn btn-ghost" ' + (cur>=d.totalPaginas?'disabled':'') + ' onclick="' + alvo + 'PagGo(' + (cur+1) + ')">→</button>';
    el.innerHTML = html;
}
function acervoPagGo(p){
    estado.acervo.pagina = p;
    carregarAcervo();
    window.scrollTo({top:0, behavior:"smooth"});
}

/* =========================================================
   PACOTES
========================================================= */
async function carregarPacks(){
    try {
        const d = INFO || await apiGet("/api/colecionaveis/info");
        INFO = d;
        const packs = d.packs || [];
        document.getElementById("packsGrid").innerHTML = packs.map(p =>
            '<div class="pack-card pack-' + esc(p.slug) + '">' +
                '<div class="icone"><img src="' + esc(getPacoteImagem(p.slug)) + '" alt="' + esc(p.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'"><span class="fallback" style="display:none">' + (p.slug==="especial"?"💎":p.slug==="ouro"?"🏆":p.slug==="prata"?"🥈":"🥉") + '</span></div>' +
                '<h3>' + esc(p.name) + '</h3>' +
                '<div class="preco">' + fmtR$(p.price) + ' <small>por pacote</small></div>' +
                '<div class="desc">' + esc(p.description) + '</div>' +
                '<div class="qtd">Contém <b>' + p.sticker_quantity + '</b> figurinhas</div>' +
                '<button class="btn btn-amarelo" onclick="comprarPacote(' + p.id + ')">🎁 ABRIR PACOTINHO</button>' +
            '</div>'
        ).join("");
        /* probabilidades */
        const prob = d.probabilidades || {};
        const rarids = d.raridades || [];
        const ordemProb = ["COMUM","INCOMUM","RARA","EPICA","LENDARIA","MITICA"];
        document.getElementById("probWrap").innerHTML =
            '<h4>🎲 Probabilidades por raridade</h4>' +
            rarids
                .filter(r => r && r.chave)
                .sort((a,b)=>ordemProb.indexOf(a.chave)-ordemProb.indexOf(b.chave))
                .map(r => {
                    const pct = Number(prob[r.chave]) || 0;
                    return '<div class="prob-linha">' +
                        '<span class="nome">' + (r.icone || "") + ' ' + esc(r.nome || r.chave) + '</span>' +
                        '<div class="prob-barra"><div class="fill" style="width:' + pct + '%;background:' + (r.cor || '#888') + '"></div></div>' +
                        '<span class="pct">' + pct.toFixed(1).replace(".",",") + '%</span>' +
                    '</div>';
                }).join("") +
            '<div class="prob-aviso">⚠️ As probabilidades representam as chances de cada figurinha sair em um pacote. Não há garantia de raridade nem promessa de valorização. Colecione por diversão!</div>';
        carregarMeusPacotes();
    } catch(e){
        document.getElementById("packsGrid").innerHTML = '<div style="color:var(--muted);padding:16px">' + esc(e.message) + '</div>';
    }
}

async function carregarMeusPacotes(){
    const box = document.getElementById("meusPacotes");
    if (!box || !minhaConta || !minhaConta.token) { if(box) box.style.display = "none"; return; }
    try {
        const d = await apiGet("/api/colecionaveis/meus-pacotes");
        const pacotes = d.pacotes || [];
        box.style.display = pacotes.length ? "block" : "none";
        if(!pacotes.length) return;
        box.innerHTML = '<h4>🎁 PACOTES NÃO ABERTOS: ' + pacotes.length + '</h4><div class="meus-pacotes-lista">' +
            pacotes.map(p => '<div class="meu-pacote"><img class="meu-pacote-art" src="' + esc(getPacoteImagem(p.nome)) + '" alt="' + esc(p.nome) + '"><span><b>' + esc(p.nome) + '</b><small>' + (p.tipo === "kit" ? "Incluído em KIT" : "Compra confirmada") + '</small></span>' +
                '<button class="btn btn-amarelo" style="margin:0;padding:8px 10px;font-size:11px" onclick="abrirPacoteDisponivel(\'' + p.tipo + '\',' + p.id + ')">ABRIR</button></div>').join("") +
            '</div>';
    } catch(e) { box.style.display = "none"; }
}

async function abrirPacoteDisponivel(tipo, id){
    try {
        const rota = tipo === "kit" ? "/api/colecionaveis/packs/inventory/" + id + "/open" : "/api/colecionaveis/packs/purchases/" + id + "/open";
        const d = await apiPost(rota, {});
        if(!d.ok || !d.pacote) throw new Error(d.error || "Não foi possível abrir o pacote.");
        revelarPacote(Object.assign({}, d.pacote, { aberto: true }));
        carregarMeusPacotes();
    } catch(e) { toast(e.message || "Não foi possível abrir o pacote.", "erro"); }
}

async function comprarPacote(packId){
    if (!exigirLogin()) return;
    const d = INFO || await apiGet("/api/colecionaveis/info");
    INFO = d;
    const pack = (d.packs || []).find(p => p.id === packId);
    abrirModalPagamento("pack", {
        packId,
        nome: pack ? pack.name : "Pacote",
        preco: pack ? pack.price : 0,
        figurinhas: pack ? pack.sticker_quantity : 0,
        categoria: pack ? (pack.slug || pack.name) : null
    });
}

function abrirModalProbabilidades(){
    const d = INFO || {};
    const prob = d.probabilidades || {};
    const raridades = (d.raridades || []).filter(r => r && r.chave);
    const packs = d.packs || [];
    const linhas = raridades.map(r => {
        const pct = Number(prob[r.chave]) || 0;
        return '<div class="prob-linha"><span class="nome">' + (r.icone || "") + ' ' + esc(r.nome || r.chave) + '</span>' +
            '<div class="prob-barra"><div class="fill" style="width:' + pct + '%;background:' + (r.cor || '#888') + '"></div></div>' +
            '<span class="pct">' + pct.toFixed(1).replace('.', ',') + '%</span></div>';
    }).join('');
    document.getElementById("modalBody").innerHTML =
        '<div class="login-panel" style="max-width:620px">' +
        '<h2>🔍 Veja o que pode sair</h2>' +
        '<div class="sub">Cada pacote sorteia figurinhas da coleção. As chances abaixo são por figurinha.</div>' +
        '<div class="prob-wrap" style="margin-top:16px"><h4>🎲 Chances por raridade</h4>' + linhas + '</div>' +
        '<div style="margin-top:16px;color:var(--muted);font-size:12px;line-height:1.5"><b>Pacotes disponíveis:</b> ' +
        packs.map(p => esc(p.name) + ' (' + p.sticker_quantity + ' figurinhas)').join(' · ') +
        '<br>Não há garantia de raridade específica. Colecione por diversão.</div></div>';
    document.getElementById("modalOverlay").classList.remove("hidden");
}

/* =========================================================
   MERCADO
========================================================= */
async function carregarMercado(pag){
    const q = new URLSearchParams({ pagina: pag || estado.mercado.pagina });
    const busca = document.getElementById("mkBusca").value.trim();
    const raridade = document.getElementById("mkRaridade").value;
    if (busca) q.set("busca", busca);
    if (raridade) q.set("raridade", raridade);
    if (estado.mercado.filtroVendedor) q.set("sellerId", estado.mercado.filtroVendedor);
    try {
        const d = await apiGet("/api/colecionaveis/marketplace?" + q.toString());
        estado.mercado.pagina = d.pagina || 1;
        const listings = d.listings || [];
        document.getElementById("mkGrid").innerHTML = listings.length
            ? listings.map(l => listingHtml(l)).join("")
            : '<div style="color:var(--muted);padding:16px">Nenhum anúncio disponível. Seja o primeiro a vender!</div>';
        document.getElementById("mkResultado").textContent = d.totalItems + " anúncio(s)";
        renderPag(d, "mk");
    } catch(e){
        document.getElementById("mkGrid").innerHTML = '<div style="color:var(--muted);padding:16px">' + esc(e.message) + '</div>';
    }
}

function abrirModalNovaOfertaParaUsuario(userId){
    if (!exigirLogin()) return;
    if (!userId) return;
    const meu = meuUsuarioId();
    if (meu != null && Number(userId) === Number(meu)) {
        toast("Você não pode negociar com você mesmo.", "erro");
        return;
    }
    // Verificar elegibilidade do usuário alvo
    apiGet("/api/colecionaveis/colecionador/" + encodeURIComponent(userId))
        .then(d => {
            const perfil = d.perfil;
            if (!perfil) {
                toast("Usuário não encontrado.", "erro");
                return;
            }
            if (perfil.privado) {
                toast("Este usuário não permite negociações diretas.", "erro");
                return;
            }
            // Abre o mercado filtrado pelo vendedor e mostra toast
            estado.mercado.filtroVendedor = userId;
            mudarAba("mercado");
            carregarMercado(1);
            toast("Mercado filtrado pelo vendedor. Escolha uma figurinha e clique em FAZER OFERTA.", "ok");
        })
        .catch(e => {
            toast("Erro ao verificar usuário: " + esc(e.message), "erro");
        });
}
function mkPagGo(p){ carregarMercado(p); window.scrollTo({top:0, behavior:"smooth"}); }

function listingHtml(l){
    const meuId = meuUsuarioId();
    const ehMeu = meuId != null && l.seller_id === meuId;
    const finish = ColecaoUI.finishDeCard({ id: l.card_id, rarity: l.rarity });
    const finishLabel = finish === "ouro" ? "🏆 OURO" : finish === "cromada" ? "🪞 CROMADA" : "NORMAL";
    const resumo = JSON.stringify({
        number: l.number, name: l.name, rarity: l.rarity,
        finish: finishLabel, image_url: l.image_url, seller_nome: l.seller_nome
    }).replace(/"/g, "&quot;");
    const image = l.image_url
        ? '<img src="' + esc(l.image_url) + '" alt="' + esc(l.name) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">'
        : '';
    const total = Math.max(0, Number(l.quantity) || 0);
    const disponivel = Math.max(0, Number(l.disponivel != null ? l.disponivel : total) || 0);
    const reservada = l.reservada === true || disponivel <= 0;
    const badge = reservada
        ? '<span class="listing-badge badge-reservada">🔒 RESERVADA</span>'
        : (disponivel < total ? '<span class="listing-badge badge-parcial">🔒 Parcialmente reservada</span>' : '');
    const btChat = '<button class="btn btn-ghost" onclick="abrirChatAnuncio(' + l.id + ')">💬 CHAT</button>';
    const btComprar = reservada
        ? '<button class="btn btn-laranja" disabled title="Este anúncio está totalmente reservado">🔒 RESERVADA</button>'
        : '<button class="btn btn-laranja" onclick="comprarDoMercado(' + l.id + ',' + l.unit_price + ',' + disponivel + ',' + resumo + ')">COMPRAR</button>';
    const btOferta = '<button class="btn btn-ghost" onclick="abrirModalOferta(' + l.card_id + ',' + l.seller_id + ',' + l.unit_price + ',\'' + esc(l.seller_nome || "") + '\',\'' + esc(l.name || "") + '\')">FAZER OFERTA</button>';

    let acoes;
    if (ehMeu) {
        acoes = '<div class="listing-acoes">' + btChat +
            '<button class="btn btn-ghost" onclick="verInteressados(' + l.id + ')">👀 Ver interessados</button>' +
            '<button class="btn btn-ghost" onclick="cancelarVenda(' + l.id + ')">Meu anúncio — cancelar</button>' +
        '</div>';
    } else {
        acoes = '<div class="listing-acoes">' + btComprar + btOferta + btChat +
            '<button class="btn btn-ghost" onclick="verPerfilColecionador(' + l.seller_id + ')">VER PERFIL</button>' +
        '</div>';
    }

    return '<div class="listing-card' + (reservada ? ' reservada' : '') + '">' +
        '<div class="listing-arte-grande">' + image + '<span class="fallback" style="' + (image ? 'display:none' : '') + '">' + emojiRaridade(l.rarity) + '</span></div>' +
        '<div class="listing-top">' +
            '<div class="info">' +
                '<div class="n">#' + String(l.number).padStart(3,"0") + ' — ' + esc(l.name) + '</div>' +
                '<div class="muted">' + nomeRaridade(l.rarity) + ' • ' + finishLabel + ' • ' + disponivel + ' disponível(is)' + (ehMeu ? ' • <b>seu anúncio</b>' : '') + '</div>' +
            '</div>' +
        '</div>' +
        badge +
        '<div class="listing-preco">' + fmtR$(l.unit_price) + ' <small>/ cada</small></div>' +
        '<div class="listing-vendedor">Vendedor: ' + esc(l.seller_nome || "—") + '</div>' +
        acoes +
    '</div>';
}
function verInteressados(listingId){
    abrirChatAnuncio(listingId);
}

/* =========================================================
   OFERTAS (FAZER OFERTA / NEGOCIAÇÃO)
========================================================= */
function fmtR$(v){
    return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function abrirModalOferta(cardId, offereeId, valorAnunciado, vendedorNome, figurinhaNome){
    if (!exigirLogin()) return;
    document.getElementById("modalBody").innerHTML =
        '<h2>💰 Fazer oferta</h2>' +
        '<div class="modal-form">' +
            '<label>Figurinha</label><div class="campo"><b>#' + String(cardId).padStart(3,"0") + ' ' + esc(figurinhaNome || "") + '</b></div>' +
            '<label>Vendedor</label><div class="campo">' + esc(vendedorNome || "—") + '</div>' +
            '<label>Valor anunciado</label><div class="campo">' + fmtR$(valorAnunciado || 0) + '</div>' +
            '<label>Quantidade</label><input id="ofertaQuantidade" type="number" min="1" max="99" value="1">' +
            '<label>Sua oferta (R$)</label><input id="ofertaValor" type="number" min="0.01" step="0.01" value="' + Number(valorAnunciado || 0).toFixed(2) + '">' +
            '<label>Mensagem (opcional)</label><textarea id="ofertaMensagem" maxlength="500" rows="3" placeholder="Ex.: posso fechar por esse valor?"></textarea>' +
            '<button class="btn btn-amarelo" onclick="enviarOferta(' + cardId + ',' + offereeId + ')">ENVIAR OFERTA</button>' +
            '<button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>' +
        '</div>';
    document.getElementById("modalOverlay").classList.remove("hidden");
}

async function enviarOferta(cardId, offereeId){
    try {
        const quantidade = Math.max(1, Math.floor(Number(document.getElementById("ofertaQuantidade").value) || 1));
        const valor = Number(document.getElementById("ofertaValor").value);
        const mensagem = document.getElementById("ofertaMensagem").value;
        if (!isFinite(valor) || valor <= 0) { toast("Informe um valor de oferta válido.", "erro"); return; }
        await apiPost("/api/colecionaveis/offers", { cardId, offereeId, quantidade, valor, mensagem });
        toast("Oferta enviada!", "ok");
        fecharModal();
        carregarOfertas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

async function carregarOfertas(){
    const grid = document.getElementById("ofertasGrid");
    if (!grid) return;
    if (!exigirLogin()) { grid.innerHTML = ""; return; }
    try {
        const d = await apiGet("/api/colecionaveis/offers/mine");
        const recebidas = d.recebidas || [];
        const enviadas = d.enviadas || [];
        const ctr = document.getElementById("abaOfertasContador");
        if (ctr) ctr.textContent = recebidas.length ? " " + recebidas.length : "";
        const totalPend = recebidas.filter(o => o.status === "PENDENTE").length;
        const pendBadge = document.getElementById("ofertasPendentes");
        if (pendBadge) pendBadge.textContent = totalPend ? totalPend + " oferta(s) pendente(s)" : "";
        
        // Layout melhorado com seções claras
        grid.innerHTML =
            '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">' +
                '<div style="flex:1;min-width:200px;background:var(--painel);border:2px solid var(--borda);border-radius:10px;padding:12px;text-align:center">' +
                    '<div style="font-size:24px;font-weight:900;color:var(--amarelo)">' + recebidas.length + '</div>' +
                    '<div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">📥 Recebidas</div>' +
                '</div>' +
                '<div style="flex:1;min-width:200px;background:var(--painel);border:2px solid var(--borda);border-radius:10px;padding:12px;text-align:center">' +
                    '<div style="font-size:24px;font-weight:900;color:var(--amarelo)">' + enviadas.length + '</div>' +
                    '<div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">📤 Enviadas</div>' +
                '</div>' +
            '</div>' +
            '<div class="secao-titulo" style="font-size:16px;font-weight:800;color:#fff;margin:16px 0 10px;padding-bottom:8px;border-bottom:2px solid var(--borda)">📥 OFERTAS RECEBIDAS</div>' +
            (recebidas.length ? recebidas.map(o => renderOfertaHtml(o, true)).join("") : '<div class="vazio" style="text-align:center;padding:20px;color:var(--muted)">Nenhuma oferta recebida ainda.</div>') +
            '<div class="secao-titulo" style="font-size:16px;font-weight:800;color:#fff;margin:20px 0 10px;padding-bottom:8px;border-bottom:2px solid var(--borda)">📤 OFERTAS ENVIADAS</div>' +
            (enviadas.length ? enviadas.map(o => renderOfertaHtml(o, false)).join("") : '<div class="vazio" style="text-align:center;padding:20px;color:var(--muted)">Nenhuma oferta enviada ainda.</div>');
    } catch(e){ grid.innerHTML = '<div class="vazio">' + msgErro(e) + '</div>'; }
}

function renderOfertaHtml(o, recebida){
    const cardLabel = '#' + String(o.card_number || o.card_id).padStart(3,"0") + ' ' + esc(o.card_name || "");
    const imagem = imagemOfertaUrl(o);
    const parceiro = recebida ? esc(o.offeror_nome || "—") : esc(o.offeree_nome || "—");
    const rotuloStatus = {
        PENDENTE:"🕐 Pendente", ACEITA:"✅ Aceita", RECUSADA:"❌ Recusada",
        CANCELADA:"🚫 Cancelada", EXPIRADA:"⏳ Expirada", CONCLUIDA:"🎉 Concluída",
        CONTRAPROPOSTA:"↻ Contraproposta", AGUARDANDO_PAGAMENTO:"💳 Aguardando pagamento",
        PAGA:"💳 Paga"
    };
    const status = rotuloStatus[o.status] || o.status;
    const statusCor = {
        PENDENTE: "#ffa500", ACEITA: "#45d66f", RECUSADA: "#ff4d4d",
        CANCELADA: "#888", EXPIRADA: "#888", CONCLUIDA: "#45d66f",
        CONTRAPROPOSTA: "#ffa500", AGUARDANDO_PAGAMENTO: "#ffa500", PAGA: "#45d66f"
    };
    const corStatus = statusCor[o.status] || "#888";
    
    const botaoPagar = '<button class="btn btn-amarelo" onclick="pagarOferta(' + o.id + ',' + Number(o.amount || 0).toFixed(2) + ',\'' + esc(o.card_name || "") + '\')" style="width:100%">💳 PAGAR OFERTA</button>';
    let acoes = "";
    if (recebida && o.status === "PENDENTE") {
        acoes = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
            '<button class="btn btn-amarelo" onclick="aceitarOferta(' + o.id + ')" style="flex:1;min-width:100px">✓ Aceitar</button>' +
            '<button class="btn btn-ghost" onclick="recusarOferta(' + o.id + ')" style="flex:1;min-width:100px">Recusar</button>' +
            '<button class="btn btn-ghost" onclick="contraporOferta(' + o.id + ')" style="flex:1;min-width:100px">↻ Contrapor</button>' +
            '</div>';
    } else if (!recebida && o.status === "PENDENTE") {
        acoes = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
            '<button class="btn btn-ghost" onclick="cancelarOferta(' + o.id + ')" style="flex:1">Cancelar oferta</button>' +
            '</div>';
    } else if (!recebida && (o.status === "ACEITA" || o.status === "AGUARDANDO_PAGAMENTO")) {
        acoes = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
            botaoPagar +
            '<button class="btn btn-ghost" onclick="cancelarOferta(' + o.id + ')" style="flex-shrink:0">Cancelar</button>' +
            '</div>';
    } else if (!recebida && o.status === "CONTRAPROPOSTA") {
        acoes = '<div style="font-size:12px;color:var(--muted);margin-top:8px;padding:8px;background:rgba(255,165,0,0.1);border-radius:8px">↻ A outra parte contrapropôs. Veja a nova oferta recebida em <b>Recebidas</b>.</div>';
    } else if (o.status === "PAGA") {
        acoes = '<div style="font-size:12px;color:var(--verde);margin-top:8px;padding:8px;background:rgba(69,214,111,0.1);border-radius:8px">✅ Pagamento confirmado. A figurinha será liberada ao vendedor confirmar a conclusão.</div>';
    }
    
    const arte = imagem
        ? '<img src="' + esc(imagem) + '" alt="' + esc(o.card_name || "Figurinha") + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">' +
          '<span class="fallback" style="display:none">' + emojiRaridade(o.card_rarity) + '</span>'
        : '<span class="fallback">' + emojiRaridade(o.card_rarity) + '</span>';
    return '<div class="oferta-card">' +
        '<div class="oferta-card-arte">' + arte + '</div>' +
        '<div class="oferta-card-body">' +
            '<div class="oferta-card-head">' +
                '<div>' +
                    '<div class="oferta-card-title">' + cardLabel + '</div>' +
                    '<div class="oferta-card-sub">' + (recebida ? "📥 Recebida de " : "📤 Enviada para ") + parceiro + '</div>' +
                '</div>' +
                '<div class="oferta-card-status" style="color:' + corStatus + '">' + status + '</div>' +
            '</div>' +
            '<div class="oferta-card-meta"><div><span>Quantidade:</span> <b>' + quantidadeOferta(o.quantity) + '</b></div><div><span>Valor:</span> <b class="valor">' + fmtR$(o.amount) + '</b></div></div>' +
            (o.message ? '<div style="font-size:12px;color:var(--muted);font-style:italic;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:8px;overflow-wrap:anywhere">"' + esc(o.message) + '"</div>' : '') +
            '<div class="oferta-card-actions">' + acoes.replace(/^<div[^>]*>|<\/div>$/g, "") + '</div>' +
        '</div>' +
    '</div>';
}

function imagemOfertaUrl(o){
    const imagens = window.ANIMAIS_DADOS && window.ANIMAIS_DADOS.IMAGENS_ANIMAIS;
    if (!imagens) return "";
    if (o && o.image_url) return o.image_url;
    if (o && o.card_name && imagens[o.card_name]) return imagens[o.card_name];
    const numero = Number(o && o.card_number);
    return numero > 0 ? (Object.values(imagens)[numero - 1] || "") : "";
}

function quantidadeOferta(q){ return Number(q || 1) + "x"; }

/* ===== NOTIFICAÇÕES ===== */
let notificacoesSource = null;

async function carregarNotificacoes(){
    try {
        const d = await apiGet("/api/notificacoes");
        const badge = document.getElementById("notificacoesBadge");
        if (badge) {
            if (d.naoLidas > 0) {
                badge.textContent = d.naoLidas > 99 ? "99+" : d.naoLidas;
                badge.style.display = "flex";
            } else {
                badge.style.display = "none";
            }
        }
        return d;
    } catch(e){ 
        console.error("Erro ao carregar notificações:", e);
        return { notificacoes: [], naoLidas: 0 };
    }
}

function iniciarSSENotificacoes(){
    if (notificacoesSource) {
        notificacoesSource.close();
    }
    
    const token = minhaConta && minhaConta.token;
    if (!token) return;
    
    try {
        notificacoesSource = new EventSource("/api/notificacoes/stream?token=" + encodeURIComponent(token));
        
        notificacoesSource.onmessage = function(event) {
            try {
                const notificacao = JSON.parse(event.data);
                // Atualizar badge imediatamente
                carregarNotificacoes();
                // Mostrar toast opcional
                if (typeof toast === "function") {
                    toast(notificacao.titulo || "Nova notificação", "ok");
                }
            } catch(e) {
                console.error("Erro ao processar notificação SSE:", e);
            }
        };
        
        notificacoesSource.onerror = function() {
            // EventSource reconecta automaticamente
            console.log("SSE notificações: reconectando...");
        };
    } catch(e) {
        console.error("Erro ao iniciar SSE notificações:", e);
    }
}

function pararSSENotificacoes(){
    if (notificacoesSource) {
        notificacoesSource.close();
        notificacoesSource = null;
    }
}

async function abrirPainelNotificacoes(){
    if (!exigirLogin()) return;
    const d = await carregarNotificacoes();
    const notificacoes = d.notificacoes || [];
    
    let html = '<h2>🔔 NOTIFICAÇÕES</h2>';
    
    if (!notificacoes.length) {
        html += '<div style="text-align:center;padding:40px 20px;color:var(--muted)">Nenhuma notificação ainda.</div>';
    } else {
        html += '<div style="margin-bottom:12px">';
        html += '<button class="btn btn-ghost" onclick="marcarTodasLidas()" style="width:100%">✓ Marcar todas como lidas</button>';
        html += '</div>';
        
        const icones = {
            oferta_recebida: "📥",
            oferta_aceita: "✅",
            oferta_recusada: "❌",
            oferta_cancelada: "🚫",
            nova_mensagem: "💬",
            pagamento_aprovado: "💳",
            figurinha_recebida: "🎁",
            nova_meta: "🏆",
            album_proximo: "📊",
            bloco_publicado: "🗺️"
        };
        
        for (const n of notificacoes) {
            const icone = icones[n.tipo] || "🔔";
            const lida = n.lida_em ? "opacity:0.6" : "";
            const tempo = new Date(n.criado_em).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
            
            html += '<div style="background:var(--painel);border:2px solid ' + (n.lida_em ? "var(--borda)" : "var(--amarelo)") + ';border-radius:10px;padding:12px;margin-bottom:10px;' + lida + '" onclick="marcarLida(' + n.id + ')">';
            html += '<div style="display:flex;gap:10px;align-items:flex-start">';
            html += '<div style="font-size:24px">' + icone + '</div>';
            html += '<div style="flex:1;min-width:0">';
            html += '<div style="font-weight:800;color:#fff;margin-bottom:4px">' + esc(n.titulo) + '</div>';
            html += '<div style="font-size:13px;color:var(--muted);margin-bottom:6px">' + esc(n.mensagem) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted)">' + tempo + '</div>';
            html += '</div>';
            if (!n.lida_em) {
                html += '<div style="width:8px;height:8px;background:var(--amarelo);border-radius:50%;flex-shrink:0"></div>';
            }
            html += '</div>';
            html += '</div>';
        }
    }
    
    document.getElementById("modalOverlay").classList.remove("hidden");
    document.getElementById("modalBody").innerHTML = html;
}

async function marcarLida(id){
    try {
        await apiPost("/api/notificacoes/" + id + "/lida", {});
        abrirPainelNotificacoes();
    } catch(e){ console.error("Erro ao marcar notificação:", e); }
}

async function marcarTodasLidas(){
    try {
        await apiPost("/api/notificacoes/lidas", {});
        abrirPainelNotificacoes();
        carregarNotificacoes();
    } catch(e){ console.error("Erro ao marcar todas:", e); }
}

function iniciarPollingNotificacoes(){
    // Usar SSE em vez de polling
    iniciarSSENotificacoes();
    // Fazer load inicial
    carregarNotificacoes();
}

async function aceitarOferta(offerId){
    try {
        const d = await apiPost("/api/colecionaveis/offers/" + offerId + "/accept", {});
        toast(d.mensagem || "Oferta aceita!", "ok");
        carregarOfertas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

async function recusarOferta(offerId){
    try {
        const d = await apiPost("/api/colecionaveis/offers/" + offerId + "/decline", {});
        toast(d.mensagem || "Oferta recusada.", "ok");
        carregarOfertas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

async function cancelarOferta(offerId){
    try {
        const d = await apiPost("/api/colecionaveis/offers/" + offerId + "/cancel", {});
        toast(d.mensagem || "Oferta cancelada.", "ok");
        carregarOfertas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

function contraporOferta(offerId){
    document.getElementById("modalBody").innerHTML =
        '<h2>🔄 Contraproposta</h2>' +
        '<div class="modal-form">' +
            '<label>Quantidade</label><input id="cpQuantidade" type="number" min="1" max="99" value="1">' +
            '<label>Seu valor (R$)</label><input id="cpValor" type="number" min="0.01" step="0.01" value="0.00">' +
            '<label>Mensagem (opcional)</label><textarea id="cpMensagem" maxlength="500" rows="3" placeholder="Ex.: posso fechar nesse valor?"></textarea>' +
            '<button class="btn btn-amarelo" onclick="enviarContraproposta(' + offerId + ')">Enviar contraproposta</button>' +
            '<button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>' +
        '</div>';
    document.getElementById("modalOverlay").classList.remove("hidden");
}

async function enviarContraproposta(offerId){
    try {
        const quantidade = Math.max(1, Math.floor(Number(document.getElementById("cpQuantidade").value) || 1));
        const valor = Number(document.getElementById("cpValor").value);
        const mensagem = document.getElementById("cpMensagem").value;
        if (!isFinite(valor) || valor <= 0) { toast("Informe um valor válido.", "erro"); return; }
        await apiPost("/api/colecionaveis/offers/" + offerId + "/counter", { quantidade, valor, mensagem });
        toast("Contraproposta enviada!", "ok");
        fecharModal();
        carregarOfertas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

function pagarOferta(offerId, valor, figurinhaNome){
    if (!exigirLogin()) return;
    abrirModalPagamento("oferta", { offerId, preco: valor, nome: figurinhaNome, quantidade: 1 });
}

async function comprarDoMercado(listingId, preco, qtdDisp, detalhe){
    if (!exigirLogin()) return;
    abrirModalPagamento("mercado", Object.assign({ listingId, preco, qtdDisp }, detalhe || {}));
}

async function abrirChatAnuncio(listingId, buyerId){
    if (!exigirLogin()) return;
    try {
        const query = buyerId ? "?buyerId=" + encodeURIComponent(buyerId) + "&marcarLido=1" : "?marcarLido=1";
        const d = await apiGet("/api/colecionaveis/listings/" + listingId + "/chat" + query);
        const ctx = d.contexto || {};
        let html = '<h2>💬 NEGOCIAR ANÚNCIO #' + listingId + '</h2>';

        /* Vendedor sem interessado escolhido: lista de interessados. */
        if (d.interessados) {
            html += d.interessados.length
                ? '<div class="desc">Selecione o interessado para conversar:</div>' +
                  '<div style="display:flex;flex-direction:column;gap:8px;margin:10px 0">' +
                    d.interessados.map(i => '<button class="btn btn-ghost" style="text-align:left" onclick="abrirChatAnuncio(' + listingId + ',' + i.id + ')">👤 ' + esc(i.nome) + '</button>').join("") +
                  '</div>'
                : '<div class="desc">Nenhum interessado ainda. O botão 💬 CHAT aparece para quem visitar seu anúncio.</div>';
            html += '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>';
            document.getElementById("modalBody").innerHTML = html;
            document.getElementById("modalOverlay").classList.remove("hidden");
            return;
        }

        /* Contexto do anúncio. */
        const resumo = JSON.stringify({
            number: ctx.numero, name: ctx.nome, rarity: ctx.raridade,
            finish: "NORMAL", image_url: ctx.imagem, seller_nome: ctx.vendedorNome
        }).replace(/"/g, "&quot;");
        html += '<div class="chat-contexto">' +
            '<div class="mini-arte">' + (ctx.imagem
                ? '<img src="' + esc(ctx.imagem) + '" alt="" onerror="this.style.display=\'none\';this.parentNode.innerHTML=\'' + emojiRaridade(ctx.raridade) + '\'">'
                : emojiRaridade(ctx.raridade)) + '</div>' +
            '<div class="info">' +
                '<div class="n">#' + String(ctx.numero || "").padStart(3,"0") + ' — ' + esc(ctx.nome || "") + '</div>' +
                '<div class="muted">' + nomeRaridade(ctx.raridade) + ' • ' + fmtR$(ctx.preco) + '/cada</div>' +
                '<div class="muted">Vendedor: ' + esc(ctx.vendedorNome || "—") + '</div>' +
            '</div>' +
        '</div>';

        if (d.oferta) {
            const rotulo = { PENDENTE:"🕐 Pendente", ACEITA:"✅ Aceita", RECUSADA:"❌ Recusada", CANCELADA:"🚫 Cancelada", EXPIRADA:"⏳ Expirada", CONTRAPROPOSTA:"↻ Contraproposta", AGUARDANDO_PAGAMENTO:"💳 Aguardando pagamento", PAGA:"💳 Paga", CONCLUIDA:"🎉 Concluída" };
            html += '<div class="chat-oferta">🤝 Oferta: ' + fmtR$(d.oferta.valor) + ' · ' + (rotulo[d.oferta.status] || d.oferta.status) + ' — <a href="#" onclick="carregarOfertas();fecharModal();return false">ver ofertas</a></div>';
        }

        html += '<div class="chat-box" id="listingChatMessages" style="max-height:40vh">' +
            (d.messages && d.messages.length
                ? d.messages.map(m => '<div class="chat-msg ' + (m.author_id === meuUsuarioId() ? "minha" : "deles") + '"><span class="quem">' + esc(m.autor_nome || "") + '</span>' + esc(m.text) + '</div>').join("")
                : '<div style="font-size:12px;color:var(--muted);padding:6px 2px">Nenhuma mensagem ainda. Dê o primeiro passo!</div>') +
        '</div>';

        if (ctx.ehVendedor !== true) {
            html += '<div class="chat-acoes">' +
                '<button class="btn btn-laranja" onclick="comprarDoMercado(' + ctx.listingId + ',' + ctx.preco + ',' + (ctx.quantidadeDisponivel || 1) + ',' + resumo + ')">COMPRAR</button>' +
                '<button class="btn btn-ghost" onclick="abrirModalOferta(' + ctx.cardId + ',' + ctx.vendedorId + ',' + ctx.preco + ',\'' + esc(ctx.vendedorNome || "") + '\',\'' + esc(ctx.nome || "") + '\')">FAZER OFERTA</button>' +
            '</div>';
        }

        html += '<div class="chat-input">' +
            '<input id="listingChatInput" maxlength="500" placeholder="Escreva sua mensagem..." onkeydown="if(event.key===\'Enter\')enviarChatAnuncio(' + listingId + ',' + d.buyerId + ')">' +
            '<button class="btn btn-laranja" onclick="enviarChatAnuncio(' + listingId + ',' + d.buyerId + ')">ENVIAR</button>' +
        '</div>';
        html += '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>';

        document.getElementById("modalBody").innerHTML = html;
        document.getElementById("modalOverlay").classList.remove("hidden");
        const box = document.getElementById("listingChatMessages");
        if (box) box.scrollTop = box.scrollHeight;
        const inp = document.getElementById("listingChatInput");
        if (inp) inp.focus();
    } catch(e) { toast(e.message, "erro"); }
}

async function enviarChatAnuncio(listingId, buyerId){
    const input = document.getElementById("listingChatInput");
    const text = input ? input.value.trim() : "";
    if(!text) return;
    try { await apiPost("/api/colecionaveis/listings/" + listingId + "/chat", { text, buyerId }); await abrirChatAnuncio(listingId, buyerId); }
    catch(e) { toast(e.message, "erro"); }
}

/* Lista de conversas do usuário (vendedor ou comprador). */
async function abrirMeusChats(){
    if (!exigirLogin()) return;
    try {
        const d = await apiGet("/api/colecionaveis/chat/conversas");
        const convs = d.conversas || [];
        let html = '<h2>💬 MEUS CHATS</h2>';
        if (!convs.length) {
            html += '<div class="desc">Nenhuma conversa ainda. Inicie um chat pelo botão 💬 CHAT em um anúncio.</div>';
        } else {
            html += '<div style="display:flex;flex-direction:column;gap:8px;margin:12px 0;max-height:50vh;overflow-y:auto">' +
                convs.map(c => {
                    const label = '#' + String(c.numero).padStart(3,"0") + ' ' + esc(c.nome) +
                        (c.souVendedor ? ' — 👤 ' + esc(c.compradorNome || "comprador") : ' — ' + esc(c.vendedorNome || "vendedor"));
                    const badge = c.naoLidas ? ' <span class="chat-naolidas">' + c.naoLidas + ' nova(s)</span>' : "";
                    return '<button class="btn btn-ghost" style="text-align:left;white-space:normal" onclick="abrirChatAnuncio(' + c.listingId + ',' + c.buyerId + ')">' + label + badge + '</button>';
                }).join("") +
            '</div>';
        }
        html += '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>';
        document.getElementById("modalBody").innerHTML = html;
        document.getElementById("modalOverlay").classList.remove("hidden");
    } catch(e){ toast(e.message, "erro"); }
}

async function verPerfilColecionador(usuarioId){
    try {
        const d = await apiGet("/api/colecionaveis/colecionador/" + usuarioId);
        const p = d.perfil || {};
        document.getElementById("modalBody").innerHTML = '<h2>👤 ' + esc(p.nome || "Colecionador") + '</h2>' +
            '<div class="perfil-stats" style="margin:12px 0"><div class="stat-box"><div class="v">' + (p.diferentes || 0) + '</div><div class="l">DIFERENTES</div></div><div class="stat-box"><div class="v">' + (p.total || 0) + '</div><div class="l">FIGURINHAS</div></div><div class="stat-box"><div class="v">' + (p.vendas || 0) + '</div><div class="l">VENDAS</div></div></div>' +
            '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>';
        document.getElementById("modalOverlay").classList.remove("hidden");
    } catch(e) { toast(e.message, "erro"); }
}

async function enviarChatAnuncio(listingId, buyerId){
    const input = document.getElementById("listingChatInput");
    const text = input ? input.value.trim() : "";
    if(!text) return;
    try { await apiPost("/api/colecionaveis/listings/" + listingId + "/chat", { text, buyerId }); await abrirChatAnuncio(listingId, buyerId); }
    catch(e) { toast(e.message, "erro"); }
}

/* =========================================================
   LEILÕES
========================================================= */
async function carregarLeiloes(){
    try {
        const d = await apiGet("/api/colecionaveis/auctions");
        const lista = d.auctions || [];
        document.getElementById("leiloesGrid").innerHTML = lista.length ? lista.map(leilaoHtml).join("") :
            '<div style="color:var(--muted);padding:16px">Nenhum leilão ativo.</div>';
    } catch(e) { document.getElementById("leiloesGrid").innerHTML = '<div style="color:var(--muted);padding:16px">' + esc(e.message) + '</div>'; }
}
function leilaoHtml(a){
    const meuId = meuUsuarioId();
    const meu = meuId != null && a.seller_id === meuId;
    const vencedor = meuId != null && a.winner_id === meuId;
    const valor = a.current_bid == null ? a.minimum_bid : Number(a.current_bid) + 0.01;
    const arte = a.image_url ? '<img src="' + esc(a.image_url) + '" alt="' + esc(a.name) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">' + '<span class="fallback" style="display:none">' + emojiRaridade(a.rarity) + '</span>' : '<span class="fallback">' + emojiRaridade(a.rarity) + '</span>';
    return '<div class="listing-card"><div class="listing-arte-grande">' + arte + '</div>' +
        '<div class="listing-top"><div class="info"><div class="n">#' + String(a.number).padStart(3,"0") + ' — ' + esc(a.name) + '</div>' +
        '<div class="muted">' + nomeRaridade(a.rarity) + ' • ' + a.bid_count + ' lance(s) • ' + esc(a.seller_nome || "—") + '</div></div></div>' +
        '<div class="listing-preco">' + fmtR$(a.current_bid == null ? a.minimum_bid : a.current_bid) + ' <small>' + (a.current_bid == null ? 'lance mínimo' : 'lance atual') + '</small></div>' +
        '<div class="muted">Encerra: ' + new Date(a.ends_at).toLocaleString() + ' • ' + esc(a.status) + '</div>' +
        (a.status === "active" && !meu ? '<button class="btn btn-laranja" onclick="darLance(' + a.id + ',' + valor + ')">DAR LANCE (' + fmtR$(valor) + ')</button>' : '') +
        (meu && a.status === "active" ? '<button class="btn btn-ghost" onclick="encerrarLeilaoUI(' + a.id + ')">ENCERRAR</button>' : '') +
        (vencedor && a.status === "payment_pending" ? '<button class="btn btn-amarelo" onclick="pagarLeilao(' + a.id + ',' + Number(a.current_bid || 0) + ')">💳 PAGAR LANCE</button>' : '') +
        '</div>';
}
function pagarLeilao(id, valor){
    if (!exigirLogin()) return;
    abrirModalPagamento("auction", { auctionId: id, valor });
}
async function darLance(id, sugerido){
    if (!exigirLogin()) return;
    const valor = prompt("Informe seu lance (mínimo " + fmtR$(sugerido) + "):", Number(sugerido).toFixed(2));
    if (valor === null) return;
    try { await apiPost("/api/colecionaveis/auctions/" + id + "/bids", { amount: Number(valor) }); toast("Lance registrado. Pagamento só será tratado após o encerramento.", "ok"); carregarLeiloes(); }
    catch(e) { toast(e.message, "erro"); }
}
async function criarLeilaoPrompt(){
    if (!exigirLogin()) return;
    const cardId = prompt("ID da figurinha no acervo:");
    const minimo = prompt("Lance mínimo (R$):", "1.00");
    if (cardId === null || minimo === null) return;
    try { await apiPost("/api/colecionaveis/auctions", { cardId: Number(cardId), minimumBid: Number(minimo) }); toast("Leilão criado e unidade reservada.", "ok"); carregarLeiloes(); carregarAcervo(); }
    catch(e) { toast(e.message, "erro"); }
}
async function encerrarLeilaoUI(id){
    if (!confirm("Encerrar este leilão? O vencedor ficará com pagamento pendente.")) return;
    try { const d = await apiPost("/api/colecionaveis/auctions/" + id + "/close", {}); toast(d.status === "payment_pending" ? "Encerrado: pagamento do vencedor pendente." : "Leilão encerrado e unidade liberada.", "ok"); carregarLeiloes(); carregarAcervo(); }
    catch(e) { toast(e.message, "erro"); }
}

/* =========================================================
   TROCAS
========================================================= */
async function carregarTrocas(){
    if (!exigirLogin()) return;
    try {
        const d = await apiGet("/api/colecionaveis/trades/mine");
        const trades = d.trades || [];
        document.getElementById("tradesGrid").innerHTML = trades.length
            ? trades.map(tradeHtml).join("")
            : '<div style="color:var(--muted);padding:16px">Você ainda não participa de nenhuma negociação.</div>';
    } catch(e){
        document.getElementById("tradesGrid").innerHTML = '<div style="color:var(--muted);padding:16px">' + esc(e.message) + '</div>';
    }
}

function tradeHtml(t){
    const meuId = meuUsuarioId();
    const items = t.items || [];
    const minhas = meuId != null ? items.filter(i => i.owner_id === meuId) : [];
    const delas = meuId != null ? items.filter(i => i.owner_id !== meuId) : [];
    const euSouProposer = meuId != null && t.proposer_id === meuId;
    const elegivelAceitar = !euSouProposer && (t.status === "PENDING" || t.status === "COUNTER_OFFER");
    const elegivelContra = euSouProposer && (t.status === "PENDING" || t.status === "COUNTER_OFFER");
    const elegivelCancelar = euSouProposer && ["PENDING","COUNTER_OFFER"].includes(t.status);
    const elegivelDeclinar = !euSouProposer && (t.status === "PENDING" || t.status === "COUNTER_OFFER");

    return '<div class="trade-card">' +
        '<div class="trade-top">' +
            '<div class="vs">🤝 Negociação #' + t.id + '</div>' +
            '<div class="trade-status ts-' + t.status + '">' + statusTxt(t.status) + '</div>' +
        '</div>' +
        '<div class="trade-lado"><div class="label">' + esc(t.proposer_nome || "Proponente") + ' oferece</div>' +
            (minhas.length ? minhas.map(figHtml).join("") : '<span style="font-size:12px;color:var(--muted)">—</span>') +
        '</div>' +
        '<div class="trade-lado"><div class="label">' + esc(t.receiver_nome || "Destinatário") + ' oferece</div>' +
            (delas.length ? delas.map(figHtml).join("") : '<span style="font-size:12px;color:var(--muted)">—</span>') +
        '</div>' +
        (Number(t.cash_amount) > 0
            ? '<div class="trade-dinheiro">💵 Diferença: ' + fmtR$(t.cash_amount) + ' (' + (t.cash_direction === "proposer_pays" ? "proponente paga" : "destinatário paga") + ')</div>'
            : '') +
        '<div class="trade-exp">⏳ Expira em: ' + fmtData(t.expires_at) + '</div>' +
        '<div class="chat-box" id="chat-' + t.id + '">' +
            (t.messages || []).map(m => chatMsgHtml(m)).join("") +
            '<div style="font-size:11px;color:var(--muted)">' + esc(t.history || "") + '</div>' +
        '</div>' +
        '<div class="chat-input">' +
            '<input placeholder="Escrever mensagem..." onkeydown="if(event.key===\'Enter\')enviarMsg(' + t.id + ',this.value,this)">' +
            '<button class="btn btn-ghost" onclick="enviarMsg(' + t.id + ',this.previousElementSibling.value,this.previousElementSibling)">➤</button>' +
        '</div>' +
        '<div class="trade-acoes">' +
            (elegivelAceitar ? '<button class="btn btn-amarelo" onclick="aceitarTroca(' + t.id + ')">✓ Aceitar</button>' : '') +
            (elegivelContra ? '<button class="btn btn-laranja" onclick="abrirContraproposta(' + t.id + ')">↻ Contrapropor</button>' : '') +
            (elegivelDeclinar ? '<button class="btn btn-ghost" onclick="declinarTroca(' + t.id + ')">✕ Recusar</button>' : '') +
            (elegivelCancelar ? '<button class="btn btn-ghost" onclick="cancelarTroca(' + t.id + ')">Cancelar</button>' : '') +
        '</div>' +
    '</div>';
}
function figHtml(i){
    const r = (i.rarity || "COMUM");
    return '<span class="mini-fig"><span class="emoji">' + emojiRaridade(r) + '</span>#' + String(i.number||i.card_id).padStart(3,"0") + ' ' + esc(i.name||"") + '</span>';
}
function chatMsgHtml(m){
    const minha = meuUsuarioId() === m.usuario_id;
    return '<div class="chat-msg ' + (minha ? "minha" : "deles") + '">' +
        '<div class="quem">' + esc(m.autor_nome || "") + '</div>' + esc(m.text) + '</div>';
}
function statusTxt(s){
    return { PENDING:"PENDENTE", COUNTER_OFFER:"CONTRA-PROPOSTA", ACCEPTED:"ACEITA", WAITING_PAYMENT:"AGUARDANDO PAGAMENTO",
             PAID:"PAGA", PROCESSING:"PROCESSANDO", COMPLETED:"CONCLUÍDA", DECLINED:"RECUSADA", CANCELLED:"CANCELADA",
             EXPIRED:"EXPIRADA", DISPUTED:"EM DISPUTA" }[s] || s;
}
function fmtData(d){
    try {
        return new Date(d).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
    } catch(e){ return d; }
}

async function enviarMsg(tradeId, texto, input){
    if (!exigirLogin()) return;
    if (!texto || !texto.trim()) return;
    try {
        await apiPost("/api/colecionaveis/trades/" + tradeId + "/messages", { text: texto.trim() });
        input.value = "";
        carregarTrocas();
    } catch(e){ toast(e.message, "erro"); }
}
async function aceitarTroca(tradeId){
    if (!exigirLogin()) return;
    try {
        const d = await apiPost("/api/colecionaveis/trades/" + tradeId + "/accept", {});
        if (d.status === "WAITING_PAYMENT") {
            toast("Negociação aceita! Pague a diferença para concluir.", "info");
            abrirModalPagamento("trade", { tradeId, externalReference: d.externalReference, valor: d.cash_amount });
        } else {
            toast("Troca concluída com sucesso!", "ok");
            carregarTrocas();
            carregarAlbum();
        }
    } catch(e){ toast(e.message, "erro"); }
}
async function declinarTroca(tradeId){
    try { await apiPost("/api/colecionaveis/trades/" + tradeId + "/decline", {}); toast("Troca recusada.", "info"); carregarTrocas(); }
    catch(e){ toast(e.message, "erro"); }
}
async function cancelarTroca(tradeId){
    try { await apiPost("/api/colecionaveis/trades/" + tradeId + "/cancel", {}); toast("Troca cancelada.", "info"); carregarTrocas(); }
    catch(e){ toast(e.message, "erro"); }
}

async function abrirContraproposta(tradeId){
    try {
        const d = await apiGet("/api/colecionaveis/trades/" + tradeId);
        const meuAcervo = await apiGet("/api/colecionaveis/acervo?pagina=1");
        estado.modoTroca = { tradeId, tipo: "contra" };
        abrirModalTrocaCom(d.trade, meuAcervo.cards);
    } catch(e){ toast(e.message, "erro"); }
}

/* =========================================================
   MODAL FIGURINHA
========================================================= */
async function abrirModalFigurinha(cardId){
    const overlay = document.getElementById("modalOverlay");
    const corpo = document.getElementById("modalBody");
    try {
        const d = await apiGet("/api/colecionaveis/figurinha/" + cardId);
        const c = d.card;
        const r = c.rarity;
        overlay.classList.remove("hidden");
        document.getElementById("modalArte").outerHTML = cardModalArte(c);

        let html = '<div class="num">#' + String(c.number).padStart(3,"0") + ' • ' + nomeRaridade(r) + '</div>';
        html += '<h2>' + esc(c.name) + '</h2>';
        html += (c.scientific_name
            ? '<div style="font-size:12px;font-style:italic;color:var(--muted);text-align:center;margin-bottom:4px">' + esc(c.scientific_name) + '</div>'
            : "");
        html += (c.habitat || c.peso
            ? '<div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:10px">' +
                (c.habitat ? '🌍 ' + esc(c.habitat) : "") +
                (c.habitat && c.peso ? ' • ' : "") +
                (c.peso ? '⚖️ ' + esc(c.peso) : "") +
              '</div>'
            : "");
        html += '<div class="desc">' + esc(c.description || "Sem descrição.") + '</div>';
        html += '<div class="qtd-linha">' +
            '<span class="pill-raridade pill-' + r + '">' + nomeRaridade(r) + '</span>' +
            (ColecaoUI.finishDeCard(c) !== "normal"
                ? '<span class="pill-raridade cc-finish-badge ' + (ColecaoUI.finishDeCard(c) === "ouro" ? "cc-fin-ouro" : "cc-fin-cromada") + '">' + (ColecaoUI.finishDeCard(c) === "ouro" ? "◈ OURO" : "◇ CROMADA") + '</span>'
                : "") +
            '<span class="pill-raridade" style="background:rgba(255,255,255,.08)">📦 Em estoque: <b>' + (c.quantidade||0) + 'x</b></span>' +
            '<span class="pill-raridade" style="background:rgba(255,255,255,.08)">🎁 Total: <b>' + (c.total_em_circulacao||0) + 'x</b></span>' +
        '</div>';

        if (minhaConta && minhaConta.token) {
            if (c.disponivel > 0) {
                html += '<button class="btn btn-laranja" onclick="abrirModalVenda(' + c.id + ',\'' + esc(c.name) + '\',' + c.disponivel + ')">💰 Vender repetida</button>';
            } else if (c.quantidade > 0) {
                html += '<div style="font-size:12px;color:var(--muted)">Você tem ' + c.quantidade + 'x desta figurinha, mas nenhuma disponível no momento.</div>';
            }
        }
        html += '<div class="modal-acoes">' +
            '<button class="btn btn-amarelo" onclick="toggleModalFlip()">🔄 VIRAR CARTA</button>' +
            '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>' +
        '</div>';
        corpo.innerHTML = html;
    } catch(e){
        toast(e.message, "erro");
    }
}

async function abrirModalVenda(cardId, nome, disponivel){
    const corpo = document.getElementById("modalBody");
    let html = '<div class="num">💰 VENDER REPETIDA</div>';
    html += '<h2>' + esc(nome) + '</h2>';
    html += '<div class="desc">Você tem <b>' + disponivel + '</b> disponível(is) para vender.</div>';
    html += '<div class="modal-form">' +
        '<label>Quantidade</label><input type="number" id="vendaQtd" min="1" max="' + disponivel + '" value="1">' +
        '<label>Preço por figurinha (R$)</label><input type="number" id="vendaPreco" min="0.5" max="100" step="0.01" value="5.00">' +
        '<button class="btn btn-amarelo" onclick="confirmarVenda(' + cardId + ')">Publicar anúncio</button>' +
        '<button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>' +
    '</div>';
    corpo.innerHTML = html;
}
async function confirmarVenda(cardId){
    const qtd = Number(document.getElementById("vendaQtd").value);
    const preco = Number(document.getElementById("vendaPreco").value);
    if (!qtd || qtd < 1 || !preco || preco < 0.5) { toast("Informe quantidade e preço válidos.", "erro"); return; }
    try {
        await apiPost("/api/colecionaveis/listings", { cardId, quantidade: qtd, preco });
        toast("Anúncio publicado! Suas figurinhas foram reservadas.", "ok");
        fecharModal();
        carregarAcervo();
        carregarMercado(1);
    } catch(e){ toast(e.message, "erro"); }
}

/* =========================================================
   NOVA TROCA / CONTRA-PROPOSTA
========================================================= */
async function abrirModalTroca(){
    if (!exigirLogin()) return;
    const meuId = meuUsuarioId();
    if (meuId == null) {
        toast("Não foi possível iniciar a troca. Faça login novamente para continuar.", "erro");
        return;
    }
    try {
        const meuAcervo = await apiGet("/api/colecionaveis/acervo?pagina=1");
        if (!meuAcervo || !Array.isArray(meuAcervo.cards)) {
            toast("Não foi possível iniciar a troca. Selecione uma figurinha e um colecionador para continuar.", "erro");
            return;
        }
        estado.modoTroca = { tipo: "nova" };
        let html = '<div class="num">🤝 NOVA TROCA</div>';
        html += '<h2>Propor negociação</h2>';
        html += '<div class="desc">Escolha o que você oferece, o que deseja receber e se haverá diferença em dinheiro.</div>';
        html += '<div class="modal-form">' +
            '<label>Eu ofereço (selecione)</label><div id="trocaOfereco" style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
            '<label>Quero receber (selecione)</label><div id="trocaRecebo" style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
            '<label>Destinatário (ID do colecionador)</label><input id="trocaDestino" placeholder="Ex.: 42">' +
            '<div class="row2">' +
                '<div><label>Diferença (R$)</label><input id="trocaCash" type="number" min="0" step="0.01" value="0"></div>' +
                '<div><label>Quem paga</label><select id="trocaCashDir"><option value="">Sem dinheiro</option><option value="proposer_pays">Eu pago</option><option value="receiver_pays">Ele(a) paga</option></select></div>' +
            '</div>' +
            '<button class="btn btn-amarelo" onclick="confirmarTroca()">Enviar proposta</button>' +
            '<button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>' +
        '</div>';
        document.getElementById("modalOverlay").classList.remove("hidden");
        document.getElementById("modalBody").innerHTML = html;
        /* mini-seletores */
        renderSelFig(meuAcervo.cards, "trocaOfereco", "ofereco");
        renderSelFig(meuAcervo.cards, "trocaRecebo", "recebo");
    } catch(e){ toast(msgErro(e), "erro"); }
}

async function abrirModalTrocaCom(trade, meuAcervo){
    document.getElementById("modalOverlay").classList.remove("hidden");
    let html = '<div class="num">↻ CONTRA-PROPOSTA #' + trade.id + '</div>';
    html += '<h2>Contrapor negociação</h2>';
    html += '<div class="desc">Ajuste as figurinhas e envie sua contra-proposta.</div>';
    html += '<div class="modal-form">' +
        '<label>Eu ofereço (selecione)</label><div id="trocaOfereco" style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
        '<label>Quero receber (selecione)</label><div id="trocaRecebo" style="display:flex;gap:6px;flex-wrap:wrap"></div>' +
        '<div class="row2">' +
            '<div><label>Diferença (R$)</label><input id="trocaCash" type="number" min="0" step="0.01" value="0"></div>' +
            '<div><label>Quem paga</label><select id="trocaCashDir"><option value="">Sem dinheiro</option><option value="proposer_pays">Eu pago</option><option value="receiver_pays">Ele(a) paga</option></select></div>' +
        '</div>' +
        '<button class="btn btn-amarelo" onclick="confirmarContraproposta(' + trade.id + ')">Enviar contra-proposta</button>' +
        '<button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>' +
    '</div>';
    document.getElementById("modalBody").innerHTML = html;
    renderSelFig(meuAcervo.cards || meuAcervo, "trocaOfereco", "ofereco");
    renderSelFig(meuAcervo.cards || meuAcervo, "trocaRecebo", "recebo");
}

function renderSelFig(cards, alvoId, nome){
    const alvo = document.getElementById(alvoId);
    if (!alvo) return;
    const meus = (cards || []).filter(c => c.disponivel > 0);
    alvo.innerHTML = meus.length
        ? meus.map(c =>
            '<span class="mini-fig" style="cursor:pointer;user-select:none" onclick="toggleSelFig(this,\'' + alvoId + '\',\'' + nome + '\')" data-id="' + c.id + '" data-nome="' + esc(c.name) + '">' +
            '<span class="emoji">' + emojiRaridade(c.rarity) + '</span>#' + String(c.number).padStart(3,"0") + '</span>'
        ).join("")
        : '<span style="font-size:12px;color:var(--muted)">Nenhuma figurinha disponível.</span>';
}
function toggleSelFig(el, alvoId, nome){
    el.classList.toggle("selecionada");
    el.style.borderColor = el.classList.contains("selecionada") ? "var(--amarelo)" : "";
    el.style.outline = el.classList.contains("selecionada") ? "2px solid var(--amarelo)" : "";
}
function selFiguras(alvoId){
    return Array.from(document.querySelectorAll("#" + alvoId + " .selecionada")).map(el => ({ cardId: Number(el.dataset.id) }));
}

async function confirmarTroca(){
    const ofereco = selFiguras("trocaOfereco");
    const recebo = selFiguras("trocaRecebo");
    const destino = Number(document.getElementById("trocaDestino").value);
    const cash = Number(document.getElementById("trocaCash").value) || 0;
    const dir = document.getElementById("trocaCashDir").value || null;
    if (!ofereco.length) { toast("Selecione pelo menos 1 figurinha para oferecer.", "erro"); return; }
    if (!recebo.length) { toast("Selecione pelo menos 1 figurinha que deseja receber.", "erro"); return; }
    if (!destino) { toast("Informe o ID do destinatário.", "erro"); return; }
    const body = { receiverId: destino, ofereco, recebo };
    if (cash > 0 && dir) { body.cashAmount = cash; body.cashDirection = dir; }
    try {
        await apiPost("/api/colecionaveis/trades", body);
        toast("Proposta de troca enviada!", "ok");
        fecharModal();
        carregarTrocas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

async function confirmarContraproposta(tradeId){
    const ofereco = selFiguras("trocaOfereco");
    const recebo = selFiguras("trocaRecebo");
    const cash = Number(document.getElementById("trocaCash").value) || 0;
    const dir = document.getElementById("trocaCashDir").value || null;
    if (!ofereco.length || !recebo.length) { toast("Selecione figurinhas de ambos os lados.", "erro"); return; }
    const body = { ofereco, recebo };
    if (cash > 0 && dir) { body.cashAmount = cash; body.cashDirection = dir; }
    try {
        await apiPost("/api/colecionaveis/trades/" + tradeId + "/counter", body);
        toast("Contra-proposta enviada!", "ok");
        fecharModal();
        carregarTrocas();
    } catch(e){ toast(msgErro(e), "erro"); }
}

function getPacoteImagem(tipoPacote){
    const tipo = String(tipoPacote || "").toLowerCase();
    const slug = tipo.includes("especial") ? "especial" : tipo.includes("ouro") ? "ouro" : tipo.includes("prata") ? "prata" : "bronze";
    return "/imagens/pacotes/" + slug + "8ksf.png";
}

function resolvePackageVisual(categoria) {
    const cat = String(categoria || "").toUpperCase().trim();
    const chave = cat.includes("OURO") ? "OURO" : cat.includes("PRATA") ? "PRATA" : cat.includes("BRONZE") ? "BRONZE" : cat.includes("ESPECIAL") ? "ESPECIAL" : "PACOTE";
    const cores = { OURO: "#FFD700", PRATA: "#C0C0C0", BRONZE: "#CD7F32", ESPECIAL: "#C39BFF", PACOTE: "#B0A080" };
    return { label: chave, cor: cores[chave], imagem: getPacoteImagem(categoria) };
}

/* =========================================================
   PAGAMENTO (MP)
========================================================= */
async function abrirModalPagamento(tipo, dados){
    document.getElementById("modalOverlay").classList.remove("hidden");
    const corpo = document.getElementById("modalBody");
    const titulo = tipo === "pack" ? "Abrir Pacote" : tipo === "mercado" ? "Comprar no Mercado" : tipo === "auction" ? "Pagar Lance Vencedor" : tipo === "oferta" ? "Pagar Oferta Aceita" : "Diferença de Troca";
    let html = '<div class="num">💳 CONFIRMAR PAGAMENTO</div>';
    html += '<h2>' + esc(titulo) + '</h2>';

    if (tipo === "pack") {
        const imgInfo = resolvePackageVisual(dados.categoria || dados.nome);
        html += '<div class="package-art" style="--package-color:' + imgInfo.cor + ';--package-color-soft:' + imgInfo.cor + '22;--package-color-faint:' + imgInfo.cor + '08">' +
            '<img src="' + esc(imgInfo.imagem) + '" alt="Pacote ' + esc(imgInfo.label) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\'">' +
            '<div class="package-art-missing">Pacote ' + imgInfo.label + '<small>Imagem indisponível</small></div>' +
        '</div>';
        
        html += '<div class="produto-resumo">' +
            '<div class="produto-nome">' + esc(dados.nome || "Pacote") + '</div>' +
            '<div class="produto-preco">' + fmtR$(dados.preco) + '</div>' +
            '<div class="produto-detalhe">' + (dados.figurinhas || 0) + ' figurinha(s)</div>' +
        '</div>';
    } else if (tipo === "mercado") {
        if (dados.image_url) {
            html += '<div style="height:170px;border-radius:12px;overflow:hidden;margin-bottom:12px;background:var(--painel2)"><img src="' + esc(dados.image_url) + '" alt="' + esc(dados.name || "Figurinha") + '" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'"></div>';
        }
        html += '<div class="produto-resumo">' +
            '<div class="produto-nome">#' + String(dados.number || "").padStart(3,"0") + ' — ' + esc(dados.name || "Figurinha") + '</div>' +
            '<div class="produto-detalhe">' + esc(dados.rarity || "") + ' • ' + esc(dados.finish || "NORMAL") + ' • Vendedor: ' + esc(dados.seller_nome || "—") + '</div>' +
            '<div class="produto-preco">' + fmtR$(dados.preco) + '</div>' +
            '<div class="produto-detalhe">Quantidade: ' + (dados.qtdDisp || 1) + '</div>' +
        '</div>';
    } else if (tipo === "trade") {
        html += '<div class="produto-resumo">' +
            '<div class="produto-preco">' + fmtR$(dados.valor) + '</div>' +
            '<div class="produto-detalhe">Diferença a pagar</div>' +
        '</div>';
    } else if (tipo === "auction") {
        html += '<div class="produto-resumo"><div class="produto-preco">' + fmtR$(dados.valor) + '</div><div class="produto-detalhe">Lance vencedor do leilão</div></div>';
    } else if (tipo === "oferta") {
        html += '<div class="produto-resumo">' +
            '<div class="produto-nome">' + esc(dados.nome || "Figurinha") + '</div>' +
            '<div class="produto-preco">' + fmtR$(dados.preco) + '</div>' +
            '<div class="produto-detalhe">Oferta aceita • Quantidade: ' + (dados.quantidade || 1) + '</div>' +
        '</div>';
    }

    html += '<div class="desc">Escolha como deseja pagar. O pagamento é processado com segurança pelo Mercado Pago.</div>';
    html += '<div class="modal-form">' +
        '<label>Forma de pagamento</label>' +
        '<select id="pgMetodo"><option value="pix">💠 Pix</option><option value="credit_card">💳 Cartão de crédito</option></select>' +
        '<label>CPF/CNPJ</label><input id="pgCpf" placeholder="Somente números" maxlength="18">' +
        '<button class="btn btn-amarelo" onclick="iniciarPagamento(\'' + tipo + '\',' + JSON.stringify(dados).replace(/"/g,"&quot;") + ')">Gerar pagamento</button>' +
        '<button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>' +
    '</div>';
    corpo.innerHTML = html;
}

async function iniciarPagamento(tipo, dados){
    const metodo = document.getElementById("pgMetodo").value;
    const cpf = document.getElementById("pgCpf").value.replace(/\D/g, "");
    if (!cpf) { toast("Informe CPF ou CNPJ.", "erro"); return; }
    if (!validarCpfCnpj(cpf)) { toast("CPF/CNPJ inválido. Verifique os números.", "erro"); return; }
    let url, body;
    if (tipo === "pack") {
        url = "/api/colecionaveis/packs/" + dados.packId + "/checkout";
        body = { paymentMethod: metodo, cpfCnpj: cpf, storyOptIn: false };
    } else if (tipo === "mercado") {
        url = "/api/colecionaveis/listings/" + dados.listingId + "/buy";
        body = { quantidade: 1, paymentMethod: metodo, cpfCnpj: cpf };
    } else if (tipo === "trade") {
        url = "/api/colecionaveis/trades/" + dados.tradeId + "/accept";
        body = { paymentMethod: metodo, cpfCnpj: cpf };
    } else if (tipo === "auction") {
        url = "/api/colecionaveis/auctions/" + dados.auctionId + "/pay";
        body = { paymentMethod: metodo, cpfCnpj: cpf };
    } else if (tipo === "oferta") {
        url = "/api/colecionaveis/offers/" + dados.offerId + "/pay";
        body = { paymentMethod: metodo, cpfCnpj: cpf };
    }
    try {
        const d = await apiPost(url, body);
        mostrarQr(d, tipo);
    } catch(e){ toast(msgErro(e), "erro"); }
}

function mostrarQr(d, tipo){
    const corpo = document.getElementById("modalBody");
    let html = '<div class="num">✅ PEDIDO CRIADO</div>';
    html += '<h2>' + (tipo === "pack" ? "Pacote reservado" : tipo === "mercado" ? "Compra reservada" : tipo === "auction" ? "Lance reservado" : tipo === "oferta" ? "Oferta reservada" : "Diferença de troca") + '</h2>';
    html += '<div class="desc" style="text-align:center;margin-bottom:10px;">' +
        '⏳ Aguardando confirmação do pagamento. Não entregamos o produto antes do pagamento ser confirmado.' +
    '</div>';
    if (d.qrCodeBase64) {
        html += '<div style="text-align:center;margin:14px 0">' +
            '<img src="data:image/png;base64,' + d.qrCodeBase64 + '" alt="QR Code Pix" style="width:200px;height:200px;border-radius:12px">' +
        '</div>';
        html += '<div class="desc" style="text-align:center">Escaneie com o app do seu banco ou copie o código abaixo:</div>';
    } else {
        html += '<div class="desc">Pagamento gerado! Use o link abaixo para concluir:</div>';
    }
    html += '<div style="background:#0f0f16;border:1px solid var(--borda);border-radius:10px;padding:12px;font-size:12px;word-break:break-all;margin:10px 0">' +
        esc(d.payload || (d.ticketUrl || d.paymentId || "—")) + '</div>';
    html += '<div class="desc">Valor: <b style="color:var(--amarelo)">' + fmtR$(d.valor) + '</b> • Pedido: ' + esc(d.externalReference || d.orderId) + '</div>';
    html += '<div style="display:flex;gap:8px;margin-top:14px">' +
        '<button class="btn btn-amarelo" onclick="iniciarPolling(\'' + esc(d.orderId) + '\',\'' + esc(tipo || "") + '\')">JÁ PAGUEI</button>' +
        '<button class="btn btn-ghost" onclick="fecharModal()">Fechar</button>' +
    '</div>';
    corpo.innerHTML = html;
}

let pollTimer = null;
async function iniciarPolling(orderId, tipo){
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    const corpo = document.getElementById("modalBody");
    corpo.innerHTML = '<div class="num">⏳ AGUARDANDO CONFIRMAÇÃO</div><h2>Verificando pagamento...</h2>' +
        '<div class="desc">Assim que o pagamento for confirmado, suas figurinhas aparecem automaticamente.</div>' +
        '<div style="text-align:center;margin:14px 0;font-size:30px">⏳</div>';
    const checar = async () => {
        try {
            const d = await apiGet("/api/colecionaveis/pagamento/" + orderId);
            if (d.status === "RECEIVED") {
                /* CORREÇÃO 7: pacote pago → revela o sorteio JÁ persistido
                   (a mesma abertura a cada refresh). */
                if (tipo === "pack" && d.pacote && d.pacote.figurinhas && d.pacote.figurinhas.length) {
                    toast("Pagamento confirmado! Pacote aberto. 🎉", "ok");
                    fecharModal();
                    revelarPacote(d.pacote);
                } else {
                    toast("Pagamento confirmado! Suas figurinhas chegaram. 🎉", "ok");
                    fecharModal();
                    carregarAlbum();
                    carregarAcervo();
                    carregarTrocas();
                    carregarMercado(1);
                    carregarLeiloes();
                    carregarOfertas();
                }
                return;
            }
        } catch(e){}
        pollTimer = setTimeout(checar, 4000);
    };
    checar();
}

/* ===== EXPERIÊNCIA DE ABERTURA DE PACOTE (MILHÃO DOOR) ===== */
let pacoteEstado = null;
let pacoteTimers = [];

function pacoteLimparTimers(){
    (pacoteTimers || []).forEach(t => clearTimeout(t));
    pacoteTimers = [];
}
function pacoteRoda(fn, ms){ pacoteTimers.push(setTimeout(fn, ms)); }

function revelarPacote(pacote){
    pacoteLimparTimers();
    const figs = (pacote && pacote.figurinhas) || [];
    /* posse após abertura do pacote (para nova/repetida) */
    const posse = {};
    ((MEU_ALBUM && MEU_ALBUM.cards) || []).forEach(c => { posse[c.id] = c.quantidade; });
    for (const c of figs) { posse[c.id] = (posse[c.id] || 0) + 1; }
    const marcadas = ColecaoUI.marcarNovidades(posse, figs);
    const melhor = ColecaoUI.melhorDoPacote(figs);
    const iMelhor = figs.indexOf(melhor);
    pacoteEstado = {
        figs: figs.map((c, i) => ({ card: c, marc: marcadas[i] })),
        idx: 0,
        melhor: melhor,
        melhorMarc: marcadas[iMelhor] || { nova: false, repetida: true },
        etapa: "fechado",
        modo: null,
        purchaseId: Number(pacote && pacote.purchaseId) || null,
        aberto: !!(pacote && pacote.aberto),
        aberturaSolicitada: false,
        nome: (pacote && pacote.nome) || "Pacote"
    };
    const overlay = document.getElementById("packOverlay");
    overlay.classList.remove("hidden", "escuro", "abrindo");
    document.body.style.overflow = "hidden";
    renderPackFechado();
}

async function abrirPacoteNoBackend(){
    if (!pacoteEstado || pacoteEstado.aberto || !pacoteEstado.purchaseId) return true;
    if (pacoteEstado.aberturaSolicitada) return false;
    pacoteEstado.aberturaSolicitada = true;
    try {
        const d = await apiPost("/api/colecionaveis/packs/purchases/" + pacoteEstado.purchaseId + "/open", {});
        if (!d.ok) throw new Error(d.error || "Não foi possível abrir o pacote.");
        pacoteEstado.aberto = true;
        pacoteEstado.aberturaSolicitada = false;
        return true;
    } catch (error) {
        pacoteEstado.aberturaSolicitada = false;
        toast(error.message || "Não foi possível abrir o pacote.", "erro");
        return false;
    }
}

async function iniciarModoManual(){
    if (!pacoteEstado || pacoteEstado.modo) return;
    if (!(await abrirPacoteNoBackend())) return;
    pacoteEstado.modo = "manual";
    rasgarPacote();
}
async function iniciarModoAuto(){
    if (!pacoteEstado || pacoteEstado.modo) return;
    if (!(await abrirPacoteNoBackend())) return;
    pacoteEstado.modo = "auto";
    rasgarPacote();
}
function rasgarPacote(){
    pacoteEstado.etapa = "rasgando";
    const pf = document.getElementById("packFechado");
    if (pf) pf.classList.add("rasgando");
    document.getElementById("packOverlay").classList.add("abrindo");
    pacoteRoda(renderPackLuz, 520);
}

function packEtapaClicada(){
    if (!pacoteEstado) return;
    const etapa = pacoteEstado.etapa;
    if (etapa === "fechado") {
        /* aguarda escolha do modo via botões */
    } else if (etapa === "rasgando" || etapa === "luz") {
        /* avança sozinho pelos timers */
    } else if (etapa === "slotBack") {
        revelarSlot();
    } else if (etapa === "slotReveal") {
        if (!pacoteEstado.virado) virarSlot();
        else avancarPacote();
    } else if (etapa === "grande") {
        renderPackResumo();
    } else if (etapa === "resumo") {
        fecharExperienciaPacote();
    }
}

function renderPackFechado(){
    const stage = document.getElementById("packStage");
        stage.innerHTML = '<div class="pack-titulo">🎁 ' + esc(pacoteEstado.nome) + '</div>' +
        '<div class="pack-fechado" id="packFechado">' +
            '<span class="pf-icone"><img src="' + esc(getPacoteImagem(pacoteEstado.nome)) + '" alt="Pacote ' + esc(pacoteEstado.nome) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'inline\'"><span style="display:none">🐾</span></span>' +
            '<span class="pf-nome">MILHÃO DOOR</span>' +
            '<span class="pf-sub">ANIMAIS DO MUNDO</span>' +
            '<span class="pf-qtd">' + pacoteEstado.figs.length + ' FIGURINHAS</span>' +
        '</div>' +
        '<div class="pack-modo" style="margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
            '<button class="btn btn-amarelo" onclick="iniciarModoManual()">📱 ABRIR UMA POR UMA</button>' +
            '<button class="btn btn-ghost" onclick="iniciarModoAuto()">⚡ ABRIR TODAS</button>' +
        '</div>';
}

function renderPackLuz(){
    const stage = document.getElementById("packStage");
    stage.innerHTML = '<div class="pack-luz"></div>';
    pacoteEstado.etapa = "luz";
    pacoteRoda(revelarSlot, 900);
}

function renderSlotBack(){
    const stage = document.getElementById("packStage");
    stage.innerHTML = '<div class="pack-titulo">🎁 ' + esc(pacoteEstado.nome) + '</div>' +
        '<div class="slot-carta" onclick="packEtapaClicada()">' +
            '<span class="sc-icone">🐾</span>' +
            '<span class="sc-texto">TOCAR PARA REVELAR</span>' +
        '</div>' +
        '<div class="pack-contagem">Figurinha ' + (pacoteEstado.idx + 1) + ' de ' + pacoteEstado.figs.length + '</div>';
    pacoteEstado.etapa = "slotBack";
    if (pacoteEstado.modo !== "manual") pacoteRoda(revelarSlot, pacoteEstado.modo === "auto" ? 750 : 8000);
}

function revelarSlot(){
    if (!pacoteEstado || (pacoteEstado.etapa !== "slotBack" && pacoteEstado.etapa !== "slotReveal")) return;
    const item = pacoteEstado.figs[pacoteEstado.idx];
    const stage = document.getElementById("packStage");
    pacoteEstado.virado = false;
    stage.innerHTML = '<div class="pack-titulo">🎁 ' + esc(pacoteEstado.nome) + '</div>' +
        '<div class="pack-flip-container cc-flip-container" id="packFlipContainer"><div class="cc-flipper">' +
            '<div class="cc-frente">' + ColecaoUI.cardRevelacaoHtml(item.card, pacoteEstado.idx, item.marc) + '</div>' +
            '<div class="cc-verso">' + ColecaoUI.cardVersoHtml(item.card) + '</div>' +
        '</div></div>' +
        '<div class="pack-contagem">Figurinha ' + (pacoteEstado.idx + 1) + ' de ' + pacoteEstado.figs.length + '</div>' +
        '<button class="btn btn-amarelo" style="margin-top:12px" onclick="event.stopPropagation();packEtapaClicada()">VIRAR CARTA</button>';
    pacoteEstado.etapa = "slotReveal";
    if (pacoteEstado.modo !== "manual") pacoteRoda(virarSlot, 1100);
}

function virarSlot(){
    if (!pacoteEstado || pacoteEstado.etapa !== "slotReveal" || pacoteEstado.virado) return;
    pacoteEstado.virado = true;
    const flipper = document.querySelector("#packFlipContainer .cc-flipper");
    const botao = document.querySelector("#packStage > .btn");
    if (flipper) flipper.classList.add("virado");
    if (botao) botao.textContent = pacoteEstado.idx === pacoteEstado.figs.length - 1 ? "FINALIZAR" : "PRÓXIMA FIGURINHA";
    if (pacoteEstado.modo !== "manual") pacoteRoda(avancarPacote, 1400);
}

function avancarPacote(){
    if (!pacoteEstado) return;
    pacoteEstado.idx++;
    if (pacoteEstado.idx >= pacoteEstado.figs.length) {
        const m = pacoteEstado.melhor;
        const fin = m ? ColecaoUI.finishDeCard(m) : "normal";
        const especial = m && (fin !== "normal" || ["RARA","EPICA","LENDARIA","MITICA"].includes(m.rarity));
        if (especial) { renderPackGrande(); } else { renderPackResumo(); }
        return;
    }
    revelarSlot();
}

function renderPackGrande(){
    pacoteEstado.etapa = "grande";
    const m = pacoteEstado.melhor;
    const r = m.rarity;
    const fin = ColecaoUI.finishDeCard(m);
    let tipo, msg, msgCls;
    if (fin === "ouro") { tipo = "ouro"; msg = "✨ VOCÊ ENCONTROU UMA FIGURINHA OURO!"; msgCls = "grande-msg-ouro"; }
    else if (fin === "cromada") { tipo = "cromada"; msg = "🪩 VOCÊ ENCONTROU UMA FIGURINHA CROMADA!"; msgCls = "grande-msg-cromada"; }
    else if (r === "MITICA") { tipo = "mitica"; msg = "🔥 FIGURINHA MÍTICA!"; msgCls = "grande-msg-lendaria"; }
    else if (r === "LENDARIA") { tipo = "lendaria"; msg = "🏆 FIGURINHA LENDÁRIA!"; msgCls = "grande-msg-lendaria"; }
    else if (r === "EPICA") { tipo = "epica"; msg = "🌟 FIGURINHA ÉPICA!"; msgCls = "grande-msg-epica"; }
    else { tipo = "rara"; msg = "💎 FIGURINHA RARA!"; msgCls = "grande-msg-rara"; }
    const badge = pacoteEstado.melhorMarc.nova
        ? '<span class="grande-nova">✨ NOVA!</span>'
        : '<span class="grande-rep">🔁 REPETIDA</span>';
    const overlay = document.getElementById("packOverlay");
    overlay.classList.add("escuro");
    const gp = [];
    const qtd = fin === "cromada" ? 34 : 26;
    for (let i = 0; i < qtd; i++) {
        const dx = ((i * 53) % 360) - 180;
        const dy = -60 - ((i * 31) % 220);
        gp.push('<span class="gp gp-' + tipo + '" style="left:50%;top:38%;--dx:' + dx + 'px;--dy:' + dy + 'px;animation-delay:' + ((i % 6) * 0.08).toFixed(2) + 's;width:' + (6 + (i % 5)) + 'px;height:' + (6 + (i % 5)) + 'px"></span>');
    }
    const stage = document.getElementById("packStage");
    stage.innerHTML = gp.join("") +
        '<div class="pack-grande">' +
            ColecaoUI.cardGrandeHtml(m) +
            '<div class="grande-msg ' + msgCls + '">' + msg + '</div>' +
            badge +
            '<div class="grande-tap">Toque para ver o resumo do pacote →</div>' +
        '</div>';
    pacoteRoda(renderPackResumo, pacoteEstado.modo === "auto" ? 3200 : 9000);
}

function renderPackResumo(){
    if (!pacoteEstado) return;
    pacoteEstado.etapa = "resumo";
    const st = ColecaoUI.packResumo(pacoteEstado.figs.map(f => f.marc));
    /* coleção atualizada com as figurinhas recém-abertas */
    const base = ((MEU_ALBUM && MEU_ALBUM.cards) || []).map(c => Object.assign({}, c, { quantidade: Number(c.quantidade || 0) }));
    for (const f of pacoteEstado.figs) {
        const c = base.find(x => x.id === f.card.id);
        if (c) c.quantidade += 1;
    }
    const res = ColecaoUI.resumoColecao(base);
    const stage = document.getElementById("packStage");
    stage.innerHTML = '<div class="pack-titulo">🎉 PACOTE ABERTO!</div>' +
        '<div class="pack-resumo">' +
            '<div class="rev-grid">' + pacoteEstado.figs.map((f, i) => ColecaoUI.cardRevelacaoHtml(f.card, i, f.marc)).join("") + '</div>' +
            '<div class="pack-resumo-total">' +
                '<span class="pr-box pr-novo">✨ Novas<br><b>' + st.novas + '</b></span>' +
                '<span class="pr-box pr-rep">🔁 Repetidas<br><b>' + st.repetidas + '</b></span>' +
                '<span class="pr-box pr-col">📖 Na coleção<br><b>' + res.diferentes + '/' + (res.total || 100) + '</b></span>' +
            '</div>' +
            '<div class="modal-acoes" style="margin-top:18px">' +
                '<button class="btn btn-amarelo" onclick="verMinhasFigurinhas()">🗂️ IR PARA MEU ACERVO</button>' +
                '<button class="btn btn-ghost" onclick="abrirOutroPacote()">🎁 ABRIR OUTRO PACOTE</button>' +
            '</div>' +
        '</div>';
    pacoteLimparTimers();
}

function fecharExperienciaPacote(){
    pacoteLimparTimers();
    pacoteEstado = null;
    const overlay = document.getElementById("packOverlay");
    overlay.classList.add("hidden");
    overlay.classList.remove("escuro", "abrindo");
    document.getElementById("packStage").innerHTML = "";
    document.body.style.overflow = "";
    toast("🎉 Figurinhas adicionadas à sua coleção!", "ok");
    carregarAlbum();
    carregarAcervo();
    carregarTrocas();
    carregarMercado(1);
}

function verMinhasFigurinhas(){
    fecharExperienciaPacote();
    mudarAba("acervo");
}

function abrirOutroPacote(){
    fecharExperienciaPacote();
    mudarAba("packs");
}

/* =========================================================
   PERFIL
========================================================= */
async function carregarPerfil(){
    if (!exigirLogin()) return;
    try {
        const u = meuUsuarioId() != null ? (minhaConta.usuario || minhaConta) : null;
        const sessaoBar = document.getElementById("sessaoBar");
        if (sessaoBar) {
            sessaoBar.style.display = "flex";
            sessaoBar.innerHTML = '<span>🔐 Sessão iniciada: <b>' + esc((u && u.nome) || "") + '</b> · ' + esc((u && u.email) || "") + '</span>' +
                '<button class="btn btn-ghost" onclick="sairConta()">🚪 Sair da conta</button>';
        }
        const d = await apiGet("/api/colecionaveis/perfil");
        carregarContaRecebimento();
        const p = d.perfil;

        /* Botão Editar Perfil */
        let editBtn = '<div style="margin:10px 0;">' +
            '<button class="btn btn-amarelo" onclick="abrirModalEditarPerfilColecao()" ' +
            'style="width:100%;padding:10px;font-size:13px;font-weight:800;">' +
            '✏️ EDITAR PERFIL</button></div>';

        let stats = editBtn + '<h4>📊 Estatísticas</h4>';
        stats += '<div class="perfil-stats">' +
            '<div class="stat-box"><div class="v">' + p.stats.diferentes + '</div><div class="l">DIFERENTES</div></div>' +
            '<div class="stat-box"><div class="v">' + p.stats.total + '</div><div class="l">TOTAL</div></div>' +
            '<div class="stat-box"><div class="v">' + p.stats.repetidas + '</div><div class="l">REPETIDAS</div></div>' +
            '<div class="stat-box"><div class="v">' + p.stats.raras + '</div><div class="l">RARAS</div></div>' +
            '<div class="stat-box"><div class="v">' + (p.album_completo ? "✅" : "❌") + '</div><div class="l">ÁLBUM</div></div>' +
            '<div class="stat-box"><div class="v">' + p.ranking + '</div><div class="l">RANKING</div></div>' +
        '</div>';
        stats += '<div style="margin-top:12px;padding:10px;border:1px solid rgba(255,212,0,.25);border-radius:10px;color:var(--muted);font-size:12px">' +
            '🏆 Álbum completo: <b style="color:var(--amarelo)">' + p.diferentes + '/100</b>' +
            (p.recompensa_mensal ? ' · Recompensa mensal registrada: <b style="color:var(--verde)">✅</b>' : '') +
            '</div>';

        /* Visibilidade do álbum público. */
        stats += '<div style="margin-top:12px;padding:12px;border:1px solid var(--borda);border-radius:10px;background:var(--painel)">' +
            '<h4 style="margin-bottom:6px">🌐 Álbum público</h4>' +
            '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">' +
                (p.album_publico
                    ? 'Seu álbum está <b style="color:var(--verde)">PÚBLICO</b>. Outros colecionadores podem ver seu acervo e fazer ofertas.'
                    : 'Seu álbum está <b style="color:var(--muted)">PRIVADO</b>. Só você consegue ver o acervo.') +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
                '<button class="btn ' + (p.album_publico ? "btn-amarelo" : "btn-ghost") + '" onclick="mudarVisibilidade(false)">🔒 Privado</button>' +
                '<button class="btn ' + (p.album_publico ? "btn-ghost" : "btn-amarelo") + '" onclick="mudarVisibilidade(true)">🌐 Público</button>' +
                '<a class="btn btn-ghost" style="margin:0" href="/perfil.html?id=' + encodeURIComponent(meuUsuarioId() || "") + '" target="_blank">Ver como público</a>' +
            '</div>' +
        '</div>';
        document.getElementById("perfilStatsCard").innerHTML = stats;

        /* conquistas */
        const conc = d.conquistas || [];
        document.getElementById("conquistasLista").innerHTML = conc.map(c =>
            '<div class="conquista ' + (c.desbloqueada ? "" : "lock") + '">' +
                '<div class="icone">' + esc(c.icon || "🏅") + '</div>' +
                '<div class="info"><div class="n">' + esc(c.name) + '</div>' +
                '<div class="d">' + esc(c.description || "") + '</div></div>' +
            '</div>'
        ).join("");

        /* histórico */
        const hist = (await apiGet("/api/colecionaveis/historico")).historico || [];
        document.getElementById("historicoLista").innerHTML = hist.length
            ? hist.map(h =>
                '<div class="hist-linha">' +
                    '<div class="detalhe">' + esc(h.detalhe || h.tipo) + '</div>' +
                    '<div style="text-align:right">' +
                        (Number(h.valor) > 0 ? '<div class="valor">' + fmtR$(h.valor) + '</div>' : '') +
                        '<div class="quando">' + fmtData(h.created_at) + '</div>' +
                    '</div>' +
                '</div>'
            ).join("")
            : '<div style="color:var(--muted);font-size:12px">Nenhuma atividade ainda.</div>';
    } catch(e){
        document.getElementById("perfilStatsCard").innerHTML = '<div style="color:var(--muted)">' + esc(e.message) + '</div>';
    }
}

async function mudarVisibilidade(albumPublico){
    try {
        const d = await apiPut("/api/colecionaveis/perfil/visibilidade", { albumPublico });
        toast(d.mensagem || "Visibilidade atualizada!", "ok");
        carregarPerfil();
    } catch(e){ toast(msgErro(e), "erro"); }
}

/* ===== EDITAR PERFIL MODAL ===== */
function abrirModalEditarPerfilColecao(){
    const u = minhaConta?.usuario || minhaConta || {};
    const modal = document.createElement("div");
    modal.id = "modalEditarPerfil";
    modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px;";
    modal.innerHTML =
        '<div style="background:#141414;border:1px solid #333;border-radius:14px;max-width:440px;width:100%;padding:24px;max-height:90vh;overflow:auto;">' +
        '<h3 style="color:var(--amarelo);margin:0 0 16px;">✏️ Editar Perfil</h3>' +
        '<div id="editPerfilPreview" style="text-align:center;margin-bottom:12px;">' +
        (u.foto_url
            ? '<img src="' + esc(u.foto_url) + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:2px solid var(--amarelo);">'
            : '<div style="width:80px;height:80px;border-radius:50%;background:#222;display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:32px;border:2px solid #444;">👤</div>') +
        '</div>' +
        '<input type="file" id="editPerfilFoto" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="previewFotoEditPerfil(this)">' +
        '<button class="btn btn-ghost" style="width:100%;margin-bottom:12px;" onclick="document.getElementById(\'editPerfilFoto\').click()">📷 Alterar foto</button>' +
        '<label style="color:var(--muted);font-size:12px;display:block;margin-bottom:4px;">Apelido</label>' +
        '<input id="editPerfilApelido" value="' + esc(u.apelido || "") + '" maxlength="50" placeholder="Seu apelido" style="width:100%;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a26;color:#eee;margin-bottom:10px;font-size:14px;">' +
        '<label style="color:var(--muted);font-size:12px;display:block;margin-bottom:4px;">Bio</label>' +
        '<textarea id="editPerfilBio" maxlength="500" placeholder="Conte um pouco sobre você..." style="width:100%;padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a26;color:#eee;margin-bottom:10px;font-size:14px;min-height:80px;resize:vertical;">' + esc(u.bio || "") + '</textarea>' +
        '<div id="editPerfilMsg" style="color:var(--verde);font-size:12px;min-height:18px;margin-bottom:8px;"></div>' +
        '<div style="display:flex;gap:8px;">' +
        '<button class="btn" style="flex:1;" onclick="salvarPerfilColecao()">SALVAR</button>' +
        '<button class="btn btn-ghost" style="flex:1;" onclick="fecharModalEditarPerfil()">CANCELAR</button>' +
        '</div>' +
        '</div>';
    document.body.appendChild(modal);
    modal.addEventListener("click", function(e){ if(e.target === modal) fecharModalEditarPerfil(); });
}

function fecharModalEditarPerfil(){
    const m = document.getElementById("modalEditarPerfil");
    if(m) m.remove();
}

let _editPerfilFotoFile = null;
function previewFotoEditPerfil(input){
    const file = input.files && input.files[0];
    if(!file) return;
    if(file.size > 5*1024*1024){
        document.getElementById("editPerfilMsg").textContent = "Foto deve ter no máximo 5MB.";
        return;
    }
    _editPerfilFotoFile = file;
    const reader = new FileReader();
    reader.onload = function(e){
        document.getElementById("editPerfilPreview").innerHTML =
            '<img src="' + e.target.result + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:2px solid var(--amarelo);">';
    };
    reader.readAsDataURL(file);
}

async function salvarPerfilColecao(){
    const msgEl = document.getElementById("editPerfilMsg");
    msgEl.textContent = "Salvando...";
    msgEl.style.color = "var(--amarelo)";
    try {
        if(_editPerfilFotoFile){
            const fd = new FormData();
            fd.append("foto", _editPerfilFotoFile);
            await fetch("/api/perfil/foto", {
                method: "POST",
                headers: { "Authorization": "Bearer " + (minhaConta?.token || "") },
                body: fd
            });
            _editPerfilFotoFile = null;
        }
        const apelido = (document.getElementById("editPerfilApelido").value || "").trim();
        const bio = (document.getElementById("editPerfilBio").value || "").trim();
        const d = await apiPut("/api/perfil", { apelido, bio });
        if(d && d.perfil){
            if(minhaConta) minhaConta.usuario = { ...(minhaConta.usuario || minhaConta), ...d.perfil };
        }
        msgEl.style.color = "var(--verde)";
        msgEl.textContent = "Perfil atualizado com sucesso!";
        setTimeout(function(){ fecharModalEditarPerfil(); carregarPerfil(); }, 1200);
    } catch(e){
        msgEl.style.color = "#ff6b6b";
        msgEl.textContent = msgErro(e);
    }
}

async function carregarContaRecebimento(){
    const el = document.getElementById("recebimentosConteudo");
    const banner = document.getElementById("mpRecebimentosBanner");
    const bannerTexto = document.getElementById("mpRecebimentosTexto");
    const bannerAcao = document.getElementById("mpRecebimentosAcao");
    if(!minhaConta || !minhaConta.token){
        if(banner) banner.style.display = "none";
        if(el) el.textContent = "Entre na conta para consultar recebimentos.";
        return;
    }
    if(banner) banner.style.display = "flex";
    if(bannerAcao) bannerAcao.innerHTML = '<span class="status" style="color:var(--muted)">Consultando...</span>';
    try {
        const d = await apiGet("/api/marketplace/account");
        if(d.connected){
            const html = '<span style="color:var(--verde);font-weight:800">🟢 Mercado Pago conectado</span><br><small>Você já pode vender figurinhas, participar de negociações e receber seus pagamentos.</small>';
            if(el) el.innerHTML = html;
            if(bannerTexto) bannerTexto.textContent = "Você já pode vender figurinhas e receber seus pagamentos.";
            if(bannerAcao) bannerAcao.innerHTML = '<span class="status" style="color:var(--verde)">✅ CONECTADO</span>';
        }else{
            const html = '<span style="color:var(--vermelho);font-weight:800">🔴 Mercado Pago não conectado</span><br><button class="btn btn-amarelo" style="margin-top:10px" onclick="conectarMercadoPago()">🟡 CONECTAR MERCADO PAGO</button>';
            if(el) el.innerHTML = html;
            if(bannerTexto) bannerTexto.textContent = "Conecte seu Mercado Pago para vender suas figurinhas.";
            if(bannerAcao) bannerAcao.innerHTML = '<button class="btn btn-amarelo" style="margin:0" onclick="conectarMercadoPago()">CONECTAR MERCADO PAGO</button>';
        }
    } catch(e){
        if(el) el.textContent = e.status === 401 || e.status === 403 ? "Entre na conta para consultar recebimentos." : "Não foi possível consultar a conta de recebimento.";
        if(banner) banner.style.display = e.status === 401 || e.status === 403 ? "none" : "flex";
        if(bannerAcao && banner.style.display !== "none") bannerAcao.innerHTML = '<span class="status" style="color:var(--vermelho)">Indisponível</span>';
    }
}

async function conectarMercadoPago(){
    try {
        const response = await fetch("/api/marketplace/oauth/connect", {
            method: "GET",
            credentials: "include",
            headers: authHeaders({ Accept: "application/json" })
        });
        const data = await response.json().catch(() => ({}));
        if(response.status === 401){
            toast("Sua sessão expirou. Faça login novamente para continuar.", "erro");
            abrirModalLogin();
            return;
        }
        if(response.status === 403){
            toast("Você não tem permissão para conectar esta conta.", "erro");
            return;
        }
        if(!response.ok || !data.authorizationUrl){
            toast(data.error || "Não foi possível iniciar a conexão com o Mercado Pago.", "erro");
            return;
        }
        window.location.assign(data.authorizationUrl);
    } catch(error){
        toast("Não foi possível conectar ao Mercado Pago. Tente novamente.", "erro");
    }
}

/* =========================================================
   LOGIN / CONTA
========================================================= */
function abrirConta(){
    if (minhaConta && minhaConta.token) {
        mudarAba("perfil");
        return;
    }
    abrirModalLogin();
}

function abrirModalLogin(){
    document.getElementById("modalOverlay").classList.remove("hidden");
    const corpo = document.getElementById("modalBody");
    corpo.innerHTML = '<div class="login-panel">' +
        '<div class="login-brand"><div class="icone">🃏</div><div class="marca">MILHÃO DOOR</div><div class="submarca">ANIMAIS DO MUNDO · COLECIONÁVEIS</div></div>' +
        '<h2>Entrar na sua conta</h2>' +
        '<div class="sub">Para abrir pacotes, negociar e completar seu álbum.</div>' +
        '<div class="login-tabs">' +
            '<button class="ativa" id="tabLogin" onclick="alternarLoginTab(\'login\')">Entrar</button>' +
            '<button id="tabReg" onclick="alternarLoginTab(\'reg\')">Criar conta</button>' +
        '</div>' +
        '<div class="login-form" id="loginForm">' +
            '<label>E-mail</label><input id="lgEmail" type="email" placeholder="voce@email.com">' +
            '<label>Senha</label><input id="lgSenha" type="password" placeholder="••••••••">' +
            '<div class="login-erro" id="lgErro"></div>' +
            '<button class="btn btn-amarelo" onclick="fazerLogin()">Entrar</button>' +
            '<div style="text-align:center;margin-top:10px"><a href="#" onclick="abrirModalEsqueciSenha();return false" style="color:var(--muted);font-size:12px">Esqueci minha senha</a></div>' +
        '</div>' +
        '<div class="login-form hidden" id="regForm">' +
            '<label>Nome</label><input id="rgNome" placeholder="Seu nome">' +
            '<label>E-mail</label><input id="rgEmail" type="email" placeholder="voce@email.com">' +
            '<label>Senha</label><input id="rgSenha" type="password" placeholder="Mínimo 6 caracteres">' +
            '<div class="login-erro" id="rgErro"></div>' +
            '<button class="btn btn-amarelo" onclick="fazerRegistro()">Criar conta</button>' +
        '</div>' +
    '</div>';
}
function alternarLoginTab(modo){
    document.getElementById("tabLogin").classList.toggle("ativa", modo === "login");
    document.getElementById("tabReg").classList.toggle("ativa", modo === "reg");
    document.getElementById("loginForm").classList.toggle("hidden", modo !== "login");
    document.getElementById("regForm").classList.toggle("hidden", modo !== "reg");
}

/* ===== ESQUECI A SENHA ===== */
function abrirModalEsqueciSenha(){
    document.getElementById("modalOverlay").classList.remove("hidden");
    document.getElementById("modalBody").innerHTML =
        '<div class="login-panel">' +
            '<h2>🔑 Recuperar senha</h2>' +
            '<div class="sub">Informe seu e-mail. Se existir uma conta, enviaremos um link de redefinição válido por 30 minutos.</div>' +
            '<div class="login-form">' +
                '<label>E-mail</label><input id="recEmail" type="email" placeholder="voce@email.com">' +
                '<div class="login-erro" id="recErro"></div>' +
                '<button class="btn btn-amarelo" onclick="enviarEsqueciSenha()">Enviar link de redefinição</button>' +
                '<button class="btn btn-ghost" onclick="abrirModalLogin()">Voltar</button>' +
            '</div>' +
        '</div>';
}
async function enviarEsqueciSenha(){
    const email = document.getElementById("recEmail").value.trim();
    const erroEl = document.getElementById("recErro");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { erroEl.textContent = "Informe um e-mail válido."; return; }
    try {
        const d = await apiPost("/api/auth/senha-recuperacao", { email });
        erroEl.style.color = "var(--verde)";
        erroEl.textContent = "✅ " + (d.mensagem || "Se existir uma conta, enviaremos o link de redefinição.");
    } catch(e){
        erroEl.style.color = "";
        erroEl.textContent = e.message;
    }
}
async function fazerLogin(){
    const email = document.getElementById("lgEmail").value.trim();
    const senha = document.getElementById("lgSenha").value;
    try {
        const d = await apiPost("/api/auth/login", { email, senha });
        salvarSessao(d);
        fecharModal();
        toast("Bem-vindo de volta, " + (d.usuario.nome || "") + "!", "ok");
        carregarAlbum();
    } catch(e){ document.getElementById("lgErro").textContent = e.message; }
}
async function fazerRegistro(){
    const nome = document.getElementById("rgNome").value.trim();
    const email = document.getElementById("rgEmail").value.trim();
    const senha = document.getElementById("rgSenha").value;
    if (!nome || !email || senha.length < 6) { document.getElementById("rgErro").textContent = "Preencha todos os campos (senha mín. 6)."; return; }
    try {
        const d = await apiPost("/api/auth/registrar", { nome, email, senha });
        salvarSessao(d);
        fecharModal();
        toast("Conta criada! Bem-vindo(a), " + nome + "! 🎉", "ok");
        carregarAlbum();
    } catch(e){ document.getElementById("rgErro").textContent = e.message; }
}
function salvarSessao(d){
    minhaConta = { token: d.token, usuario: d.usuario };
    localStorage.setItem("mega_conta", JSON.stringify(minhaConta));
    atualizarHeader();
    iniciarPollingNotificacoes();
}

async function sairConta(){
    const token = minhaConta && minhaConta.token;
    minhaConta = null;
    localStorage.removeItem("mega_conta");
    atualizarHeader();
    pararSSENotificacoes();
    const badge = document.getElementById("notificacoesBadge");
    if (badge) badge.style.display = "none";
    const bar = document.getElementById("sessaoBar");
    if (bar) { bar.style.display = "none"; bar.innerHTML = ""; }
    try {
        if (token) await fetch("/api/auth/logout", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token }
        });
    } catch(e){ /* logout local é suficiente */ }
    toast("Você saiu da sua conta.", "ok");
    mudarAba("album");
}

function fecharModal(){
    document.getElementById("modalOverlay").classList.add("hidden");
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

/* =========================================================
   INICIALIZAÇÃO
========================================================= */
window.addEventListener("load", () => {
    const mp = new URLSearchParams(window.location.search).get("mercadopago");
    if (mp === "connected") {
        toast("🟢 Mercado Pago conectado com sucesso!", "ok");
    } else if (mp === "error") {
        toast("🔴 Não foi possível conectar o Mercado Pago. Verifique se a aplicação está habilitada como Marketplace no painel do Mercado Pago.", "erro");
    }
    if (mp) {
        const url = new URL(window.location.href);
        url.searchParams.delete("mercadopago");
        window.history.replaceState({}, "", url.toString());
    }
    atualizarHeader();
    carregarInfo().then(() => {
        const params = new URLSearchParams(window.location.search);
        const sellerId = params.get("sellerId");
        const negociarCom = params.get("negociarCom");
        
        if (sellerId) {
            mudarAba("mercado");
            estado.mercado.filtroVendedor = sellerId;
            carregarMercado(1);
        } else if (negociarCom) {
            mudarAba("mercado");
            abrirModalNovaOfertaParaUsuario(negociarCom);
        } else {
            mudarAba("album");
        }
        
        const match = window.location.hash.match(/^#figurinha-(\d+)$/);
        if (match) setTimeout(() => abrirModalFigurinha(Number(match[1])), 250);
    });
    iniciarPollingColecionaveis();
});

/* ===== POLLING INTELIGENTE =====
   Atualiza a aba visível a cada 15s; pausa quando a aba do
   navegador está oculta e retoma ao voltar (visibilidade). */
let _pollColTimer = null;
function iniciarPollingColecionaveis(){
    if (_pollColTimer) clearInterval(_pollColTimer);
    _pollColTimer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        const aba = estado.aba || "album";
        try {
            if (aba === "mercado") carregarMercado(estado.mercado.pagina || 1);
            else if (aba === "ofertas") carregarOfertas();
            else if (aba === "leiloes") carregarLeiloes();
            else if (aba === "trocas") carregarTrocas();
            else if (aba === "acervo") carregarAcervo();
        } catch(e){ /* ignora falha pontual de polling */ }
    }, 15000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && estado.aba === "ofertas") carregarOfertas();
    });
}
