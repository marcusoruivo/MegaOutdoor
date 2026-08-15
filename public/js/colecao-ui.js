/* =========================================================
   MILHÃO DOOR — ANIMAIS DO MUNDO | LÓGICA VISUAL COMPARTILHADA
   Módulo de frontend usado por colecionaveis.html, admin.html
   e também pelo teste node (test-col-visual.js).

   Responsabilidades (100% determinísticas, derivadas de dados
   que o backend já envia — NÃO decide sorteio):
   - Acabamento OURO / CROMADA (variantes de figurinhas existentes)
   - Emoji da espécie e bioma visual
   - Construtores de HTML dos cards premium
   - Filtros + pesquisa do álbum
   - Resumo da coleção
   - Marcação NOVA / REPETIDA na abertura de pacote
========================================================= */
(function (global) {
    "use strict";

    /* ===== utilitários ===== */
    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function padNum(n) {
        return "#" + String(n == null ? "" : n).padStart(3, "0");
    }

    function nomeRaridade(r) {
        return { COMUM: "COMUM", INCOMUM: "INCOMUM", RARA: "RARA", EPICA: "ÉPICA",
                 LENDARIA: "LENDÁRIA", MITICA: "MÍTICA" }[r] || r;
    }

    function emojiRaridade(r) {
        return { COMUM: "⚪", INCOMUM: "🟢", RARA: "🔵", EPICA: "🟣",
                 LENDARIA: "🟡", MITICA: "🔴" }[r] || "🃏";
    }

    /* ===== ACABAMENTO OURO / CROMADA =====
       Determinístico pelo id da figurinha (estável entre aberturas).
       São VARIANTES especiais de figurinhas existentes — nunca novas
       espécies. Apenas raridades altas podem ter acabamento, o que as
       torna muito mais raras que a versão normal. */
    function hashCardId(id) {
        let h = 2166136261 >>> 0;
        const s = String(id);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function calcularFinish(id, rarity) {
        const h = hashCardId(id) % 100;
        if (rarity === "MITICA") return "cromada";
        if (rarity === "LENDARIA") return h < 50 ? "ouro" : "cromada";
        if (rarity === "EPICA") return h < 55 ? "ouro" : (h < 80 ? "cromada" : "normal");
        if (rarity === "RARA") return h < 35 ? "ouro" : (h < 50 ? "cromada" : "normal");
        return "normal";
    }

    function finishDeCard(card) {
        return calcularFinish(card.id, card.rarity || "COMUM");
    }

    function finishNome(finish) {
        return finish === "ouro" ? "OURO" : finish === "cromada" ? "CROMADA" : "";
    }

    /* ===== EMOJI DA ESPÉCIE =====
       Dicionário com as 100 espécies reais do catálogo. */
    const EMOJI_ANIMAIS = {
        "Leão-africano": "🦁",
        "Onça-pintada": "🐆",
        "Elefante-africano": "🐘",
        "Girafa": "🦒",
        "Zebra-das-planícies": "🦓",
        "Hipopótamo-comum": "🦛",
        "Rinoceronte-branco": "🦏",
        "Búfalo-africano": "🐃",
        "Guepardo": "🐆",
        "Leopardo-africano": "🐆",
        "Suricato": "🐾",
        "Canguru-vermelho": "🦘",
        "Coala": "🐨",
        "Ornitorrinco": "🦫",
        "Diabo-da-tasmânia": "🦡",
        "Cão-da-pradaria": "🐿️",
        "Lobo-cinzento": "🐺",
        "Raposa-vermelha": "🦊",
        "Urso-pardo": "🐻",
        "Urso-polar": "🐻‍❄️",
        "Urso-negro-americano": "🐻",
        "Panda-gigante": "🐼",
        "Alce": "🦌",
        "Veado-de-cauda-branca": "🦌",
        "Bisão-americano": "🦬",
        "Carneiro-da-montanha": "🐏",
        "Lhama": "🦙",
        "Guanaco": "🦙",
        "Puma": "🐆",
        "Jaguatirica": "🐆",
        "Anta-brasileira": "🐾",
        "Capivara": "🦫",
        "Tatu-galinha": "🦔",
        "Tamanduá-bandeira": "🐜",
        "Bicho-preguiça": "🦥",
        "Macaco-prego": "🐒",
        "Mico-leão-dourado": "🐒",
        "Arara-azul": "🦜",
        "Tucano-toco": "🦜",
        "Beija-flor-tesoura": "🐦",
        "Pinguim-imperador": "🐧",
        "Águia-careca": "🦅",
        "Coruja-buraqueira": "🦉",
        "Falcão-peregrino": "🦅",
        "Pavão-indiano": "🦚",
        "Flamingo-chileno": "🦩",
        "Golfinho-nariz-de-garrafa": "🐬",
        "Orca": "🐋",
        "Baleia-jubarte": "🐋",
        "Tubarão-branco": "🦈",
        "Tubarão-martelo": "🦈",
        "Tartaruga-verde": "🐢",
        "Jacaré-de-papo-amarelo": "🐊",
        "Camaleão-pantera": "🦎",
        "Iguana-verde": "🦎",
        "Serpente-real": "🐍",
        "Sapo-cururu": "🐸",
        "Polvo-comum": "🐙",
        "Caranguejo-eremita": "🦀",
        "Abelha-europeia": "🐝",
        "Okapi": "🦓",
        "Saiga": "🐐",
        "Fossa": "🐈",
        "Aie-aie": "🐒",
        "Lêmure-de-cauda-anelada": "🐒",
        "Quokka": "🦘",
        "Dugongo": "🐬",
        "Peixe-boi-amazônico": "🦭",
        "Axolote": "🦎",
        "Geco-leopardo": "🦎",
        "Narval": "🐬",
        "Beluga": "🐳",
        "Urso-de-óculos": "🐻",
        "Lobo-guará": "🐺",
        "Cachorro-do-mato": "🐺",
        "Gato-mourisco": "🐈",
        "Gato-palheiro": "🐈",
        "Veado-campeiro": "🦌",
        "Cutia": "🐿️",
        "Paca": "🐿️",
        "Ouriço-cacheiro": "🦔",
        "Musaranho-elefante": "🐭",
        "Tarsius": "🐒",
        "Pangolim": "🦔",
        "Pica-pau-imperador": "🐦",
        "Vaquita": "🐬",
        "Lince-ibérico": "🐆",
        "Leopardo-das-neves": "🐆",
        "Tigre-de-bengala": "🐯",
        "Dragão-de-komodo": "🦎",
        "Mandril": "🐒",
        "Macaco-narigudo": "🐒",
        "Lobo-marinho-das-galápagos": "🦭",
        "Tartaruga-de-couro": "🐢",
        "Águia-dourada": "🦅",
        "Gorila-da-montanha": "🦍",
        "Condor-andino": "🦅",
        "Rinoceronte-de-sumatra": "🦏",
        "Baleia-azul": "🐳",
        "Lula-colossal": "🦑"
    };

    const EMOJI_FALLBACK_BIOMA = {
        "oceano": "🐳",
        "savana": "🦁",
        "floresta": "🦌",
        "deserto": "🦂",
        "montanha": "🦅",
        "rio": "🐟",
        "campo": "🐄",
        "artico": "🐻‍❄️",
        "mundo": "🌍"
    };

    function emojiAnimal(card) {
        const nome = (card && card.name) || "";
        if (EMOJI_ANIMAIS[nome]) return EMOJI_ANIMAIS[nome];
        const bio = classeBioma(card && card.habitat);
        const chave = {
            "bio-oceano": "oceano", "bio-savana": "savana", "bio-floresta": "floresta",
            "bio-deserto": "deserto", "bio-montanha": "montanha", "bio-rio": "rio",
            "bio-campo": "campo", "bio-artico": "artico", "bio-regiao": "mundo", "bio-generico": "mundo"
        }[bio] || "mundo";
        return EMOJI_FALLBACK_BIOMA[chave] || "🐾";
    }

    /* ===== BIOMA VISUAL ===== */
    function classeBioma(habitat) {
        const h = String(habitat || "").toLowerCase();
        if (/oceano|mar|águas|antártic|ártico|gelo|salinas|ilh/.test(h)) return "bio-oceano";
        if (/savan/.test(h)) return "bio-savana";
        if (/florest|mata|tropical|bambu/.test(h)) return "bio-floresta";
        if (/desert|estep/.test(h)) return "bio-deserto";
        if (/montan|and|península|ibérica/.test(h)) return "bio-montanha";
        if (/rio|lagos|lago|alagad|pantanal|várzea|banhad/.test(h)) return "bio-rio";
        if (/pradaria|campo|cerrado|pampa/.test(h)) return "bio-campo";
        if (/índia|ásia|bornéu|sumatra|sudeste|méxico|galápagos|madagascar|congo|australia|tasmania|nova/.test(h)) return "bio-regiao";
        return "bio-generico";
    }

    /* ===== CONSTRUTORES DE HTML ===== */

    /* Área de arte da figurinha (imagem grande). Usa image_url se houver,
       senão o emoji da espécie sobre gradiente do bioma. */
    function particulasHtml(finish, n) {
        const cls = finish === "ouro" ? "cc-part-ouro" : "cc-part-croma";
        let html = "";
        for (let i = 0; i < (n || 0); i++) {
            const left = (12 + ((i * 37 + 11) % 76)).toFixed(1);
            const top = (14 + ((i * 53 + 7) % 70)).toFixed(1);
            const delay = ((i % 4) * 0.7 + 0.1).toFixed(2);
            html += '<span class="cc-part ' + cls + '" style="left:' + left + '%;top:' + top + '%;animation-delay:' + delay + 's"></span>';
        }
        return html;
    }

    function arteHtml(card, extraClass, opcoes) {
        const bio = classeBioma(card.habitat);
        const finish = finishDeCard(card);
        const cls = ["cc-arte", bio, "cc-fin-" + finish, extraClass || ""].join(" ");
        let conteudo;
        if (card.image_url) {
            conteudo = '<img class="cc-img" src="' + esc(card.image_url) + '" alt="' + esc(card.name || "") + '" loading="lazy" decoding="async">';
        } else {
            conteudo = '<span class="cc-emoji">' + emojiAnimal(card) + '</span>';
        }
        return '<div class="' + cls + '">' +
            conteudo +
            '<span class="cc-glow"></span>' +
            '<span class="cc-shine"></span>' +
            (finish !== "normal" ? particulasHtml(finish, (opcoes && opcoes.particulas) || 0) : "") +
        '</div>';
    }

    /* Moldura/aro por raridade (para o card inteiro). */
    function clsRaridade(r) {
        return "r-" + r;
    }

    function metaHtml(card) {
        const partes = [];
        if (card.habitat) partes.push('🌍 ' + esc(card.habitat));
        if (card.peso) partes.push('⚖️ ' + esc(card.peso));
        return partes.length ? '<div class="cc-meta">' + partes.join('<span class="cc-meta-sep">•</span>') + '</div>' : "";
    }

    function pillRaridade(r) {
        return '<span class="cc-pill pill-' + r + '">' + nomeRaridade(r) + '</span>';
    }

    /* Card do álbum (possuído ou bloqueado). */
    function cardColecaoHtml(card) {
        const tem = Number(card.quantidade || 0) > 0;
        const r = card.rarity || "COMUM";
        const finish = finishDeCard(card);
        const numero = padNum(card.number);
        const finishBadge = finish !== "normal"
            ? '<span class="cc-finish-badge fin-' + finish + '">' + finishNome(finish) + '</span>'
            : "";

        if (!tem) {
            return '<div class="colecao-card cc-bloqueada" data-nome="" data-rarity="' + esc(r) + '" data-finish="' + finish + '" onclick="mostrarBloqueada()">' +
                '<div class="cc-topo">' +
                    '<span class="cc-num">' + numero + '</span>' +
                    '<span class="cc-simbolo">' + (finish === "ouro" ? "◈" : finish === "cromada" ? "◇" : "?" ) + '</span>' +
                '</div>' +
                '<div class="cc-arte cc-arte-bloq bio-generico"><span class="cc-emoji cc-silhueta">' + emojiAnimal(card) + '</span><span class="cc-lock">🔒</span></div>' +
                '<div class="cc-info">' +
                    '<div class="cc-nome cc-nome-bloq">???</div>' +
                    '<div class="cc-sn">Figurinha bloqueada</div>' +
                '</div>' +
            '</div>';
        }

        return '<div class="colecao-card ' + clsRaridade(r) + ' cc-fin-' + finish + '" data-nome="' + esc(String(card.name || "").toLowerCase()) + '" data-rarity="' + esc(r) + '" data-finish="' + finish + '" onclick="abrirModalFigurinha(' + card.id + ')">' +
            '<div class="cc-topo">' +
                '<span class="cc-num">' + numero + '</span>' +
                '<span class="cc-simbolo">' + (finish === "ouro" ? "◈" : finish === "cromada" ? "◇" : emojiRaridade(r)) + '</span>' +
            '</div>' +
            arteHtml(card) +
            '<div class="cc-info">' +
                '<div class="cc-info-row">' + pillRaridade(r) + finishBadge + '</div>' +
                '<div class="cc-nome">' + esc(card.name) + '</div>' +
                '<div class="cc-sn">' + esc(card.scientific_name || "") + '</div>' +
                metaHtml(card) +
                '<div class="cc-qtd">Possui: <b>' + card.quantidade + 'x</b>' + (Number(card.quantidade) > 1 ? ' <span class="cc-rep">🔁 repetida</span>' : '') + '</div>' +
            '</div>' +
        '</div>';
    }

    /* Card de revelação (pacote) — com destaque NOVA / REPETIDA. */
    function cardRevelacaoHtml(card, i, marcacao) {
        const r = card.rarity || "COMUM";
        const finish = finishDeCard(card);
        const nova = marcacao && marcacao.nova;
        return '<div class="rev-card ' + clsRaridade(r) + ' cc-fin-' + finish + ' rev-novo" style="animation-delay:' + (i * 80) + 'ms">' +
            '<div class="shine"></div>' +
            '<div class="rev-num">' + padNum(card.number) + '</div>' +
            arteHtml(card, "cc-arte-rev", { particulas: 2 }) +
            '<div class="rev-info">' +
                '<div class="rev-info-row">' + pillRaridade(r) +
                    (finish !== "normal" ? '<span class="cc-finish-badge fin-' + finish + '">' + finishNome(finish) + '</span>' : "") +
                '</div>' +
                '<div class="rev-nome">' + esc(card.name) + '</div>' +
                '<div class="rev-sn">' + esc(card.scientific_name || "") + '</div>' +
                metaHtml(card) +
                (nova
                    ? '<div class="rev-flag rev-flag-nova">✨ NOVA FIGURINHA!</div>'
                    : '<div class="rev-flag rev-flag-rep">🔁 REPETIDA</div>') +
            '</div>' +
        '</div>';
    }

    /* Card grande (modal / admin preview). */
    function cardGrandeHtml(card) {
        const r = card.rarity || "COMUM";
        const finish = finishDeCard(card);
        const finishBadge = finish !== "normal"
            ? '<span class="cc-finish-badge fin-' + finish + '">' + finishNome(finish) + '</span>'
            : "";
        return '<div class="colecao-card cc-grande ' + clsRaridade(r) + ' cc-fin-' + finish + '">' +
            '<div class="cc-topo">' +
                '<span class="cc-num">' + padNum(card.number) + '</span>' +
                '<span class="cc-simbolo">' + (finish === "ouro" ? "◈" : finish === "cromada" ? "◇" : emojiRaridade(r)) + '</span>' +
            '</div>' +
            arteHtml(card, "cc-arte-grande", { particulas: 4 }) +
            '<div class="cc-info">' +
                '<div class="cc-info-row">' + pillRaridade(r) + finishBadge + '</div>' +
                '<div class="cc-nome">' + esc(card.name) + '</div>' +
                '<div class="cc-sn">' + esc(card.scientific_name || "") + '</div>' +
                metaHtml(card) +
            '</div>' +
            '<div class="cc-rodape">MILHÃO DOOR · ANIMAIS DO MUNDO</div>' +
        '</div>';
    }

    /* ===== FILTROS + PESQUISA (álbum) ===== */
    function filtrarCards(cards, opcoes) {
        const filtro = (opcoes && opcoes.filtro) || "todas";
        const busca = String((opcoes && opcoes.busca) || "").trim().toLowerCase();
        return (cards || []).filter(function (c) {
            const finish = finishDeCard(c);
            const r = c.rarity || "COMUM";
            if (filtro === "ouro") {
                if (finish !== "ouro") return false;
            } else if (filtro === "cromada") {
                if (finish !== "cromada") return false;
            } else if (filtro !== "todas" && r !== filtro) {
                return false;
            }
            if (busca) {
                const alvo = (String(c.name || "") + " " + String(c.scientific_name || "") + " " + String(c.habitat || "")).toLowerCase();
                if (alvo.indexOf(busca) === -1) return false;
            }
            return true;
        });
    }

    /* ===== RESUMO DA COLEÇÃO ===== */
    function resumoColecao(cards, total) {
        const possuidos = (cards || []).filter(function (c) { return Number(c.quantidade || 0) > 0; });
        const diferentes = possuidos.length;
        const repetidas = possuidos.reduce(function (a, c) { return a + Math.max(0, Number(c.quantidade || 0) - 1); }, 0);
        const totalGeral = total || 100;
        const porRaridade = function (rar) { return possuidos.filter(function (c) { return c.rarity === rar; }).length; };
        const comFinish = function (fin) { return possuidos.filter(function (c) { return finishDeCard(c) === fin; }).length; };
        return {
            diferentes: diferentes,
            repetidas: repetidas,
            total: totalGeral,
            progresso: totalGeral ? Math.round((diferentes / totalGeral) * 100) : 0,
            raras: porRaridade("RARA"),
            epicas: porRaridade("EPICA"),
            lendarias: porRaridade("LENDARIA"),
            miticas: porRaridade("MITICA"),
            ouro: comFinish("ouro"),
            cromadas: comFinish("cromada"),
            especiais: comFinish("ouro") + comFinish("cromada"),
            completo: diferentes >= totalGeral
        };
    }

    /* ===== NOVA / REPETIDA na abertura =====
       posse: objeto { cardId: quantidade_atual } *após* somar o pacote.
       figs:  array de figurinhas sorteadas (do pacote)
       Retorna array alinhado com figs: { nova, repetida }.
       Ex.: se você já tinha 1 leão e o pacote veio 2 leões,
            posse[id]=3 -> ambas são repetidas; se tinha 0 e veio 2,
            posse[id]=2 -> ambas são novas. */
    function marcarNovidades(posse, figs) {
        const porId = {};
        (figs || []).forEach(function (f) { porId[f.id] = (porId[f.id] || 0) + 1; });
        return (figs || []).map(function (f) {
            const atual = Number((posse && posse[f.id]) || 0);
            const antes = atual - (porId[f.id] || 0);
            return { nova: antes <= 0, repetida: antes > 0 };
        });
    }

    function packResumo(marcacoes) {
        return {
            novas: (marcacoes || []).filter(function (m) { return m.nova; }).length,
            repetidas: (marcacoes || []).filter(function (m) { return m.repetida; }).length
        };
    }

    /* Melhor carta do pacote para a grande revelação.
       Ordem: MÍTICA > LENDÁRIA > ÉPICA > RARA > INCOMUM > COMUM;
       empate → acabamento CROMADA > OURO > normal; empate final → 1ª. */
    function melhorDoPacote(figs) {
        const rank = { MITICA: 6, LENDARIA: 5, EPICA: 4, RARA: 3, INCOMUM: 2, COMUM: 1 };
        let melhor = null, melhorPts = -1;
        (figs || []).forEach(function (f) {
            const fin = finishDeCard(f);
            const pts = ((rank[f.rarity] || 0) * 10) + (fin === "cromada" ? 2 : fin === "ouro" ? 1 : 0);
            if (pts > melhorPts) { melhorPts = pts; melhor = f; }
        });
        return melhor;
    }

    function finishRank(fin) {
        return fin === "cromada" ? 2 : fin === "ouro" ? 1 : 0;
    }

    /* ===== exportação ===== */
    const API = {
        esc: esc,
        padNum: padNum,
        nomeRaridade: nomeRaridade,
        emojiRaridade: emojiRaridade,
        hashCardId: hashCardId,
        calcularFinish: calcularFinish,
        finishDeCard: finishDeCard,
        finishNome: finishNome,
        EMOJI_ANIMAIS: EMOJI_ANIMAIS,
        emojiAnimal: emojiAnimal,
        classeBioma: classeBioma,
        arteHtml: arteHtml,
        clsRaridade: clsRaridade,
        metaHtml: metaHtml,
        pillRaridade: pillRaridade,
        cardColecaoHtml: cardColecaoHtml,
        cardRevelacaoHtml: cardRevelacaoHtml,
        cardGrandeHtml: cardGrandeHtml,
        filtrarCards: filtrarCards,
        resumoColecao: resumoColecao,
        marcarNovidades: marcarNovidades,
        packResumo: packResumo,
        melhorDoPacote: melhorDoPacote,
        finishRank: finishRank
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = API;
    } else {
        global.ColecaoUI = API;
    }
})(typeof window !== "undefined" ? window : globalThis);
