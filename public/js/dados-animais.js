/*
 * Catálogo científico versionado da coleção "Animais do Mundo".
 *
 * Fontes de referência:
 * - IUCN Red List, https://www.iucnredlist.org (categoria de conservação).
 * - Animal Diversity Web, https://animaldiversity.org (classe, dieta e medidas).
 *
 * As medidas são faixas aproximadas de adultos e podem variar por sexo,
 * população e critério de medição. Ausência de confirmação fica explícita.
 */
(function (global) {
    "use strict";

    const FONTE = "IUCN Red List; Animal Diversity Web (consulta: 2026-08-19)";
    const OBSERVACAO = "Valores aproximados para adultos; a categoria pode variar por subespécie. Não informado quando não há dado verificável neste catálogo.";

    const DADOS_ANIMAIS = {
        "Leão-africano": ["Mammalia", "Carnívora", "1,4–2,5 m", "Vulnerável"],
        "Onça-pintada": ["Mammalia", "Carnívora", "1,1–1,9 m", "Quase ameaçada"],
        "Elefante-africano": ["Mammalia", "Herbívora", "3–4 m", "Em perigo"],
        "Girafa": ["Mammalia", "Herbívora", "3,8–4,7 m", "Vulnerável"],
        "Zebra-das-planícies": ["Mammalia", "Herbívora", "2,2–2,5 m", "Quase ameaçada"],
        "Hipopótamo-comum": ["Mammalia", "Herbívora", "2,9–5,1 m", "Vulnerável"],
        "Rinoceronte-branco": ["Mammalia", "Herbívora", "3,7–4,0 m", "Quase ameaçada"],
        "Búfalo-africano": ["Mammalia", "Herbívora", "2,1–3,4 m", "Quase ameaçada"],
        "Guepardo": ["Mammalia", "Carnívora", "1,1–1,4 m", "Vulnerável"],
        "Leopardo-africano": ["Mammalia", "Carnívora", "0,9–1,9 m", "Vulnerável"],
        "Suricato": ["Mammalia", "Onívora", "25–35 cm", "Pouco preocupante"],
        "Canguru-vermelho": ["Mammalia", "Herbívora", "1,3–1,6 m", "Pouco preocupante"],
        "Coala": ["Mammalia", "Herbívora", "60–85 cm", "Vulnerável"],
        "Ornitorrinco": ["Mammalia", "Carnívora", "40–50 cm", "Quase ameaçada"],
        "Diabo-da-tasmânia": ["Mammalia", "Carnívora", "50–80 cm", "Em perigo"],
        "Cão-da-pradaria": ["Mammalia", "Herbívora", "28–35 cm", "Pouco preocupante"],
        "Lobo-cinzento": ["Mammalia", "Carnívora", "1,0–1,6 m", "Pouco preocupante"],
        "Raposa-vermelha": ["Mammalia", "Onívora", "45–90 cm", "Pouco preocupante"],
        "Urso-pardo": ["Mammalia", "Onívora", "1,5–2,8 m", "Pouco preocupante"],
        "Urso-polar": ["Mammalia", "Carnívora", "2,0–2,5 m", "Vulnerável"],
        "Urso-negro-americano": ["Mammalia", "Onívora", "1,2–2,0 m", "Pouco preocupante"],
        "Panda-gigante": ["Mammalia", "Herbívora", "1,2–1,9 m", "Vulnerável"],
        "Alce": ["Mammalia", "Herbívora", "2,4–3,2 m", "Pouco preocupante"],
        "Veado-de-cauda-branca": ["Mammalia", "Herbívora", "1,6–2,2 m", "Pouco preocupante"],
        "Bisão-americano": ["Mammalia", "Herbívora", "2,1–3,5 m", "Quase ameaçada"],
        "Carneiro-da-montanha": ["Mammalia", "Herbívora", "1,5–1,8 m", "Pouco preocupante"],
        "Lhama": ["Mammalia", "Herbívora", "1,1–1,2 m", "Não avaliada"],
        "Guanaco": ["Mammalia", "Herbívora", "1,0–1,2 m", "Pouco preocupante"],
        "Puma": ["Mammalia", "Carnívora", "1,0–1,5 m", "Pouco preocupante"],
        "Jaguatirica": ["Mammalia", "Carnívora", "55–100 cm", "Pouco preocupante"],
        "Anta-brasileira": ["Mammalia", "Herbívora", "1,8–2,5 m", "Vulnerável"],
        "Capivara": ["Mammalia", "Herbívora", "1,0–1,3 m", "Pouco preocupante"],
        "Tatu-galinha": ["Mammalia", "Onívora", "40–60 cm", "Pouco preocupante"],
        "Tamanduá-bandeira": ["Mammalia", "Insetívora", "1,8–2,2 m", "Vulnerável"],
        "Bicho-preguiça": ["Mammalia", "Herbívora", "40–75 cm", "Pouco preocupante"],
        "Macaco-prego": ["Mammalia", "Onívora", "30–56 cm", "Pouco preocupante"],
        "Mico-leão-dourado": ["Mammalia", "Onívora", "20–34 cm", "Em perigo"],
        "Arara-azul": ["Aves", "Herbívora", "90–100 cm", "Vulnerável"],
        "Tucano-toco": ["Aves", "Onívora", "50–61 cm", "Pouco preocupante"],
        "Beija-flor-tesoura": ["Aves", "Nectarívora", "15–18 cm", "Pouco preocupante"],
        "Pinguim-imperador": ["Aves", "Carnívora", "100–130 cm", "Quase ameaçada"],
        "Águia-careca": ["Aves", "Carnívora", "70–102 cm", "Pouco preocupante"],
        "Coruja-buraqueira": ["Aves", "Carnívora", "19–28 cm", "Pouco preocupante"],
        "Falcão-peregrino": ["Aves", "Carnívora", "34–58 cm", "Pouco preocupante"],
        "Pavão-indiano": ["Aves", "Onívora", "90–230 cm", "Pouco preocupante"],
        "Flamingo-chileno": ["Aves", "Onívora", "95–105 cm", "Quase ameaçada"],
        "Golfinho-nariz-de-garrafa": ["Mammalia", "Carnívora", "1,9–3,9 m", "Pouco preocupante"],
        "Orca": ["Mammalia", "Carnívora", "6–8 m", "Não avaliada"],
        "Baleia-jubarte": ["Mammalia", "Carnívora", "12–16 m", "Pouco preocupante"],
        "Tubarão-branco": ["Chondrichthyes", "Carnívora", "3,5–6 m", "Vulnerável"],
        "Tubarão-martelo": ["Chondrichthyes", "Carnívora", "2,5–4,2 m", "Criticamente em perigo"],
        "Tartaruga-verde": ["Reptilia", "Herbívora", "80–120 cm", "Em perigo"],
        "Jacaré-de-papo-amarelo": ["Reptilia", "Carnívora", "1,5–2,5 m", "Pouco preocupante"],
        "Camaleão-pantera": ["Reptilia", "Insetívora", "35–45 cm", "Pouco preocupante"],
        "Iguana-verde": ["Reptilia", "Herbívora", "1,2–2,0 m", "Pouco preocupante"],
        "Serpente-real": ["Reptilia", "Carnívora", "3–5 m", "Vulnerável"],
        "Sapo-cururu": ["Amphibia", "Insetívora", "10–15 cm", "Pouco preocupante"],
        "Polvo-comum": ["Cephalopoda", "Carnívora", "25–100 cm", "Não avaliada"],
        "Caranguejo-eremita": ["Malacostraca", "Onívora", "2–15 cm", "Não avaliada"],
        "Abelha-europeia": ["Insecta", "Herbívora", "1,2–1,5 cm", "Não avaliada"],
        "Okapi": ["Mammalia", "Herbívora", "1,9–2,5 m", "Em perigo"],
        "Saiga": ["Mammalia", "Herbívora", "1,0–1,5 m", "Criticamente em perigo"],
        "Fossa": ["Mammalia", "Carnívora", "61–80 cm", "Vulnerável"],
        "Aie-aie": ["Mammalia", "Onívora", "36–44 cm", "Criticamente em perigo"],
        "Lêmure-de-cauda-anelada": ["Mammalia", "Onívora", "39–46 cm", "Em perigo"],
        "Quokka": ["Mammalia", "Herbívora", "40–54 cm", "Vulnerável"],
        "Dugongo": ["Mammalia", "Herbívora", "2,4–3,0 m", "Vulnerável"],
        "Peixe-boi-amazônico": ["Mammalia", "Herbívora", "2,0–2,8 m", "Vulnerável"],
        "Axolote": ["Amphibia", "Carnívora", "15–30 cm", "Criticamente em perigo"],
        "Geco-leopardo": ["Reptilia", "Insetívora", "18–25 cm", "Pouco preocupante"],
        "Narval": ["Mammalia", "Carnívora", "3,8–5,5 m", "Pouco preocupante"],
        "Beluga": ["Mammalia", "Carnívora", "3,5–5,5 m", "Quase ameaçada"],
        "Urso-de-óculos": ["Mammalia", "Onívora", "1,2–2,0 m", "Vulnerável"],
        "Lobo-guará": ["Mammalia", "Onívora", "95–115 cm", "Quase ameaçada"],
        "Cachorro-do-mato": ["Mammalia", "Onívora", "60–70 cm", "Pouco preocupante"],
        "Gato-mourisco": ["Mammalia", "Carnívora", "50–70 cm", "Pouco preocupante"],
        "Gato-palheiro": ["Mammalia", "Carnívora", "46–65 cm", "Quase ameaçada"],
        "Veado-campeiro": ["Mammalia", "Herbívora", "1,1–1,3 m", "Quase ameaçada"],
        "Cutia": ["Mammalia", "Herbívora", "40–60 cm", "Pouco preocupante"],
        "Paca": ["Mammalia", "Herbívora", "60–80 cm", "Pouco preocupante"],
        "Ouriço-cacheiro": ["Mammalia", "Herbívora", "60–90 cm", "Pouco preocupante"],
        "Musaranho-elefante": ["Mammalia", "Onívora", "22–31 cm", "Pouco preocupante"],
        "Tarsius": ["Mammalia", "Insetívora", "9–16 cm", "Em perigo"],
        "Pangolim": ["Mammalia", "Insetívora", "30–100 cm", "Criticamente em perigo"],
        "Pica-pau-imperador": ["Aves", "Insetívora", "56–60 cm", "Criticamente em perigo"],
        "Vaquita": ["Mammalia", "Carnívora", "1,4–1,5 m", "Criticamente em perigo"],
        "Lince-ibérico": ["Mammalia", "Carnívora", "80–100 cm", "Vulnerável"],
        "Leopardo-das-neves": ["Mammalia", "Carnívora", "90–120 cm", "Vulnerável"],
        "Tigre-de-bengala": ["Mammalia", "Carnívora", "2,4–3,1 m", "Em perigo"],
        "Dragão-de-komodo": ["Reptilia", "Carnívora", "2–3 m", "Em perigo"],
        "Mandril": ["Mammalia", "Onívora", "55–95 cm", "Vulnerável"],
        "Macaco-narigudo": ["Mammalia", "Herbívora", "53–76 cm", "Em perigo"],
        "Lobo-marinho-das-galápagos": ["Mammalia", "Carnívora", "1,2–1,5 m", "Em perigo"],
        "Tartaruga-de-couro": ["Reptilia", "Carnívora", "1,2–1,9 m", "Vulnerável"],
        "Águia-dourada": ["Aves", "Carnívora", "66–102 cm", "Pouco preocupante"],
        "Gorila-da-montanha": ["Mammalia", "Herbívora", "1,2–1,8 m", "Criticamente em perigo"],
        "Condor-andino": ["Aves", "Carnívora", "1,0–1,3 m", "Vulnerável"],
        "Rinoceronte-de-sumatra": ["Mammalia", "Herbívora", "2,4–3,2 m", "Criticamente em perigo"],
        "Baleia-azul": ["Mammalia", "Carnívora", "24–30 m", "Em perigo"],
        "Lula-colossal": ["Cephalopoda", "Carnívora", "Não informado", "Não avaliada"]
    };

    const resultado = {};
    Object.keys(DADOS_ANIMAIS).forEach(function (nome) {
        const d = DADOS_ANIMAIS[nome];
        resultado[nome] = {
            classe: d[0], dieta: d[1], comprimento: d[2], conservacao: d[3],
            fonte: FONTE, observacao: OBSERVACAO
        };
    });

    const exportado = { DADOS_ANIMAIS: resultado, FONTE, OBSERVACAO };
    if (typeof module !== "undefined" && module.exports) module.exports = exportado;
    else global.ANIMAIS_DADOS_CIENTIFICOS = exportado;
})(typeof window !== "undefined" ? window : globalThis);
