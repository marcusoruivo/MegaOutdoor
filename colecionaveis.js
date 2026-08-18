/* =========================================================
   MEGAOUTDOOR COLECIONÁVEIS — Módulo Backend
   Sistema de figurinhas digitais colecionáveis.

   Independe da lógica de espaços/pagamentos existente.
   Reutiliza pgPool, authUsuario e criarOrderMercadoPago
   injetados pelo server.js.

   Este arquivo NÃO modifica nenhum fluxo existente.
   É montado como router em /api/colecionaveis.
========================================================= */

const express = require("express");
const crypto = require("crypto");

/* =========================================================
   CONFIGURAÇÃO
========================================================= */

const RARIDADES = {
    COMUM:    { chave: "COMUM",    nome: "COMUM",    icone: "⚪", cor: "#9e9e9e", peso: 55 },
    INCOMUM:  { chave: "INCOMUM",  nome: "INCOMUM",  icone: "🟢", cor: "#4caf50", peso: 20 },
    RARA:     { chave: "RARA",     nome: "RARA",     icone: "🔵", cor: "#2196f3", peso: 12 },
    EPICA:    { chave: "EPICA",    nome: "ÉPICA",    icone: "🟣", cor: "#9c27b0", peso: 7 },
    LENDARIA: { chave: "LENDARIA", nome: "LENDÁRIA", icone: "🟡", cor: "#ffb300", peso: 5 },
    MITICA:   { chave: "MITICA",   nome: "MÍTICA",   icone: "🔴", cor: "#e53935", peso: 1 }
};

const RARIDADE_ORDEM = [
    "COMUM", "INCOMUM", "RARA", "EPICA", "LENDARIA", "MITICA"
];

/* Probabilidades em % (somam 100%). Informadas ao usuário
   antes da compra. Configuráveis. */
const PROBABILIDADES = {
    COMUM: 55,
    INCOMUM: 20,
    RARA: 12,
    EPICA: 7,
    LENDARIA: 5,
    MITICA: 1
};

/* Recompensa mensal configurável pelo ambiente/admin. Sem período
   configurado, nenhuma recompensa comercial é criada por padrão. */
const MONTHLY_ALBUM_REWARD = {
    start: process.env.MONTHLY_ALBUM_START || null,
    end: process.env.MONTHLY_ALBUM_END || null,
    reward: process.env.MONTHLY_ALBUM_REWARD || "badge_album_completo_mes"
};

const PACKS_PADRAO = [
    {
        slug: "bronze",
        nome: "BRONZE",
        preco: 2,
        quantidade: 3,
        descricao: "3 figurinhas para começar sua coleção."
    },
    {
        slug: "prata",
        nome: "PRATA",
        preco: 5,
        quantidade: 8,
        descricao: "8 figurinhas com chances equilibradas."
    },
    {
        slug: "ouro",
        nome: "OURO",
        preco: 10,
        quantidade: 20,
        descricao: "20 figurinhas com melhores chances de raras."
    },
    {
        slug: "especial",
        nome: "ESPECIAL",
        preco: 20,
        quantidade: 45,
        descricao: "45 figurinhas — a melhor relação custo-benefício."
    }
];

const COLECAO_PADRAO = {
    slug: "primeira-edicao",
    nome: "MILHÃO DOOR — ANIMAIS DO MUNDO",
    edicao: "1ª EDIÇÃO",
    total: 100,
    descricao: "Coleção de figurinhas digitais com 100 espécies reais de animais do mundo inteiro, com dados científicos."
};

const MARKETPLACE_FEE_PERCENT = 10;
const TRADE_TTL_HORAS = 24;
const EXPIRA_BLOQUEIO_HORAS = 24;

/* Conquistas (sistema extensível: basta adicionar no array) */
const CONQUISTAS = [
    { slug: "primeira_figurinha",      nome: "PRIMEIRA FIGURINHA",      descricao: "Adquira sua primeira figurinha.",                     icone: "🃏" },
    { slug: "10_figurinhas",           nome: "10 FIGURINHAS",            descricao: "Acumule 10 figurinhas no acervo.",                    icone: "🔟" },
    { slug: "25_figurinhas",           nome: "25 FIGURINHAS",            descricao: "Acumule 25 figurinhas no acervo.",                    icone: "🖐️" },
    { slug: "50_figurinhas",           nome: "50 FIGURINHAS",            descricao: "Acumule 50 figurinhas no acervo.",                    icone: "🎯" },
    { slug: "100_figurinhas",          nome: "100 FIGURINHAS",           descricao: "Acumule 100 figurinhas no acervo.",                   icone: "💯" },
    { slug: "primeira_rara",           nome: "PRIMEIRA RARA",            descricao: "Adquira sua primeira figurinha RARA.",                icone: "🔵" },
    { slug: "primeira_epica",          nome: "PRIMEIRA ÉPICA",           descricao: "Adquira sua primeira figurinha ÉPICA.",               icone: "🟣" },
    { slug: "primeira_lendaria",       nome: "PRIMEIRA LENDÁRIA",        descricao: "Adquira sua primeira figurinha LENDÁRIA.",            icone: "🟡" },
    { slug: "primeira_mitica",         nome: "PRIMEIRA MÍTICA",          descricao: "Adquira sua primeira figurinha MÍTICA.",              icone: "🔴" },
    { slug: "metade_album",            nome: "50% DO ÁLBUM",             descricao: "Complete 50% do álbum (50 de 100).",                  icone: "📗" },
    { slug: "album_completo",          nome: "ÁLBUM COMPLETO",           descricao: "Complete as 100 figurinhas da 1ª edição.",            icone: "🏆" },
    { slug: "primeira_troca",          nome: "PRIMEIRA TROCA",           descricao: "Conclua sua primeira troca.",                         icone: "🔄" },
    { slug: "primeira_venda",          nome: "PRIMEIRA VENDA",           descricao: "Venda sua primeira figurinha no mercado.",            icone: "💰" }
];

/* Catálogo de 100 FIGURINHAS DE ANIMAIS REAIS do mundo.
   Distribuição por raridade:
   COMUM 60 · INCOMUM 25 · RARA 5 · ÉPICA 2 · LENDÁRIA 5 · MÍTICA 3 = 100
   Cada espécie traz nome científico, habitat e peso reais. */
const CATALOGO = (() => {
    const cards = [];
    const { IMAGENS_ANIMAIS, REGIOES_ANIMAIS } = require('./public/js/imagens-animais.js');

    const especies = [
        /* ===== COMUM (60) ===== */
        { name: "Leão-africano", sn: "Panthera leo", habitat: "Savanas", peso: "120–190 kg", desc: "O único felino que vive em grupos, as alcateias. O rugido pode ser ouvido a até 8 km." },
        { name: "Onça-pintada", sn: "Panthera onca", habitat: "Florestas tropicais", peso: "56–96 kg", desc: "Maior felino das Américas e o terceiro do mundo. Sua mordida é a mais forte entre os felinos." },
        { name: "Elefante-africano", sn: "Loxodonta africana", habitat: "Savanas e florestas", peso: "4.000–6.000 kg", desc: "O maior animal terrestre vivo. Suas orelhas ajudam a dissipar o calor." },
        { name: "Girafa", sn: "Giraffa camelopardalis", habitat: "Savanas", peso: "800–1.200 kg", desc: "O animal mais alto do mundo; tem o mesmo número de vértebras do pescoço que os humanos." },
        { name: "Zebra-das-planícies", sn: "Equus quagga", habitat: "Savanas", peso: "300–350 kg", desc: "Suas listras são únicas como impressões digitais e confundem predadores." },
        { name: "Hipopótamo-comum", sn: "Hippopotamus amphibius", habitat: "Rios e lagos", peso: "1.500–3.200 kg", desc: "Passa o dia na água, mas não sabe nadar: caminha no fundo dos rios." },
        { name: "Rinoceronte-branco", sn: "Ceratotherium simum", habitat: "Savanas", peso: "1.700–2.300 kg", desc: "Apesar do nome, sua coloração é acinzentada. Tem o segundo maior chifre entre os rinocerontes." },
        { name: "Búfalo-africano", sn: "Syncerus caffer", habitat: "Savanas", peso: "500–900 kg", desc: "Vive em grandes manadas e é considerado um dos animais mais perigosos da África." },
        { name: "Guepardo", sn: "Acinonyx jubatus", habitat: "Savanas", peso: "35–65 kg", desc: "O animal terrestre mais rápido, chegando a 110 km/h em rajadas curtas." },
        { name: "Leopardo-africano", sn: "Panthera pardus", habitat: "Savanas e florestas", peso: "30–90 kg", desc: "Excelente escalador: leva presas maiores que ele para o alto das árvores." },
        { name: "Suricato", sn: "Suricata suricatta", habitat: "Desertos", peso: "0,6–1 kg", desc: "Vive em grupos e tem sentinelas que ficam de vigia em pé sobre as patas traseiras." },
        { name: "Canguru-vermelho", sn: "Osphranter rufus", habitat: "Desertos da Austrália", peso: "18–85 kg", desc: "Maior marsupial do mundo; salta até 8 metros de comprimento." },
        { name: "Coala", sn: "Phascolarctos cinereus", habitat: "Florestas de eucalipto", peso: "4–14 kg", desc: "Dorme até 20 horas por dia e se alimenta quase só de folhas de eucalipto." },
        { name: "Ornitorrinco", sn: "Ornithorhynchus anatinus", habitat: "Rios da Austrália", peso: "0,7–2,4 kg", desc: "Mamífero que bota ovos, tem bico de pato e é um dos poucos venenosos do grupo." },
        { name: "Diabo-da-tasmânia", sn: "Sarcophilus harrisii", habitat: "Tasmânia", peso: "6–12 kg", desc: "Maior marsupial carnívoro vivo. Seu grito assustador ecoa à noite." },
        { name: "Cão-da-pradaria", sn: "Cynomys ludovicianus", habitat: "Pradarias", peso: "0,7–1,4 kg", desc: "Vive em colônias subterrâneas com 'cidades' que podem ter milhares de tocas." },
        { name: "Lobo-cinzento", sn: "Canis lupus", habitat: "Florestas e tundras", peso: "25–60 kg", desc: "Ancestral do cão doméstico; caça em matilhas com estratégia e comunicação." },
        { name: "Raposa-vermelha", sn: "Vulpes vulpes", habitat: "Florestas e campos", peso: "3–11 kg", desc: "Usa o campo magnético da Terra para caçar escondidas sob a neve." },
        { name: "Urso-pardo", sn: "Ursus arctos", habitat: "Florestas e montanhas", peso: "100–680 kg", desc: "Omnívoro poderoso; no inverno entra em dormência e pode passar meses sem comer." },
        { name: "Urso-polar", sn: "Ursus maritimus", habitat: "Gelo do Ártico", peso: "400–700 kg", desc: "Maior urso do mundo. Sua pele é preta por baixo da pelagem translúcida." },
        { name: "Urso-negro-americano", sn: "Ursus americanus", habitat: "Florestas", peso: "40–270 kg", desc: "Excelente nadador e escalador; pode correr a mais de 50 km/h." },
        { name: "Panda-gigante", sn: "Ailuropoda melanoleuca", habitat: "Florestas de bambu", peso: "70–120 kg", desc: "Símbolo de conservação; passa até 14 horas por dia comendo bambu." },
        { name: "Alce", sn: "Alces alces", habitat: "Florestas boreais", peso: "270–700 kg", desc: "Maior membro da família dos cervos; seus chifres podem medir 1,8 m." },
        { name: "Veado-de-cauda-branca", sn: "Odocoileus virginianus", habitat: "Florestas", peso: "40–120 kg", desc: "Levanta a cauda branca para alertar o grupo diante do perigo." },
        { name: "Bisão-americano", sn: "Bison bison", habitat: "Pradarias", peso: "320–1.000 kg", desc: "Símbolo das planícies norte-americanas; quase foi extinto no século XIX." },
        { name: "Carneiro-da-montanha", sn: "Ovis canadensis", habitat: "Montanhas", peso: "50–140 kg", desc: "Os machos disputam com choques de chifres que ecoam por quilômetros." },
        { name: "Lhama", sn: "Lama glama", habitat: "Andes", peso: "90–200 kg", desc: "Domesticada há milhares de anos; cuspe é sua defesa característica." },
        { name: "Guanaco", sn: "Lama guanicoe", habitat: "Andes", peso: "90–140 kg", desc: "Parente selvagem da lhama; vive em altas altitudes até 4.000 m." },
        { name: "Puma", sn: "Puma concolor", habitat: "Américas", peso: "30–100 kg", desc: "Segundo maior felino das Américas; adapta-se de florestas a desertos." },
        { name: "Jaguatirica", sn: "Leopardus pardalis", habitat: "Florestas tropicais", peso: "8–16 kg", desc: "Felino de porte médio com pelagem manchada que o camufla na mata." },
        { name: "Anta-brasileira", sn: "Tapirus terrestris", habitat: "Florestas e banhados", peso: "150–300 kg", desc: "Maior mamífero terrestre da América do Sul; 'jardineira da mata' por dispersar sementes." },
        { name: "Capivara", sn: "Hydrochoerus hydrochaeris", habitat: "Rios e várzeas", peso: "35–66 kg", desc: "Maior roedor do mundo; é ótima nadadora e vive em grupos." },
        { name: "Tatu-galinha", sn: "Dasypus novemcinctus", habitat: "Cerrado e mata", peso: "3–6 kg", desc: "Sua carapaça é feita de placas ósseas cobertas por escamas." },
        { name: "Tamanduá-bandeira", sn: "Myrmecophaga tridactyla", habitat: "Cerrado e campos", peso: "22–39 kg", desc: "Língua de até 60 cm que consome até 30 mil formigas por dia." },
        { name: "Bicho-preguiça", sn: "Bradypus variegatus", habitat: "Florestas tropicais", peso: "3–5 kg", desc: "Se move tão devagar que algas crescem em seu pelo." },
        { name: "Macaco-prego", sn: "Sapajus apella", habitat: "Florestas", peso: "1,3–4,8 kg", desc: "Um dos poucos primatas que usam ferramentas de pedra." },
        { name: "Mico-leão-dourado", sn: "Leontopithecus rosalia", habitat: "Mata Atlântica", peso: "0,5–0,7 kg", desc: "Símbolo da conservação brasileira; vive na Mata Atlântica do Rio de Janeiro." },
        { name: "Arara-azul", sn: "Anodorhynchus hyacinthinus", habitat: "Pantanal", peso: "1,2–1,7 kg", desc: "Maior arara do mundo e o maior psitacídeo em comprimento." },
        { name: "Tucano-toco", sn: "Ramphastos toco", habitat: "Cerrado e mata", peso: "0,5–0,8 kg", desc: "Seu bico enorme ajuda a regular a temperatura corporal." },
        { name: "Beija-flor-tesoura", sn: "Eupetomena macroura", habitat: "Jardins e matas", peso: "0,004–0,008 kg", desc: "Bate as asas até 80 vezes por segundo e pode voar para trás." },
        { name: "Pinguim-imperador", sn: "Aptenodytes forsteri", habitat: "Antártida", peso: "22–45 kg", desc: "Maior pinguim; o macho incuba o ovo no inverno antártico." },
        { name: "Águia-careca", sn: "Haliaeetus leucocephalus", habitat: "Lagos e rios", peso: "3–6 kg", desc: "Símbolo dos EUA; constrói ninhos entre os maiores das aves." },
        { name: "Coruja-buraqueira", sn: "Athene cunicularia", habitat: "Campos abertos", peso: "0,15–0,25 kg", desc: "Nidifica em buracos no chão e é ativa durante o dia." },
        { name: "Falcão-peregrino", sn: "Falco peregrinus", habitat: "Montanhas e cidades", peso: "0,5–1 kg", desc: "O animal mais rápido em mergulho, ultrapassando 300 km/h." },
        { name: "Pavão-indiano", sn: "Pavo cristatus", habitat: "Florestas da Índia", peso: "3–6 kg", desc: "A cauda do macho, em forma de leque, é usada na corte." },
        { name: "Flamingo-chileno", sn: "Phoenicopterus chilensis", habitat: "Salinas andinas", peso: "2–4 kg", desc: "Sua coloração rosada vem da dieta rica em carotenoides." },
        { name: "Golfinho-nariz-de-garrafa", sn: "Tursiops truncatus", habitat: "Oceanos", peso: "150–300 kg", desc: "Comunica-se por assobios; um dos animais mais inteligentes do mar." },
        { name: "Orca", sn: "Orcinus orca", habitat: "Oceanos", peso: "2.500–5.400 kg", desc: "Maior golfinho; caça em grupos coordenados com técnicas transmitidas entre gerações." },
        { name: "Baleia-jubarte", sn: "Megaptera novaeangliae", habitat: "Oceanos", peso: "25.000–30.000 kg", desc: "Famosa pelos saltos e cantos longos que viajam por oceanos." },
        { name: "Tubarão-branco", sn: "Carcharodon carcharias", habitat: "Oceanos temperados", peso: "680–1.100 kg", desc: "Maior peixe predador vivo; detecta um pingo de sangue a quilômetros." },
        { name: "Tubarão-martelo", sn: "Sphyrna lewini", habitat: "Águas costeiras", peso: "80–430 kg", desc: "A cabeça em forma de martelo amplia seu campo de visão." },
        { name: "Tartaruga-verde", sn: "Chelonia mydas", habitat: "Oceanos tropicais", peso: "65–190 kg", desc: "Faz migrações de milhares de quilômetros entre alimentação e desova." },
        { name: "Jacaré-de-papo-amarelo", sn: "Caiman latirostris", habitat: "Rios e alagados", peso: "15–40 kg", desc: "Quase extinto pela caça; é o jacaré símbolo do Brasil." },
        { name: "Camaleão-pantera", sn: "Furcifer pardalis", habitat: "Madagascar", peso: "0,3–0,6 kg", desc: "Muda de cor para se comunicar e regular temperatura, não só para se esconder." },
        { name: "Iguana-verde", sn: "Iguana iguana", habitat: "Florestas tropicais", peso: "2–5 kg", desc: "Ótima nadadora e escaladora; descansa no alto das árvores." },
        { name: "Serpente-real", sn: "Ophiophagus hannah", habitat: "Florestas da Ásia", peso: "3–6 kg", desc: "A maior cobra venenosa do mundo, com até 5,5 m." },
        { name: "Sapo-cururu", sn: "Rhinella marina", habitat: "Campos e matas", peso: "0,3–1,5 kg", desc: "Glândulas atrás dos olhos secretam toxina para se defender." },
        { name: "Polvo-comum", sn: "Octopus vulgaris", habitat: "Recifes costeiros", peso: "3–10 kg", desc: "Três corações, sangue azul e nove cérebros (um central e oito nos braços)." },
        { name: "Caranguejo-eremita", sn: "Pagurus bernhardus", habitat: "Costões", peso: "0,02–0,1 kg", desc: "Carrega conchas abandonadas para proteger o abdômen mole." },
        { name: "Abelha-europeia", sn: "Apis mellifera", habitat: "Mundo todo", peso: "0,0001 kg", desc: "Poliniza grande parte das plantas que alimentam a humanidade." },

        /* ===== INCOMUM (25) ===== */
        { name: "Okapi", sn: "Okapia johnstoni", habitat: "Floresta do Congo", peso: "200–300 kg", desc: "Primo da girafa com listras de zebra; descrito pela ciência só em 1901." },
        { name: "Saiga", sn: "Saiga tatarica", habitat: "Estepes", peso: "26–51 kg", desc: "Nariz bulboso que aquece o ar nas estepes geladas da Ásia." },
        { name: "Fossa", sn: "Cryptoprocta ferox", habitat: "Madagascar", peso: "7–12 kg", desc: "Maior predador de Madagascar; caça lêmures nas árvores." },
        { name: "Aie-aie", sn: "Daubentonia madagascariensis", habitat: "Madagascar", peso: "2–2,7 kg", desc: "Dedo fino e longo bate na madeira para localizar larvas pelo som." },
        { name: "Lêmure-de-cauda-anelada", sn: "Lemur catta", habitat: "Madagascar", peso: "2–3,5 kg", desc: "Vive em grupos liderados por fêmeas; usa a cauda para se comunicar." },
        { name: "Quokka", sn: "Setonix brachyurus", habitat: "Ilhas da Austrália", peso: "2,5–5 kg", desc: "Conhecido como 'animal mais feliz do mundo' por sua cara de sorriso." },
        { name: "Dugongo", sn: "Dugong dugon", habitat: "Águas costeiras", peso: "250–420 kg", desc: "Primo do peixe-boi; alimenta-se de ervas marinhas." },
        { name: "Peixe-boi-amazônico", sn: "Trichechus inunguis", habitat: "Rio Amazonas", peso: "300–450 kg", desc: "Só vive em água doce e é o menor dos peixes-boi." },
        { name: "Axolote", sn: "Ambystoma mexicanum", habitat: "Lagos do México", peso: "0,06–0,2 kg", desc: "Regenera patas, cauda e até partes do coração e do cérebro." },
        { name: "Geco-leopardo", sn: "Eublepharis macularius", habitat: "Desertos da Ásia", peso: "0,05–0,1 kg", desc: "Lagarto popular em terrários; as fêmeas podem viver mais de 20 anos." },
        { name: "Narval", sn: "Monodon monoceros", habitat: "Ártico", peso: "800–1.600 kg", desc: "Seu 'chifre' é na verdade um dente que pode chegar a 3 metros." },
        { name: "Beluga", sn: "Delphinapterus leucas", habitat: "Ártico", peso: "1.100–1.600 kg", desc: "Baleia branca famosa pela variedade de sons; chamada de 'canário do mar'." },
        { name: "Urso-de-óculos", sn: "Tremarctos ornatus", habitat: "Andes", peso: "64–140 kg", desc: "Único urso nativo da América do Sul; as manchas no rosto parecem óculos." },
        { name: "Lobo-guará", sn: "Chrysocyon brachyurus", habitat: "Cerrado", peso: "20–30 kg", desc: "Pernas longas para enxergar sobre o capim alto; onívoro, adora o fruto do lobo." },
        { name: "Cachorro-do-mato", sn: "Cerdocyon thous", habitat: "Cerrado e mata", peso: "4–7 kg", desc: "Canídeo brasileiro de hábitos noturnos e onívoro." },
        { name: "Gato-mourisco", sn: "Herpailurus yagouaroundi", habitat: "Cerrado e mata", peso: "4–9 kg", desc: "Felino brasileiro com pelagem que varia do cinza ao avermelhado." },
        { name: "Gato-palheiro", sn: "Leopardus colocola", habitat: "Campos", peso: "1,5–3,5 kg", desc: "Raro felino dos campos sul-americanos, ameaçado pelo avanço agrícola." },
        { name: "Veado-campeiro", sn: "Ozotoceros bezoarticus", habitat: "Campos do Brasil", peso: "20–35 kg", desc: "Cervo ameaçado que habita o Pampa e o Cerrado." },
        { name: "Cutia", sn: "Dasyprocta azarae", habitat: "Mata Atlântica", peso: "1,5–4 kg", desc: "Roedor que enterra sementes e ajuda a regenerar florestas." },
        { name: "Paca", sn: "Cuniculus paca", habitat: "Rios e matas", peso: "5–12 kg", desc: "Roedor noturno de pelagem manchada; bom nadador e escalador." },
        { name: "Ouriço-cacheiro", sn: "Hystrix cristata", habitat: "Savanas", peso: "12–27 kg", desc: "Coberto de espinhos que ergue e sacode quando ameaçado." },
        { name: "Musaranho-elefante", sn: "Elephantulus rufescens", habitat: "Savanas africanas", peso: "0,04–0,07 kg", desc: "Apesar do focinho alongado, não é parente do elefante: é afim de manatins e elefantes na evolução." },
        { name: "Tarsius", sn: "Tarsius tarsier", habitat: "Ilhas do Sudeste Asiático", peso: "0,08–0,15 kg", desc: "Olhos maiores que o estômago; enxerga bem no escuro com olhos fixos." },
        { name: "Pangolim", sn: "Manis pentadactyla", habitat: "Florestas da Ásia", peso: "2–7 kg", desc: "Único mamífero coberto de escamas; o mais traficado do mundo." },
        { name: "Pica-pau-imperador", sn: "Campephilus imperialis", habitat: "Florestas do México", peso: "0,6–0,7 kg", desc: "Um dos maiores pica-paus do mundo, possivelmente extinto na natureza." },

        /* ===== RARA (9) ===== */
        { name: "Vaquita", sn: "Phocoena sinus", habitat: "Golfo da Califórnia", peso: "30–55 kg", desc: "O mamífero marinho mais ameaçado do mundo: restam poucos indivíduos." },
        { name: "Lince-ibérico", sn: "Lynx pardinus", habitat: "Península Ibérica", peso: "9–13 kg", desc: "Felino mais ameaçado da Europa; especialista em caçar coelhos." },
        { name: "Leopardo-das-neves", sn: "Panthera uncia", habitat: "Montanhas da Ásia Central", peso: "22–55 kg", desc: "Vive acima de 3.000 m; usa a cauda longa como cobertor." },
        { name: "Tigre-de-bengala", sn: "Panthera tigris tigris", habitat: "Florestas da Índia", peso: "90–260 kg", desc: "Maior felino vivo; cada tigre tem listras únicas." },
        { name: "Dragão-de-komodo", sn: "Varanus komodoensis", habitat: "Ilhas da Indonésia", peso: "70–90 kg", desc: "O maior lagarto do mundo, com mordida cheia de bactérias." },
        { name: "Mandril", sn: "Mandrillus sphinx", habitat: "Florestas da África", peso: "12–35 kg", desc: "O primata com as cores mais vivas; o rosto azul e vermelho atrai fêmeas." },
        { name: "Macaco-narigudo", sn: "Nasalis larvatus", habitat: "Florestas de Bornéu", peso: "7–24 kg", desc: "O nariz grande do macho amplifica chamados e atrai parceiras." },
        { name: "Lobo-marinho-das-galápagos", sn: "Arctocephalus galapagoensis", habitat: "Galápagos", peso: "30–80 kg", desc: "O menor lobo-marinho do mundo e o único do hemisfério Norte tropical." },
        { name: "Tartaruga-de-couro", sn: "Dermochelys coriacea", habitat: "Oceanos", peso: "300–700 kg", desc: "A maior tartaruga viva; não tem casco rígido e pode mergulhar a 1.000 m." },

        /* ===== ÉPICA (4) ===== */
        { name: "Águia-dourada", sn: "Aquila chrysaetos", habitat: "Montanhas do Hemisfério Norte", peso: "3–6 kg", desc: "Ave de rapina poderosa, capaz de derrubar presas maiores que ela." },
        { name: "Gorila-da-montanha", sn: "Gorilla beringei beringei", habitat: "Montanhas da África", peso: "90–200 kg", desc: "O maior primata vivo; vive em famílias lideradas por um 'dorso-prateado'." },
        { name: "Condor-andino", sn: "Vultur gryphus", habitat: "Andes", peso: "9–15 kg", desc: "Uma das maiores aves voadoras; plana por horas sem bater as asas." },
        { name: "Rinoceronte-de-sumatra", sn: "Dicerorhinus sumatrensis", habitat: "Florestas da Sumatra", peso: "600–950 kg", desc: "O rinoceronte mais peludo e o menor das espécies vivas." },

        /* ===== LENDÁRIA (1) ===== */
        { name: "Baleia-azul", sn: "Balaenoptera musculus", habitat: "Oceanos", peso: "100.000–150.000 kg", desc: "O maior animal que já existiu na Terra; o coração pesa como um carro pequeno." },

        /* ===== MÍTICA (1) ===== */
        { name: "Lula-colossal", sn: "Mesonychoteuthis hamiltoni", habitat: "Águas antárticas", peso: "400–600 kg", desc: "O maior invertebrado conhecido, com olhos do tamanho de pratos." }
    ];

    especies.forEach((e, i) => {
        const raridadesEspeciais = {
            "Condor-andino": "LENDARIA",
            "Rinoceronte-de-sumatra": "LENDARIA",
            "Vaquita": "LENDARIA",
            "Lince-ibérico": "LENDARIA",
            "Leopardo-das-neves": "MITICA",
            "Tigre-de-bengala": "MITICA",
            "Lula-colossal": "MITICA"
        };
        const raridade = raridadesEspeciais[e.name] || (
            i < 60 ? "COMUM" :
            i < 85 ? "INCOMUM" :
            i < 94 ? "RARA" :
            i < 96 ? "EPICA" :
            i < 99 ? "LENDARIA" : "MITICA"
        );
        cards.push({
            number: i + 1,
            name: e.name,
            scientific_name: e.sn,
            habitat: e.habitat,
            peso: e.peso,
            regiao: REGIOES_ANIMAIS[e.name] || "",
            image_url: IMAGENS_ANIMAIS[e.name] || null,
            rarity: raridade,
            description: e.desc
        });
    });

    const contagem = cards.reduce((acc, card) => {
        acc[card.rarity] = (acc[card.rarity] || 0) + 1;
        return acc;
    }, {});
    if (cards.length !== 100 || contagem.LENDARIA !== 5 || contagem.MITICA !== 3) {
        throw new Error("Catálogo inválido: esperado 100 cartas, 5 lendárias e 3 míticas.");
    }
    return cards;
})();

/* =========================================================
   HELPERS INTERNOS
========================================================= */

function sortearRaridade() {
    const r = Math.random() * 100;
    let acumulado = 0;
    for (const chave of RARIDADE_ORDEM) {
        acumulado += PROBABILIDADES[chave];
        if (r < acumulado) {
            return chave;
        }
    }
    return "COMUM";
}

/* Sorteia `quantidade` cards respeitando as probabilidades.
   Se não houver card disponível da raridade sorteada, cai para
   a mais próxima disponível. */
function sortearCards(colecao, quantidade) {
    const resultado = [];
    const porRaridade = {};
    for (const card of colecao) {
        (porRaridade[card.rarity] = porRaridade[card.rarity] || []).push(card);
    }

    for (let i = 0; i < quantidade; i++) {
        let raridade = sortearRaridade();
        let pool = porRaridade[raridade] || [];

        if (!pool.length) {
            for (let j = 0; j < RARIDADE_ORDEM.length; j++) {
                const chave = RARIDADE_ORDEM[j];
                if (porRaridade[chave] && porRaridade[chave].length) {
                    raridade = chave;
                    pool = porRaridade[chave];
                    break;
                }
            }
        }

        if (!pool.length) {
            pool = colecao;
        }

        const card = pool[Math.floor(Math.random() * pool.length)];
        resultado.push(card);
    }

    return resultado;
}

function gerarOrderId(prefixo) {
    return `${prefixo}-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/* =========================================================
   MÓDULO
========================================================= */

module.exports = function criarModuloColecionaveis(deps) {

    const {
        express,              // express (Router)
        authUsuario,          // middleware JWT usuário
        authAdmin,            // middleware JWT admin
        criarOrderMercadoPago,
        consultarOrderMercadoPago,
        extrairDadosPagamento,
        statusOrderPago,
        orderPagaMercadoPago,
        paraCentavos,
        registrarLog,
        registrarStoryEvento,
        obterContaMarketplace,
        obterContaMarketplacePrivada,
        consultarMercadoPagoPayment,
        mercadopagoMarketplaceFeePercent = 10,
        mercadopagoMarketplaceSplitEnabled = false,
        criarOrderMercadoPagoSplit = null,
        normalizarDadosComprador,
        validarDocumento,
        formatarErroPagamento,
        criarNotificacao
    } = deps;

    const router = express.Router();

    /* Acesso ao pool (dinâmico, pois o server.js pode não ter
       conectado ainda no momento do mount). */
    const obterPool = deps.obterPool;
    const obterPgDisponivel = deps.obterPgDisponivel;
    const obterAuthUsuario = deps.obterAuthUsuario || (() => authUsuario);

    const pg = () => obterPool();
    const pgOk = () => !!obterPgDisponivel();
    const marketplaceConta = usuarioId => typeof obterContaMarketplacePrivada === "function"
        ? obterContaMarketplacePrivada(usuarioId)
        : (typeof obterContaMarketplace === "function" ? obterContaMarketplace(usuarioId) : null);

    /* Validação unificada dos dados do comprador para todos os
       checkouts de colecionáveis (pacotes, mercado e trocas). */
    function validarComprador(req) {
        const comprador = normalizarDadosComprador(req.body);
        if (!comprador.documento) {
            return { ok: false, error: "Informe CPF ou CNPJ." };
        }
        if (!validarDocumento(comprador.documento)) {
            return { ok: false, error: "CPF ou CNPJ inválido." };
        }
        return { ok: true, comprador };
    }

    /* =========================================================
       MATEMÁTICA FINANCEIRA EM CENTAVOS (INTEIROS)
       Toda venda/negociação: 10% Milhão Door / 90% vendedor.
       NUNCA usar float para cálculo — apenas inteiros.
    ========================================================= */

    function centavosParaReais(cents) {
        const c = Math.round(Number(cents) || 0);
        return Number((c / 100).toFixed(2));
    }

    /* Comissão da plataforma (padrão 10%) e líquido do vendedor.
       Calculado 100% em centavos (inteiros), sem aritmética float. */
    function calcularComissao(totalCents, feePercent) {
        const pct = Math.max(0, Math.min(100, Number(feePercent) || 0));
        const total = Math.round(Number(totalCents) || 0);
        const feeCents = Math.round(total * pct / 100);
        const netSellerCents = total - feeCents;
        return { totalCents: total, feeCents, netSellerCents };
    }

    /* =========================================================
       MIGRAÇÃO DO BANCO
       Chamada pelo server.js dentro de initBanco().
       Apenas CREATE TABLE IF NOT EXISTS / ADD COLUMN.
       NUNCA usa DROP TABLE.
    ========================================================= */

    async function migrar() {
        const pool = obterPool();
        if (!pool) return;

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_collections (
                id          SERIAL PRIMARY KEY,
                slug        VARCHAR(60) UNIQUE NOT NULL,
                name        VARCHAR(200) NOT NULL,
                edition     VARCHAR(60),
                total       INTEGER NOT NULL DEFAULT 0,
                description TEXT,
                is_active   BOOLEAN NOT NULL DEFAULT TRUE,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_cards (
                id            SERIAL PRIMARY KEY,
                collection_id INTEGER NOT NULL
                              REFERENCES sticker_collections(id)
                              ON DELETE CASCADE,
                number        INTEGER NOT NULL,
                name          VARCHAR(200) NOT NULL,
                description   TEXT,
                rarity        VARCHAR(20) NOT NULL,
                image_url     VARCHAR(400),
                is_active     BOOLEAN NOT NULL DEFAULT TRUE,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (collection_id, number)
            )
        `);

        /* Dados científicos das espécies (ANIMAIS DO MUNDO) —
           compatibilidade com bancos já existentes. */
        await pool.query(`ALTER TABLE sticker_cards ADD COLUMN IF NOT EXISTS scientific_name VARCHAR(200)`);
        await pool.query(`ALTER TABLE sticker_cards ADD COLUMN IF NOT EXISTS habitat VARCHAR(120)`);
        await pool.query(`ALTER TABLE sticker_cards ADD COLUMN IF NOT EXISTS peso VARCHAR(80)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_packs (
                id                SERIAL PRIMARY KEY,
                collection_id     INTEGER NOT NULL
                                  REFERENCES sticker_collections(id)
                                  ON DELETE CASCADE,
                slug              VARCHAR(60) UNIQUE NOT NULL,
                name              VARCHAR(100) NOT NULL,
                price             NUMERIC(10,2) NOT NULL,
                sticker_quantity  INTEGER NOT NULL,
                description       TEXT,
                is_active         BOOLEAN NOT NULL DEFAULT TRUE,
                created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_pack_purchases (
                id            SERIAL PRIMARY KEY,
                usuario_id    INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                pack_id       INTEGER NOT NULL
                              REFERENCES sticker_packs(id),
                order_id      VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                payment_type  VARCHAR(30) NOT NULL DEFAULT 'STICKER_PACK',
                price         NUMERIC(10,2) NOT NULL,
                quantity      INTEGER NOT NULL,
                status        VARCHAR(20) NOT NULL DEFAULT 'pending',
                test          BOOLEAN NOT NULL DEFAULT FALSE,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                paid_at       TIMESTAMPTZ,
                open_status   VARCHAR(20) NOT NULL DEFAULT 'unopened',
                opened_at     TIMESTAMPTZ
            )
        `);

        /* Sorteio persistido do pacote (abre UMA vez; refresh devolve
           as MESMAS figurinhas — CORREÇÃO 7 / ANIMAIS DO MUNDO). */
        await pool.query(`ALTER TABLE sticker_pack_purchases ADD COLUMN IF NOT EXISTS figurinhas INTEGER[]`);
        await pool.query(`ALTER TABLE sticker_pack_purchases ADD COLUMN IF NOT EXISTS story_opt_in BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`ALTER TABLE sticker_pack_purchases ADD COLUMN IF NOT EXISTS open_status VARCHAR(20) NOT NULL DEFAULT 'unopened'`);
        await pool.query(`ALTER TABLE sticker_pack_purchases ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`);
        await pool.query(`
            UPDATE sticker_pack_purchases
               SET open_status = 'opened', opened_at = COALESCE(opened_at, paid_at, NOW())
             WHERE status = 'paid' AND figurinhas IS NOT NULL AND open_status = 'unopened'
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_pack_inventory (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                pack_id     INTEGER NOT NULL REFERENCES sticker_packs(id),
                source_ref  VARCHAR(120) UNIQUE NOT NULL,
                figurinhas  INTEGER[],
                status      VARCHAR(20) NOT NULL DEFAULT 'unopened',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                opened_at   TIMESTAMPTZ
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pack_inventory_user ON sticker_pack_inventory(usuario_id, status)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_stickers (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL
                            REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id     INTEGER NOT NULL
                            REFERENCES sticker_cards(id) ON DELETE CASCADE,
                quantity    INTEGER NOT NULL DEFAULT 0,
                acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (usuario_id, card_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_listings (
                id          SERIAL PRIMARY KEY,
                seller_id   INTEGER NOT NULL
                            REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id     INTEGER NOT NULL
                            REFERENCES sticker_cards(id) ON DELETE CASCADE,
                unit_price  NUMERIC(10,2) NOT NULL,
                quantity    INTEGER NOT NULL,
                status      VARCHAR(20) NOT NULL DEFAULT 'active',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_listing_messages (
                id          SERIAL PRIMARY KEY,
                listing_id  INTEGER NOT NULL REFERENCES sticker_listings(id) ON DELETE CASCADE,
                seller_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                buyer_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                text        VARCHAR(500) NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_listing_messages ON sticker_listing_messages(listing_id, created_at)`);

        /* Conversa por anúncio (comprador <-> vendedor). Registra quem
           participa, o momento da última leitura de cada lado (contador
           de não lidas) e a negociação relacionada quando existir. */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_listing_conversations (
                id             SERIAL PRIMARY KEY,
                listing_id     INTEGER NOT NULL REFERENCES sticker_listings(id) ON DELETE CASCADE,
                seller_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                buyer_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                offer_id       INTEGER,
                seller_read_at TIMESTAMPTZ,
                buyer_read_at  TIMESTAMPTZ,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (listing_id, seller_id, buyer_id)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_listing_conv_buyer ON sticker_listing_conversations(buyer_id, updated_at)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_listing_conv_seller ON sticker_listing_conversations(seller_id, updated_at)`);

        /* Leilões são independentes do checkout existente. A reserva
           permanece até o pagamento futuro do vencedor. */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_auctions (
                id             SERIAL PRIMARY KEY,
                seller_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id        INTEGER NOT NULL REFERENCES sticker_cards(id) ON DELETE CASCADE,
                minimum_bid    NUMERIC(10,2) NOT NULL,
                current_bid    NUMERIC(10,2),
                winner_id      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
                status         VARCHAR(30) NOT NULL DEFAULT 'active',
                payment_status VARCHAR(30) NOT NULL DEFAULT 'not_applicable',
                ends_at        TIMESTAMPTZ NOT NULL,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                closed_at      TIMESTAMPTZ
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_auction_bids (
                id          SERIAL PRIMARY KEY,
                auction_id  INTEGER NOT NULL REFERENCES sticker_auctions(id) ON DELETE CASCADE,
                bidder_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                amount      NUMERIC(10,2) NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_auction_reservations (
                id          SERIAL PRIMARY KEY,
                auction_id  INTEGER UNIQUE NOT NULL REFERENCES sticker_auctions(id) ON DELETE CASCADE,
                owner_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id     INTEGER NOT NULL REFERENCES sticker_cards(id) ON DELETE CASCADE,
                status      VARCHAR(20) NOT NULL DEFAULT 'reserved',
                reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                released_at TIMESTAMPTZ
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_auction_orders (
                id            SERIAL PRIMARY KEY,
                auction_id    INTEGER UNIQUE NOT NULL REFERENCES sticker_auctions(id) ON DELETE CASCADE,
                buyer_id      INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                order_id      VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                total         NUMERIC(10,2) NOT NULL,
                fee           NUMERIC(10,2) NOT NULL DEFAULT 0,
                seller_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
                status        VARCHAR(20) NOT NULL DEFAULT 'pending',
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                paid_at       TIMESTAMPTZ
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_orders (
                id            SERIAL PRIMARY KEY,
                buyer_id      INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                seller_id     INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id       INTEGER NOT NULL
                              REFERENCES sticker_cards(id) ON DELETE CASCADE,
                listing_id    INTEGER NOT NULL
                              REFERENCES sticker_listings(id),
                quantity      INTEGER NOT NULL,
                unit_price    NUMERIC(10,2) NOT NULL,
                total         NUMERIC(10,2) NOT NULL,
                fee           NUMERIC(10,2) NOT NULL,
                net_seller    NUMERIC(10,2) NOT NULL,
                order_id      VARCHAR(60) UNIQUE NOT NULL,
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                payment_type  VARCHAR(30) NOT NULL DEFAULT 'STICKER_PURCHASE',
                status        VARCHAR(20) NOT NULL DEFAULT 'pending',
                test          BOOLEAN NOT NULL DEFAULT FALSE,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                paid_at       TIMESTAMPTZ
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_trades (
                id            SERIAL PRIMARY KEY,
                proposer_id   INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                receiver_id   INTEGER NOT NULL
                              REFERENCES usuarios(id) ON DELETE CASCADE,
                status        VARCHAR(30) NOT NULL DEFAULT 'PENDING',
                cash_direction VARCHAR(20),
                cash_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
                order_id      VARCHAR(60),
                mp_order_id   VARCHAR(60),
                payment_id    VARCHAR(60),
                payment_type  VARCHAR(30) NOT NULL DEFAULT 'STICKER_TRADE',
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at    TIMESTAMPTZ NOT NULL,
                completed_at  TIMESTAMPTZ,
                history       TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_trade_items (
                id          SERIAL PRIMARY KEY,
                trade_id    INTEGER NOT NULL
                            REFERENCES sticker_trades(id) ON DELETE CASCADE,
                owner_id    INTEGER NOT NULL,
                card_id     INTEGER NOT NULL
                            REFERENCES sticker_cards(id) ON DELETE CASCADE,
                side        VARCHAR(20) NOT NULL
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_trade_messages (
                id          SERIAL PRIMARY KEY,
                trade_id    INTEGER NOT NULL
                            REFERENCES sticker_trades(id) ON DELETE CASCADE,
                usuario_id  INTEGER NOT NULL,
                text        TEXT NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_transactions (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL
                            REFERENCES usuarios(id) ON DELETE CASCADE,
                tipo        VARCHAR(40) NOT NULL,
                detalhe     TEXT,
                valor       NUMERIC(10,2) NOT NULL DEFAULT 0,
                ref_id      VARCHAR(60),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_achievements (
                id          SERIAL PRIMARY KEY,
                slug        VARCHAR(60) UNIQUE NOT NULL,
                name        VARCHAR(120) NOT NULL,
                description TEXT,
                icon        VARCHAR(10)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_user_achievements (
                id             SERIAL PRIMARY KEY,
                usuario_id     INTEGER NOT NULL
                               REFERENCES usuarios(id) ON DELETE CASCADE,
                achievement_id INTEGER NOT NULL
                               REFERENCES sticker_achievements(id) ON DELETE CASCADE,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (usuario_id, achievement_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_monthly_rewards (
                id           SERIAL PRIMARY KEY,
                usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                period_key   VARCHAR(80) NOT NULL,
                reward_key   VARCHAR(120) NOT NULL,
                completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (usuario_id, period_key)
            )
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_stickers_usuario
                ON user_stickers(usuario_id)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_listings_status
                ON sticker_listings(status)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_auctions_status_ends
                ON sticker_auctions(status, ends_at)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_trades_status
                ON sticker_trades(status)
        `);

        /* ===== SISTEMA DE OFERTAS (FAZER OFERTA) =====
           sticker_offers: negociação PENDENTE/ACEITA/RECUSADA/
           CANCELADA/EXPIRADA (+ CONCLUIDA após o pagamento).
           Contraproposta cria uma nova oferta com parent_offer_id
           apontando para a original (que vira RECUSADA). */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_offers (
                id              SERIAL PRIMARY KEY,
                offeror_id      INTEGER NOT NULL
                                REFERENCES usuarios(id) ON DELETE CASCADE,
                offeree_id      INTEGER NOT NULL
                                REFERENCES usuarios(id) ON DELETE CASCADE,
                card_id         INTEGER NOT NULL
                                REFERENCES sticker_cards(id) ON DELETE CASCADE,
                quantity        INTEGER NOT NULL DEFAULT 1,
                amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
                message         TEXT,
                status          VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
                parent_offer_id INTEGER,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                responded_at    TIMESTAMPTZ,
                expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sticker_offers_offeree
                ON sticker_offers(offeree_id, status)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sticker_offers_offeror
                ON sticker_offers(offeror_id, status)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sticker_offers_card
                ON sticker_offers(card_id, status)
        `);

        /* Reserva de unidade criada no ACEITE da oferta. Bloqueia a
           quantidade negociada e é liberada em caso de cancelamento
           ou expiração, evitando venda dupla. */
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sticker_offer_reservations (
                id          SERIAL PRIMARY KEY,
                offer_id    INTEGER NOT NULL
                            REFERENCES sticker_offers(id) ON DELETE CASCADE,
                card_id     INTEGER NOT NULL,
                owner_id    INTEGER NOT NULL,
                quantity    INTEGER NOT NULL DEFAULT 1,
                status      VARCHAR(20) NOT NULL DEFAULT 'ATIVA',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_sticker_offer_reservations
                ON sticker_offer_reservations(owner_id, card_id, status)
        `);

        /* Pedido pago gerado por uma oferta aceita. */
        try {
            await pool.query(`
                ALTER TABLE sticker_orders
                    ADD COLUMN IF NOT EXISTS offer_id INTEGER
            `);
        } catch (e) { /* ignora — coluna já existente */ }

        /* Ofertas pagas não possuem anúncio (listing). Libera NULL. */
        try {
            await pool.query(`
                ALTER TABLE sticker_orders
                    ALTER COLUMN listing_id DROP NOT NULL
            `);
        } catch (e) { /* ignora — coluna já sem restrição */ }

        /* Ajustes de compatibilidade (colunas existentes em produção). */
        try {
            await pool.query(
                `ALTER TABLE sticker_trades
                   ALTER COLUMN cash_direction TYPE VARCHAR(20)`
            );
        } catch (e) { /* ignora se o PostgreSQL não permitir direto */ }

        await semearBanco(pool);
    }

    /* Seed idempotente: coleção, cards, pacotes, conquistas.
       Não recria nada que já exista. */
    async function semearBanco(pool) {
        const colecaoQ = await pool.query(
            `SELECT id FROM sticker_collections WHERE slug = $1`,
            [COLECAO_PADRAO.slug]
        );
        let colecaoId = colecaoQ.rows[0]?.id;

        if (!colecaoId) {
            const q = await pool.query(
                `INSERT INTO sticker_collections (slug, name, edition, total, description)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                [COLECAO_PADRAO.slug, COLECAO_PADRAO.nome, COLECAO_PADRAO.edicao,
                 COLECAO_PADRAO.total, COLECAO_PADRAO.descricao]
            );
            colecaoId = q.rows[0].id;
        } else {
            /* Coleção já existente: atualiza metadados (ANIMAIS DO MUNDO). */
            await pool.query(
                `UPDATE sticker_collections
                    SET name = $2, edition = $3, total = $4, description = $5
                  WHERE id = $1`,
                [colecaoId, COLECAO_PADRAO.nome, COLECAO_PADRAO.edicao,
                 COLECAO_PADRAO.total, COLECAO_PADRAO.descricao]
            );
        }

        /* Figurinhas: upsert com dados científicos. O DO UPDATE garante
           que bancos já existentes passem a exibir as 100 espécies reais
           sem perder os ids (user_stickers preservadas). */
        for (const card of CATALOGO) {
            await pool.query(
                `INSERT INTO sticker_cards
                    (collection_id, number, name, description, rarity,
                     scientific_name, habitat, peso, image_url)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (collection_id, number)
                 DO UPDATE SET name = EXCLUDED.name,
                               description = EXCLUDED.description,
                               rarity = EXCLUDED.rarity,
                               scientific_name = EXCLUDED.scientific_name,
                               habitat = EXCLUDED.habitat,
                               peso = EXCLUDED.peso,
                               image_url = EXCLUDED.image_url`,
                [colecaoId, card.number, card.name, card.description, card.rarity,
                 card.scientific_name, card.habitat, card.peso,
                 card.image_url || null]
            );
        }

        /* Pacotes */
        for (const p of PACKS_PADRAO) {
            await pool.query(
                `INSERT INTO sticker_packs
                    (collection_id, slug, name, price, sticker_quantity, description)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (slug) DO NOTHING`,
                [colecaoId, p.slug, p.nome, p.preco, p.quantidade, p.descricao]
            );
        }

        /* Conquistas */
        for (const c of CONQUISTAS) {
            await pool.query(
                `INSERT INTO sticker_achievements (slug, name, description, icon)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (slug) DO NOTHING`,
                [c.slug, c.nome, c.descricao, c.icone]
            );
        }
    }

    /* =========================================================
       HELPERS DE NEGÓCIO
    ========================================================= */

    async function colecaoAtiva() {
        const q = await pg().query(
            `SELECT * FROM sticker_collections
              WHERE is_active = TRUE
              ORDER BY id LIMIT 1`
        );
        return q.rows[0] || null;
    }

    async function cardPorId(cardId) {
        const q = await pg().query(
            `SELECT * FROM sticker_cards WHERE id = $1`,
            [cardId]
        );
        return q.rows[0] || null;
    }

    async function usuarioPorId(usuarioId) {
        const q = await pg().query(
            `SELECT id, nome, email, album_publico FROM usuarios WHERE id = $1`,
            [usuarioId]
        );
        return q.rows[0] || null;
    }

    /* Regra central de elegibilidade (mesma do server.js).
       Apenas contas ACTIVE participam de negociações. */
    async function usuarioElegivel(usuarioId) {
        if (usuarioId == null) return true;
        if (typeof deps.usuarioPodeNegociar === "function") {
            return deps.usuarioPodeNegociar(usuarioId);
        }
        const u = await usuarioPorId(usuarioId);
        if (!u) return false;
        let st = String(u.account_status || "ACTIVE").toUpperCase();
        if (st === "ACTIVE" && u.bloqueado === true) st = "BLOCKED";
        return st === "ACTIVE";
    }

    /* Retorna mensagem de bloqueio (403) ou null se liberado. */
    async function motivoBloqueio(usuarioId) {
        if (usuarioId == null) return null;
        const ok = await usuarioElegivel(usuarioId);
        if (ok) return null;
        return "Esta conta está bloqueada para negociações no marketplace.";
    }

    /* Verifica vários ids de uma vez. */
    async function verificarElegibilidade(...ids) {
        for (const id of ids) {
            if (id == null) continue;
            const motivo = await motivoBloqueio(id);
            if (motivo) return { bloqueado: true, motivo };
        }
        return { bloqueado: false };
    }

    /* Quantidade que o usuário possui de uma figurinha. */
    async function quantidadePossuida(usuarioId, cardId) {
        const q = await pg().query(
            `SELECT quantity FROM user_stickers
              WHERE usuario_id = $1 AND card_id = $2`,
            [usuarioId, cardId]
        );
        return q.rows[0] ? Number(q.rows[0].quantity) : 0;
    }

    /* Quantidade bloqueada por listagens ativas do usuário. */
    async function bloqueadoPorListagem(usuarioId, cardId) {
        const q = await pg().query(
            `SELECT COALESCE(SUM(quantity),0) AS qtd
               FROM sticker_listings
              WHERE seller_id = $1 AND card_id = $2
                AND status = 'active'`,
            [usuarioId, cardId]
        );
        return Number(q.rows[0]?.qtd || 0);
    }

    /* Quantidade bloqueada por negociações ativas do usuário
       (propondo ou recebendo, ainda não concluídas). */
    async function bloqueadoPorTrocas(usuarioId, cardId, excluirTradeId = null) {
        const params = [usuarioId, cardId];
        let excluirSql = "";
        if (excluirTradeId) {
            params.push(excluirTradeId);
            excluirSql = `AND ti.trade_id <> $${params.length}`;
        }
        const q = await pg().query(
            `SELECT COALESCE(SUM(1),0) AS qtd
               FROM sticker_trade_items ti
               JOIN sticker_trades t ON t.id = ti.trade_id
              WHERE ti.owner_id = $1
                AND ti.card_id = $2
                ${excluirSql}
                AND t.status IN
                    ('PENDING','COUNTER_OFFER','ACCEPTED',
                     'WAITING_PAYMENT','PAID','PROCESSING')`,
            params
        );
        return Number(q.rows[0]?.qtd || 0);
    }

    /* Cada leilão reserva uma única unidade. O vencedor continua
       reservado em payment_pending, sem iniciar qualquer pagamento. */
    async function bloqueadoPorLeilao(usuarioId, cardId) {
        const q = await pg().query(
            `SELECT COUNT(*)::int AS qtd
               FROM sticker_auction_reservations r
               JOIN sticker_auctions a ON a.id = r.auction_id
              WHERE r.owner_id = $1 AND r.card_id = $2
                AND r.status = 'reserved'
                AND a.status IN ('active', 'payment_pending')`,
            [usuarioId, cardId]
        );
        return Number(q.rows[0]?.qtd || 0);
    }

    /* Quantidade reservada por ofertas ACEITAS aguardando pagamento.
       Garante que o vendedor não venda a mesma unidade duas vezes. */
    async function bloqueadoPorOfertas(usuarioId, cardId) {
        const q = await pg().query(
            `SELECT COALESCE(SUM(quantity),0)::int AS qtd
               FROM sticker_offer_reservations
              WHERE owner_id = $1 AND card_id = $2
                AND status = 'ATIVA'`,
            [usuarioId, cardId]
        );
        return Number(q.rows[0]?.qtd || 0);
    }

    /* Quantidade disponível (possui - bloqueada). */
    async function quantidadeDisponivel(usuarioId, cardId, excluirTradeId = null) {
        const possui = await quantidadePossuida(usuarioId, cardId);
        const bloqListagem = await bloqueadoPorListagem(usuarioId, cardId);
        const bloqTrocas = await bloqueadoPorTrocas(usuarioId, cardId, excluirTradeId);
        const bloqLeilao = await bloqueadoPorLeilao(usuarioId, cardId);
        const bloqOfertas = await bloqueadoPorOfertas(usuarioId, cardId);
        return Math.max(0, possui - bloqListagem - bloqTrocas - bloqLeilao - bloqOfertas);
    }

    /* Cache leve (5s) da disponibilidade por vendedor+figurinha, para o
       marketplace listar quanto cada anúncio ainda pode vender e marcar
       RESERVADA sem estourar o banco a cada polling. */
    const mercadoDispCache = new Map();
    async function disponivelListagem(sellerId, cardId) {
        const key = Number(sellerId) + ":" + Number(cardId);
        const hit = mercadoDispCache.get(key);
        if (hit && Date.now() - hit.at < 5000) return hit.disp;
        const disp = await quantidadeDisponivel(sellerId, cardId);
        mercadoDispCache.set(key, { disp, at: Date.now() });
        if (mercadoDispCache.size > 500) mercadoDispCache.clear();
        return disp;
    }

    async function registrarTransacaoCol(usuarioId, tipo, detalhe, valor = 0, refId = null) {
        return pg().query(
            `INSERT INTO sticker_transactions (usuario_id, tipo, detalhe, valor, ref_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [usuarioId, tipo, detalhe, valor, refId]
        );
    }

    /* Registra transação para os dois lados de uma negociação. */
    async function registrarTransacaoDupla(usuarioA, usuarioB, tipo, detalhe, valor = 0, refId = null) {
        await registrarTransacaoCol(usuarioA, tipo, detalhe, valor, refId);
        await registrarTransacaoCol(usuarioB, tipo, detalhe, valor, refId);
    }

    /* Adiciona figurinhas ao acervo do usuário (upsert). */
    async function adicionarFigurinha(usuarioId, cardId, quantidade = 1) {
        await pg().query(
            `INSERT INTO user_stickers (usuario_id, card_id, quantity)
             VALUES ($1,$2,$3)
             ON CONFLICT (usuario_id, card_id)
             DO UPDATE SET quantity =
                 user_stickers.quantity + EXCLUDED.quantity`,
            [usuarioId, cardId, quantidade]
        );
    }

    /* Remove figurinhas do acervo (apenas se houver saldo).
       Retorna true se conseguiu remover tudo. */
    async function removerFigurinhas(usuarioId, cardId, quantidade) {
        const q = await pg().query(
            `UPDATE user_stickers
                SET quantity = quantity - $3
              WHERE usuario_id = $1 AND card_id = $2
                AND quantity >= $3
              RETURNING quantity`,
            [usuarioId, cardId, quantidade]
        );
        return q.rows.length > 0;
    }

    /* =========================================================
       CONQUISTAS
    ========================================================= */

    async function desbloquearConquista(usuarioId, slug) {
        const aq = await pg().query(
            `SELECT id FROM sticker_achievements WHERE slug = $1`,
            [slug]
        );
        if (!aq.rows[0]) return false;
        const aid = aq.rows[0].id;
        const q = await pg().query(
            `INSERT INTO sticker_user_achievements (usuario_id, achievement_id)
             VALUES ($1,$2)
             ON CONFLICT (usuario_id, achievement_id) DO NOTHING
             RETURNING id`,
            [usuarioId, aid]
        );
        if (q.rows.length) {
            registrarLog("colecionavel_conquista", { usuarioId, slug });
        }
        return q.rows.length > 0;
    }

    async function verificarConquistas(usuarioId, colecaoId) {
        if (!pgOk()) return [];

        const desbloqueadas = [];

        /* Totais do usuário na coleção */
        const totais = await pg().query(
            `SELECT
                 COALESCE(SUM(us.quantity),0)::int AS total_figurinhas,
                 COUNT(DISTINCT us.card_id)::int    AS diferentes
              FROM user_stickers us
              JOIN sticker_cards c ON c.id = us.card_id
              WHERE us.usuario_id = $1
                AND c.collection_id = $2
                AND us.quantity > 0`,
            [usuarioId, colecaoId]
        );

        const totalFigurinhas = Number(totais.rows[0]?.total_figurinhas || 0);
        const diferentes = Number(totais.rows[0]?.diferentes || 0);

        const raridades = await pg().query(
            `SELECT c.rarity, COUNT(DISTINCT us.card_id)::int AS qtd
               FROM user_stickers us
               JOIN sticker_cards c ON c.id = us.card_id
              WHERE us.usuario_id = $1
                AND c.collection_id = $2
                AND us.quantity > 0
              GROUP BY c.rarity`,
            [usuarioId, colecaoId]
        );

        const rarSet = new Set(raridades.rows.map(r => r.rarity));

        if (totalFigurinhas >= 1) {
            const ok = await desbloquearConquista(usuarioId, "primeira_figurinha");
            if (ok) desbloqueadas.push("primeira_figurinha");
        }
        if (totalFigurinhas >= 10) {
            const ok = await desbloquearConquista(usuarioId, "10_figurinhas");
            if (ok) desbloqueadas.push("10_figurinhas");
        }
        if (totalFigurinhas >= 25) {
            const ok = await desbloquearConquista(usuarioId, "25_figurinhas");
            if (ok) desbloqueadas.push("25_figurinhas");
        }
        if (totalFigurinhas >= 50) {
            const ok = await desbloquearConquista(usuarioId, "50_figurinhas");
            if (ok) desbloqueadas.push("50_figurinhas");
        }
        if (totalFigurinhas >= 100) {
            const ok = await desbloquearConquista(usuarioId, "100_figurinhas");
            if (ok) desbloqueadas.push("100_figurinhas");
        }
        if (rarSet.has("RARA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_rara");
            if (ok) desbloqueadas.push("primeira_rara");
        }
        if (rarSet.has("EPICA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_epica");
            if (ok) desbloqueadas.push("primeira_epica");
        }
        if (rarSet.has("LENDARIA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_lendaria");
            if (ok) desbloqueadas.push("primeira_lendaria");
        }
        if (rarSet.has("MITICA")) {
            const ok = await desbloquearConquista(usuarioId, "primeira_mitica");
            if (ok) desbloqueadas.push("primeira_mitica");
        }
        if (diferentes >= 50) {
            const ok = await desbloquearConquista(usuarioId, "metade_album");
            if (ok) desbloqueadas.push("metade_album");
        }
        if (diferentes >= 100) {
            const ok = await desbloquearConquista(usuarioId, "album_completo");
            if (ok) desbloqueadas.push("album_completo");
            if (await verificarRecompensaMensal(usuarioId, diferentes)) {
                desbloqueadas.push("album_completo_mes");
            }
        }

        return desbloqueadas;
    }

    async function verificarRecompensaMensal(usuarioId, diferentes) {
        if (!pgOk() || diferentes < 100 || !MONTHLY_ALBUM_REWARD.start || !MONTHLY_ALBUM_REWARD.end) return false;
        const agora = Date.now();
        const inicio = new Date(MONTHLY_ALBUM_REWARD.start).getTime();
        const fim = new Date(MONTHLY_ALBUM_REWARD.end).getTime();
        if (!Number.isFinite(inicio) || !Number.isFinite(fim) || agora < inicio || agora > fim) return false;
        const periodKey = `${MONTHLY_ALBUM_REWARD.start}:${MONTHLY_ALBUM_REWARD.end}`;
        const result = await pg().query(
            `INSERT INTO sticker_monthly_rewards (usuario_id, period_key, reward_key)
             VALUES ($1,$2,$3) ON CONFLICT (usuario_id, period_key) DO NOTHING RETURNING id`,
            [usuarioId, periodKey, MONTHLY_ALBUM_REWARD.reward]
        );
        if (result.rows.length) registrarLog("colecionavel_recompensa_album_mensal", { usuarioId, periodKey, reward: MONTHLY_ALBUM_REWARD.reward });
        return result.rows.length > 0;
    }

    /* =========================================================
       EXPIRE NEGOCIAÇÕES VENCIDAS
    ========================================================= */

    async function expirarNegociacoesVencidas() {
        if (!pgOk()) return;
        try {
            await pg().query(
                `UPDATE sticker_trades
                    SET status = 'EXPIRED',
                        updated_at = NOW(),
                        history = COALESCE(history,'') ||
                                   E'\n[EXPIRADO] Proposta expirou automaticamente.'
                  WHERE status IN
                        ('PENDING','COUNTER_OFFER','ACCEPTED',
                         'WAITING_PAYMENT','PAID','PROCESSING')
                    AND expires_at < NOW()`
            );

            /* Ofertas PENDENTES vencidas viram EXPIRADA. */
            await pg().query(
                `UPDATE sticker_offers
                    SET status = 'EXPIRADA',
                        updated_at = NOW(),
                        responded_at = COALESCE(responded_at, NOW())
                  WHERE status = 'PENDENTE'
                    AND expires_at < NOW()`
            );

            /* Reservas de ofertas ACEITAS vencidas são liberadas. */
            await pg().query(
                `UPDATE sticker_offer_reservations
                    SET status = 'LIBERADA'
                  WHERE status = 'ATIVA'
                    AND offer_id IN (
                        SELECT o.id FROM sticker_offers o
                         WHERE o.status IN ('ACEITA','CONCLUIDA','CANCELADA','RECUSADA','EXPIRADA')
                           AND o.expires_at < NOW()
                    )`
            );
        } catch (e) {
            console.error("ERRO ao expirar negociações:", e.message);
        }
    }

    /* =========================================================
       PAGAMENTO — PROCESSAR CONFIRMAÇÃO
       Chamado pelo webhook (e pelo polling de status).
       Só executa após a Order estar paga.
    ========================================================= */

    async function processarPagamento({ mpOrderId, totalCents }) {
        if (!pgOk()) return null;

        await expirarNegociacoesVencidas();

        const pool = pg();

        const cobradoIgual = (valorReal) =>
            totalCents == null ||
            paraCentavos(valorReal) === totalCents;

        /* 1) Pacote de figurinhas */
        const packQ = await pool.query(
            `SELECT * FROM sticker_pack_purchases
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'pending'
              LIMIT 1`,
            [mpOrderId]
        );
        if (packQ.rows[0]) {
            if (!cobradoIgual(packQ.rows[0].price)) {
                registrarLog("colecionavel_pagamento_valor_divergente", {
                    mpOrderId,
                    tipo: "pack",
                    pedidoId: packQ.rows[0].id,
                    cobradoCents: paraCentavos(packQ.rows[0].price),
                    pagoCents: totalCents
                });
                console.error(
                    "[COLECIONAVEL] VALOR DIVERGENTE (pacote). NÃO entregue.",
                    { mpOrderId, cobradoCents: paraCentavos(packQ.rows[0].price), pagoCents: totalCents }
                );
                return null;
            }
            await confirmarCompraPacote(packQ.rows[0], mpOrderId);
            return { tipo: "pack" };
        }

        const auctionQ = await pool.query(
            `SELECT * FROM sticker_auction_orders WHERE (mp_order_id = $1 OR order_id = $1) AND status = 'pending' LIMIT 1`,
            [mpOrderId]
        );
        if (auctionQ.rows[0]) {
            if (!cobradoIgual(auctionQ.rows[0].total)) return null;
            await confirmarCompraLeilao(auctionQ.rows[0], mpOrderId);
            return { tipo: "auction" };
        }

        /* 2) Compra no mercado (anúncio) ou oferta aceita */
        const orderQ = await pool.query(
            `SELECT * FROM sticker_orders
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'pending'
              LIMIT 1`,
            [mpOrderId]
        );
        if (orderQ.rows[0]) {
            if (!cobradoIgual(orderQ.rows[0].total)) {
                registrarLog("colecionavel_pagamento_valor_divergente", {
                    mpOrderId,
                    tipo: "purchase",
                    pedidoId: orderQ.rows[0].id,
                    cobradoCents: paraCentavos(orderQ.rows[0].total),
                    pagoCents: totalCents
                });
                console.error(
                    "[COLECIONAVEL] VALOR DIVERGENTE (mercado). NÃO entregue.",
                    { mpOrderId, cobradoCents: paraCentavos(orderQ.rows[0].total), pagoCents: totalCents }
                );
                return null;
            }
            if (orderQ.rows[0].offer_id) {
                await confirmarCompraOferta(orderQ.rows[0], mpOrderId);
                return { tipo: "offer" };
            }
            await confirmarCompraMercado(orderQ.rows[0], mpOrderId);
            return { tipo: "purchase" };
        }

        /* 3) Troca com diferença (pagamento da diferença) */
        const tradeQ = await pool.query(
            `SELECT * FROM sticker_trades
              WHERE (mp_order_id = $1 OR order_id = $1)
                AND status = 'WAITING_PAYMENT'
              LIMIT 1`,
            [mpOrderId]
        );
        if (tradeQ.rows[0]) {
            if (!cobradoIgual(tradeQ.rows[0].cash_amount)) {
                registrarLog("colecionavel_pagamento_valor_divergente", {
                    mpOrderId,
                    tipo: "trade",
                    pedidoId: tradeQ.rows[0].id,
                    cobradoCents: paraCentavos(tradeQ.rows[0].cash_amount),
                    pagoCents: totalCents
                });
                console.error(
                    "[COLECIONAVEL] VALOR DIVERGENTE (troca). NÃO confirmada.",
                    { mpOrderId, cobradoCents: paraCentavos(tradeQ.rows[0].cash_amount), pagoCents: totalCents }
                );
                return null;
            }
            await confirmarPagamentoTroca(tradeQ.rows[0], mpOrderId);
            return { tipo: "trade" };
        }

        return null;
    }

    async function processarMarketplacePayment(paymentId) {
        if (!pgOk() || typeof consultarMercadoPagoPayment !== "function") return null;
        const orders = await pg().query(
            `SELECT * FROM sticker_orders WHERE status = 'pending' AND payment_type = 'STICKER_MARKETPLACE_SPLIT' ORDER BY created_at ASC LIMIT 100`
        );
        for (const order of orders.rows) {
            const account = await marketplaceConta(order.seller_id);
            if (!account || !account.accessToken) continue;
            let payment;
            try { payment = await consultarMercadoPagoPayment(account.accessToken, paymentId); } catch(e) { continue; }
            if (String(payment.external_reference || "") !== String(order.order_id)) continue;
            const status = String(payment.status || "").toLowerCase();
            const paidAmount = Number(payment.transaction_amount ?? payment.transaction_details?.total_paid_amount ?? 0);
            if (!["approved", "accredited", "processed"].includes(status)) return { status, approved: false };
            if (Math.round(paidAmount * 100) !== Math.round(Number(order.total) * 100)) return { status, approved: false, amountMismatch: true };
            if (order.offer_id) {
                await confirmarCompraOferta(order, paymentId);
                return { status, approved: true, orderId: order.order_id, tipo: "offer" };
            }
            await confirmarCompraMercado(order, paymentId);
            return { status, approved: true, orderId: order.order_id };
        }
        const auctionOrders = await pg().query(
            `SELECT * FROM sticker_auction_orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`
        );
        for (const order of auctionOrders.rows) {
            const auction = await pg().query(`SELECT seller_id FROM sticker_auctions WHERE id = $1`, [order.auction_id]);
            const account = auction.rows[0] ? await marketplaceConta(auction.rows[0].seller_id) : null;
            if (!account || !account.accessToken) continue;
            let payment;
            try { payment = await consultarMercadoPagoPayment(account.accessToken, paymentId); } catch(e) { continue; }
            if (String(payment.external_reference || "") !== String(order.order_id)) continue;
            const status = String(payment.status || "").toLowerCase();
            const paidAmount = Number(payment.transaction_amount ?? payment.transaction_details?.total_paid_amount ?? 0);
            if (!["approved", "accredited", "processed"].includes(status)) return { status, approved: false };
            if (Math.round(paidAmount * 100) !== Math.round(Number(order.total) * 100)) return { status, approved: false, amountMismatch: true };
            await confirmarCompraLeilao(order, paymentId);
            return { status, approved: true, orderId: order.order_id };
        }
        const splitTrades = await pg().query(
            `SELECT * FROM sticker_trades WHERE status = 'WAITING_PAYMENT' AND payment_type = 'STICKER_TRADE_SPLIT' LIMIT 100`
        );
        for (const trade of splitTrades.rows) {
            const sellerId = trade.cash_direction === "proposer_pays" ? trade.receiver_id : trade.proposer_id;
            const account = await marketplaceConta(sellerId);
            if (!account || !account.accessToken) continue;
            let payment;
            try { payment = await consultarMercadoPagoPayment(account.accessToken, paymentId); } catch(e) { continue; }
            if (String(payment.external_reference || "") !== String(trade.order_id)) continue;
            const status = String(payment.status || "").toLowerCase();
            const paidAmount = Number(payment.transaction_amount ?? payment.transaction_details?.total_paid_amount ?? 0);
            if (!["approved", "accredited", "processed"].includes(status)) return { status, approved: false };
            if (Math.round(paidAmount * 100) !== Math.round(Number(trade.cash_amount) * 100)) return { status, approved: false, amountMismatch: true };
            await confirmarPagamentoTroca(trade, paymentId);
            return { status, approved: true, orderId: trade.order_id };
        }
        return null;
    }

    /* Entrega figurinhas de um pacote diretamente ao acervo do usuário,
       SEM passar por cobrança (usada pelos Combos & Kits). Idempotente:
       chamada apenas uma vez por pedido pago. */
    async function entregarPacoteParaUsuario({ usuarioId, packId, quantidade = 1, refId = null }) {
        if (!pgOk()) {
            throw new Error("Sistema de colecionáveis indisponível no momento.");
        }

        const pool = pg();

        const packQ = await pool.query(
            `SELECT * FROM sticker_packs WHERE id = $1 AND is_active = TRUE`,
            [packId]
        );
        const pack = packQ.rows[0];
        if (!pack) {
            throw new Error("Pacote de figurinhas não encontrado.");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const origem = String(refId || `kit-${usuarioId}-${packId}`);
            for (let i = 0; i < quantidade; i++) {
                await client.query(
                    `INSERT INTO sticker_pack_inventory (usuario_id, pack_id, source_ref)
                     VALUES ($1,$2,$3)
                     ON CONFLICT (source_ref) DO NOTHING`,
                    [usuarioId, packId, `${origem}:pack:${packId}:unit:${i}`]
                );
            }
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        await registrarTransacaoCol(
            usuarioId,
            "PACOTE_KIT_RECEBIDO",
            `Recebeu ${quantidade} pacote(s) de figurinhas ${pack.name} (Kit).`,
            0,
            refId
        );

        return {
            packId: pack.id,
            packName: pack.name,
            figurinhas: 0,
            cards: [],
            pacotes: quantidade
        };
    }

    async function confirmarCompraPacote(compra, mpOrderId) {
        const pool = pg();

        const client = await pool.connect();
        let compraAtual;
        let pack;
        let sorteadas;
        try {
            await client.query("BEGIN");
            const compraQ = await client.query(
                `SELECT * FROM sticker_pack_purchases WHERE id = $1 FOR UPDATE`,
                [compra.id]
            );
            compraAtual = compraQ.rows[0];
            if (!compraAtual) throw new Error("Compra de pacote não encontrada.");
            if (compraAtual.status === "paid" && compraAtual.figurinhas && compraAtual.figurinhas.length) {
                await client.query("COMMIT");
                return { jaConfirmado: true, aberto: compraAtual.open_status === "opened" };
            }

        const packQ = await client.query(
            `SELECT * FROM sticker_packs WHERE id = $1`,
            [compraAtual.pack_id]
        );
        pack = packQ.rows[0];
        if (!pack) throw new Error("Pacote não encontrado.");

        const colQ = await client.query(
            `SELECT * FROM sticker_cards
              WHERE collection_id = $1 AND is_active = TRUE
              ORDER BY id`,
            [pack.collection_id]
        );
        const cards = colQ.rows;

        sorteadas = sortearCards(cards, compraAtual.quantity);

            await client.query(
                `UPDATE sticker_pack_purchases
                    SET status = 'paid', paid_at = NOW(),
                        mp_order_id = COALESCE(mp_order_id, $2),
                        figurinhas = $3,
                        open_status = 'unopened', opened_at = NULL
                  WHERE id = $1`,
                [compraAtual.id, mpOrderId, sorteadas.map((c) => c.id)]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        const compraBase = compraAtual || compra;

        if (compraBase.story_opt_in && typeof registrarStoryEvento === "function") {
            await registrarStoryEvento({
                eventKey: `pack:${compraBase.order_id}`,
                kind: "pack",
                title: "🎁 NOVO PACOTE",
                subtitle: `${pack.name} • ${sorteadas.length} figurinhas`,
                actionType: "pack",
                actionId: pack.id,
                metadata: { packId: pack.id, quantity: sorteadas.length }
            });
        }

        await registrarTransacaoCol(
            compraBase.usuario_id,
            "PACOTE_COMPRADO",
            `Comprou o pacote ${pack.name} com ${sorteadas.length} figurinhas.`,
            Number(pack.price),
            compraBase.order_id
        );

        registrarLog("colecionavel_pacote_pago", {
            compraId: compraBase.id,
            mpOrderId,
            usuarioId: compraBase.usuario_id,
            figurinhas: sorteadas.length
        });
    }

    router.post("/packs/purchases/:id/open", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            const purchaseQ = await client.query(
                `SELECT spp.*, pk.name AS pack_name
                   FROM sticker_pack_purchases spp
                   JOIN sticker_packs pk ON pk.id = spp.pack_id
                  WHERE spp.id = $1 AND spp.usuario_id = $2
                  FOR UPDATE`,
                [Number(req.params.id), req.usuario.id]
            );
            const purchase = purchaseQ.rows[0];
            if (!purchase) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Pacote não encontrado." });
            }
            if (purchase.status !== "paid") {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "O pagamento deste pacote ainda não foi confirmado." });
            }
            if (!Array.isArray(purchase.figurinhas) || !purchase.figurinhas.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ error: "O sorteio deste pacote ainda não está disponível." });
            }

            const ids = purchase.figurinhas.map(Number);
            const cardQ = await client.query(
                `SELECT id, number, name, rarity, scientific_name, habitat, peso
                   FROM sticker_cards
                  WHERE collection_id = (SELECT collection_id FROM sticker_packs WHERE id = $1)
                    AND is_active = TRUE`,
                [purchase.pack_id]
            );
            const porId = new Map(cardQ.rows.map(card => [card.id, card]));
            const cards = ids.map(id => porId.get(id)).filter(Boolean);

            if (purchase.open_status !== "opened") {
                for (const card of cards) {
                    await client.query(
                        `INSERT INTO user_stickers (usuario_id, card_id, quantity)
                         VALUES ($1,$2,1)
                         ON CONFLICT (usuario_id, card_id)
                         DO UPDATE SET quantity = user_stickers.quantity + 1`,
                        [req.usuario.id, card.id]
                    );
                }
                await client.query(
                    `UPDATE sticker_pack_purchases
                        SET open_status = 'opened', opened_at = NOW()
                      WHERE id = $1 AND open_status = 'unopened'`,
                    [purchase.id]
                );
            }
            await client.query("COMMIT");

            for (const card of cards) {
                await registrarTransacaoCol(
                    req.usuario.id,
                    "FIGURINHA_RECEBIDA",
                    `Recebeu a figurinha #${String(card.number).padStart(3, "0")} ${card.name}.`,
                    0,
                    purchase.order_id
                );
                if (purchase.story_opt_in && typeof registrarStoryEvento === "function" && ["RARA", "EPICA", "LENDARIA", "MITICA"].includes(card.rarity)) {
                    await registrarStoryEvento({
                        eventKey: `pack:${purchase.order_id}:card:${card.id}`,
                        kind: "card",
                        title: `✨ NOVA FIGURINHA ${card.rarity}`,
                        subtitle: `${card.name} • #${String(card.number).padStart(3, "0")}`,
                        actionType: "card",
                        actionId: card.id,
                        metadata: { cardId: card.id, rarity: card.rarity, number: Number(card.number) }
                    });
                }
            }
            const colecao = await colecaoAtiva();
            if (colecao) await verificarConquistas(req.usuario.id, colecao.id);
            res.json({ ok: true, aberto: true, purchaseId: purchase.id, pacote: { nome: purchase.pack_name, quantidade: purchase.quantity, figurinhas: cards } });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch(e) {}
            res.status(500).json({ error: error.message });
        } finally {
            client.release();
        }
    });

    router.get("/meus-pacotes", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            const direct = await pg().query(
                `SELECT spp.id, spp.quantity, spp.open_status, spp.opened_at, pk.name AS pack_name
                   FROM sticker_pack_purchases spp JOIN sticker_packs pk ON pk.id = spp.pack_id
                  WHERE spp.usuario_id = $1 AND spp.status = 'paid' AND spp.open_status <> 'opened'
                  ORDER BY spp.paid_at ASC, spp.id ASC`,
                [req.usuario.id]
            );
            const kits = await pg().query(
                `SELECT inv.id, pk.name AS pack_name, 'kit' AS origem
                   FROM sticker_pack_inventory inv JOIN sticker_packs pk ON pk.id = inv.pack_id
                  WHERE inv.usuario_id = $1 AND inv.status = 'unopened'
                  ORDER BY inv.created_at ASC, inv.id ASC`,
                [req.usuario.id]
            );
            res.json({ ok: true, pacotes: [
                ...direct.rows.map(row => ({ id: row.id, tipo: "purchase", nome: row.pack_name, quantidade: row.quantity })),
                ...kits.rows.map(row => ({ id: row.id, tipo: "kit", nome: row.pack_name, quantidade: 1 }))
            ] });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    router.post("/packs/inventory/:id/open", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            const invQ = await client.query(
                `SELECT inv.*, pk.name AS pack_name, pk.collection_id, pk.sticker_quantity
                   FROM sticker_pack_inventory inv JOIN sticker_packs pk ON pk.id = inv.pack_id
                  WHERE inv.id = $1 AND inv.usuario_id = $2 FOR UPDATE`,
                [Number(req.params.id), req.usuario.id]
            );
            const inv = invQ.rows[0];
            if (!inv) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Pacote do kit não encontrado." }); }
            if (inv.status === "opened" && Array.isArray(inv.figurinhas)) {
                await client.query("ROLLBACK");
                return res.json({ ok: true, aberto: true, pacote: { nome: inv.pack_name, figurinhas: [] } });
            }
            const cardsQ = await client.query(
                `SELECT id, number, name, rarity, scientific_name, habitat, peso
                   FROM sticker_cards WHERE collection_id = $1 AND is_active = TRUE ORDER BY id`,
                [inv.collection_id]
            );
            const sorteadas = sortearCards(cardsQ.rows, Number(inv.sticker_quantity) || 3);
            for (const card of sorteadas) {
                await client.query(
                    `INSERT INTO user_stickers (usuario_id, card_id, quantity) VALUES ($1,$2,1)
                     ON CONFLICT (usuario_id, card_id) DO UPDATE SET quantity = user_stickers.quantity + 1`,
                    [req.usuario.id, card.id]
                );
            }
            await client.query(
                `UPDATE sticker_pack_inventory SET status = 'opened', opened_at = NOW(), figurinhas = $2 WHERE id = $1`,
                [inv.id, sorteadas.map(card => card.id)]
            );
            await client.query("COMMIT");
            for (const card of sorteadas) {
                await registrarTransacaoCol(req.usuario.id, "FIGURINHA_RECEBIDA", `Recebeu a figurinha #${String(card.number).padStart(3, "0")} ${card.name}.`, 0, `KIT-PACK-${inv.id}`);
            }
            const colecao = await colecaoAtiva();
            if (colecao) await verificarConquistas(req.usuario.id, colecao.id);
            res.json({ ok: true, aberto: true, pacote: { nome: inv.pack_name, quantidade: sorteadas.length, figurinhas: sorteadas } });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch(e) {}
            res.status(500).json({ error: error.message });
        } finally { client.release(); }
    });

    async function confirmarCompraLeilao(order, mpOrderId) {
        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            const q = await client.query(`SELECT * FROM sticker_auctions WHERE id = $1 FOR UPDATE`, [order.auction_id]);
            const auction = q.rows[0];
            if (!auction || auction.status !== "payment_pending" || auction.winner_id !== order.buyer_id) throw new Error("Leilão não está aguardando pagamento deste vencedor.");
            const reservation = await client.query(`SELECT * FROM sticker_auction_reservations WHERE auction_id = $1 AND status = 'reserved' FOR UPDATE`, [auction.id]);
            if (!reservation.rows[0]) throw new Error("Reserva do leilão não encontrada.");
            const removed = await client.query(`UPDATE user_stickers SET quantity = quantity - 1 WHERE usuario_id = $1 AND card_id = $2 AND quantity >= 1`, [auction.seller_id, auction.card_id]);
            if (!removed.rowCount) throw new Error("O vendedor não possui mais a figurinha reservada.");
            await client.query(`INSERT INTO user_stickers (usuario_id, card_id, quantity) VALUES ($1,$2,1) ON CONFLICT (usuario_id, card_id) DO UPDATE SET quantity = user_stickers.quantity + 1`, [order.buyer_id, auction.card_id]);
            await client.query(`UPDATE sticker_auction_orders SET status = 'paid', paid_at = NOW(), mp_order_id = COALESCE(mp_order_id, $2) WHERE id = $1`, [order.id, mpOrderId]);
            await client.query(`UPDATE sticker_auctions SET status = 'paid', payment_status = 'paid', closed_at = COALESCE(closed_at, NOW()) WHERE id = $1`, [auction.id]);
            await client.query(`UPDATE sticker_auction_reservations SET status = 'transferred', released_at = NOW() WHERE auction_id = $1`, [auction.id]);
            await client.query("COMMIT");
            const card = await cardPorId(auction.card_id);
            const label = card ? `#${String(card.number).padStart(3, "0")} ${card.name}` : `#${auction.card_id}`;
            await registrarTransacaoCol(order.buyer_id, "LEILAO_COMPRADO", `Arrematou ${label} por R$ ${Number(order.total).toFixed(2)}.`, Number(order.total), order.order_id);
            await registrarTransacaoCol(auction.seller_id, "LEILAO_VENDIDO", `Vendeu ${label} por R$ ${Number(order.seller_amount).toFixed(2)} após taxa.`, Number(order.seller_amount), order.order_id);
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch(e) {}
            throw error;
        } finally { client.release(); }
    }

    async function confirmarCompraMercado(order, mpOrderId) {
        const pool = pg();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            /* Bloqueia a linha da listagem para evitar race condition */
            const lq = await client.query(
                `SELECT * FROM sticker_listings
                  WHERE id = $1 FOR UPDATE`,
                [order.listing_id]
            );
            const listing = lq.rows[0];

            if (!listing || listing.status !== "active") {
                throw new Error("Anúncio não está mais ativo.");
            }

            if (listing.quantity < order.quantity) {
                throw new Error("Quantidade insuficiente no anúncio.");
            }

            const novaQtd = listing.quantity - order.quantity;

            if (novaQtd === 0) {
                await client.query(
                    `UPDATE sticker_listings
                        SET status = 'sold'
                      WHERE id = $1`,
                    [listing.id]
                );
            } else {
                await client.query(
                    `UPDATE sticker_listings
                        SET quantity = $2
                      WHERE id = $1`,
                    [listing.id, novaQtd]
                );
            }

            /* Transfere do vendedor para o comprador */
            const retirada = await client.query(
                `UPDATE user_stickers
                    SET quantity = quantity - $3
                  WHERE usuario_id = $1 AND card_id = $2
                    AND quantity >= $3`,
                [listing.seller_id, order.card_id, order.quantity]
            );
            if (!retirada.rowCount) {
                throw new Error("O vendedor não possui mais a quantidade anunciada.");
            }

            await client.query(
                `INSERT INTO user_stickers (usuario_id, card_id, quantity)
                 VALUES ($1,$2,$3)
                 ON CONFLICT (usuario_id, card_id)
                 DO UPDATE SET quantity =
                     user_stickers.quantity + EXCLUDED.quantity`,
                [order.buyer_id, order.card_id, order.quantity]
            );

            await client.query(
                `UPDATE sticker_orders
                    SET status = 'paid', paid_at = NOW(),
                        mp_order_id = COALESCE(mp_order_id, $2)
                  WHERE id = $1`,
                [order.id, mpOrderId]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        const card = await cardPorId(order.card_id);
        const cardLabel = card
            ? `#${String(card.number).padStart(3, "0")} ${card.name}`
            : `#${order.card_id}`;

        await registrarTransacaoCol(
            order.buyer_id,
            "COMPRA_MERCADO",
            `Comprou ${order.quantity}x ${cardLabel} por R$ ${Number(order.total).toFixed(2)}.`,
            Number(order.total),
            order.order_id
        );

        await registrarTransacaoCol(
            order.seller_id,
            "VENDA_MERCADO",
            `Vendeu ${order.quantity}x ${cardLabel} por R$ ${Number(order.total).toFixed(2)} (líquido R$ ${Number(order.net_seller).toFixed(2)}).`,
            Number(order.net_seller),
            order.order_id
        );

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(order.buyer_id, colecao.id);
            await desbloquearConquista(order.seller_id, "primeira_venda");
        }

        registrarLog("colecionavel_compra_paga", {
            orderId: order.order_id,
            mpOrderId,
            comprador: order.buyer_id,
            vendedor: order.seller_id
        });
    }

    /* Pagamento de uma OFERTA aceita. Transfere as figurinhas do
       vendedor (offeree) para o comprador (offeror) e finaliza a
       oferta + reserva. Tudo dentro de uma transação para não vender
       a mesma unidade duas vezes. */
    async function confirmarCompraOferta(order, mpOrderId) {
        const pool = pg();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const oq = await client.query(
                `SELECT * FROM sticker_offers WHERE id = $1 FOR UPDATE`,
                [order.offer_id]
            );
            const offer = oq.rows[0];
            if (!offer || (offer.status !== "ACEITA" && offer.status !== "AGUARDANDO_PAGAMENTO")) {
                throw new Error("Oferta não está mais aceita.");
            }
            if (Number(offer.amount) !== Number(order.total)) {
                throw new Error("Valor da oferta divergente.");
            }

            /* Reserva criada no aceite: garante a unidade. */
            const rq = await client.query(
                `SELECT * FROM sticker_offer_reservations
                  WHERE offer_id = $1 AND status = 'ATIVA'
                  FOR UPDATE`,
                [order.offer_id]
            );
            const reserva = rq.rows[0];
            if (!reserva || reserva.quantity !== order.quantity) {
                throw new Error("Reserva da oferta não encontrada.");
            }

            /* Retira do vendedor (offeree). */
            const retirada = await client.query(
                `UPDATE user_stickers
                    SET quantity = quantity - $3
                  WHERE usuario_id = $1 AND card_id = $2
                    AND quantity >= $3`,
                [offer.offeree_id, order.card_id, order.quantity]
            );
            if (!retirada.rowCount) {
                throw new Error("O vendedor não possui mais a quantidade da oferta.");
            }

            /* Entrega ao comprador (offeror). */
            await client.query(
                `INSERT INTO user_stickers (usuario_id, card_id, quantity)
                 VALUES ($1,$2,$3)
                 ON CONFLICT (usuario_id, card_id)
                 DO UPDATE SET quantity =
                     user_stickers.quantity + EXCLUDED.quantity`,
                [order.buyer_id, order.card_id, order.quantity]
            );

            /* Confirmação REAL do Mercado Pago: PAGA (momento da
               confirmação) e, no mesmo bloco transacional, a
               transferência da figurinha com a oferta em CONCLUIDA. */
            await client.query(
                `UPDATE sticker_offers
                    SET status = 'PAGA', updated_at = NOW()
                  WHERE id = $1`,
                [offer.id]
            );
            await client.query(
                `UPDATE sticker_offers
                    SET status = 'CONCLUIDA', updated_at = NOW()
                  WHERE id = $1`,
                [offer.id]
            );
            await client.query(
                `UPDATE sticker_offer_reservations
                    SET status = 'CONCLUIDA'
                  WHERE id = $1`,
                [reserva.id]
            );
            await client.query(
                `UPDATE sticker_orders
                    SET status = 'paid', paid_at = NOW(),
                        mp_order_id = COALESCE(mp_order_id, $2)
                  WHERE id = $1`,
                [order.id, mpOrderId]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        const card = await cardPorId(order.card_id);
        const cardLabel = card
            ? `#${String(card.number).padStart(3, "0")} ${card.name}`
            : `#${order.card_id}`;

        await registrarTransacaoCol(
            order.buyer_id,
            "COMPRA_OFERTA",
            `Oferta aceita: comprou ${order.quantity}x ${cardLabel} por R$ ${Number(order.total).toFixed(2)}.`,
            Number(order.total),
            order.order_id
        );
        await registrarTransacaoCol(
            order.seller_id,
            "VENDA_OFERTA",
            `Oferta aceita: vendeu ${order.quantity}x ${cardLabel} por R$ ${Number(order.total).toFixed(2)} (líquido R$ ${Number(order.net_seller).toFixed(2)}).`,
            Number(order.net_seller),
            order.order_id
        );

        // Notificar comprador sobre pagamento confirmado e figurinha recebida
        if (typeof criarNotificacao === "function") {
            await criarNotificacao(
                order.buyer_id,
                "pagamento_aprovado",
                "Pagamento aprovado!",
                `Seu pagamento de R$ ${Number(order.total).toFixed(2)} foi confirmado.`,
                { offerId: offer.id, orderId: order.id, valor: Number(order.total) }
            );
            await criarNotificacao(
                order.buyer_id,
                "figurinha_recebida",
                "Figurinha recebida!",
                `Você recebeu ${order.quantity}x ${cardLabel}. Confira seu álbum!`,
                { cardId: order.card_id, quantidade: order.quantity }
            );
            // Notificar vendedor sobre venda
            await criarNotificacao(
                order.seller_id,
                "venda_realizada",
                "Venda realizada!",
                `Você vendeu ${order.quantity}x ${cardLabel} por R$ ${Number(order.net_seller).toFixed(2)}.`,
                { offerId: offer.id, orderId: order.id, valor: Number(order.net_seller) }
            );
        }

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(order.buyer_id, colecao.id);
            await desbloquearConquista(order.seller_id, "primeira_venda");
        }

        registrarLog("colecionavel_oferta_paga", {
            orderId: order.order_id,
            offerId: order.offer_id,
            mpOrderId,
            comprador: order.buyer_id,
            vendedor: order.seller_id
        });
    }

    async function confirmarPagamentoTroca(trade, mpOrderId) {
        const pool = pg();

        await executarTroca(trade, mpOrderId);

        await registrarTransacaoDupla(
            trade.proposer_id,
            trade.receiver_id,
            "TROCA_DIFERENCA",
            `Troca com diferença de R$ ${Number(trade.cash_amount).toFixed(2)} concluída.`,
            Number(trade.cash_amount),
            trade.order_id
        );

        const colecao = await colecaoAtiva();
        if (colecao) {
            await verificarConquistas(trade.proposer_id, colecao.id);
            await verificarConquistas(trade.receiver_id, colecao.id);
            await desbloquearConquista(trade.proposer_id, "primeira_troca");
            await desbloquearConquista(trade.receiver_id, "primeira_troca");
        }

        registrarLog("colecionavel_troca_paga", {
            tradeId: trade.id,
            mpOrderId,
            valor: Number(trade.cash_amount)
        });
    }

    /* Executa a transferência de figurinhas de uma negociação
       ACEITA. Usada tanto para troca simples quanto com dinheiro. */
    async function executarTroca(trade, mpOrderId = null) {
        const pool = pg();

        const itemsQ = await pool.query(
            `SELECT * FROM sticker_trade_items WHERE trade_id = $1`,
            [trade.id]
        );
        const items = itemsQ.rows;

        const oferecidas = items.filter(i => i.side === "proposer");
        const recebidas = items.filter(i => i.side === "receiver");

        /* Proposer entrega as que oferece e recebe as que o receiver oferece */
        for (const item of oferecidas) {
            await removerFigurinhas(item.owner_id, item.card_id, 1);
            await adicionarFigurinha(trade.receiver_id, item.card_id, 1);
        }

        for (const item of recebidas) {
            await removerFigurinhas(item.owner_id, item.card_id, 1);
            await adicionarFigurinha(trade.proposer_id, item.card_id, 1);
        }

        await pool.query(
            `UPDATE sticker_trades
                SET status = 'COMPLETED',
                    updated_at = NOW(),
                    completed_at = NOW(),
                    mp_order_id = COALESCE($2, mp_order_id)
              WHERE id = $1`,
            [trade.id, mpOrderId]
        );
    }

    /* =========================================================
       EXPORTAÇÕES PARA O SERVER.JS
    ========================================================= */

    /* Rotas públicas e autenticadas */
    router.get("/info", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();
            const packsQ = await pg().query(
                `SELECT * FROM sticker_packs
                  WHERE collection_id = $1 AND is_active = TRUE
                  ORDER BY price`,
                [colecao.id]
            );
            const cardsQ = await pg().query(
                `SELECT id, number, name, description, rarity, image_url,
                        scientific_name, habitat, peso
                   FROM sticker_cards
                  WHERE collection_id = $1 AND is_active = TRUE
                  ORDER BY number`,
                [colecao.id]
            );
            const cards = cardsQ.rows.map(c => ({
                ...c,
                number: Number(c.number)
            }));

            res.json({
                ok: true,
                colecao: {
                    id: colecao.id,
                    slug: colecao.slug,
                    name: colecao.name,
                    edition: colecao.edition,
                    total: Number(colecao.total),
                    description: colecao.description
                },
                packs: packsQ.rows.map(p => ({
                    id: p.id,
                    slug: p.slug,
                    name: p.name,
                    price: Number(p.price),
                    sticker_quantity: Number(p.sticker_quantity),
                    description: p.description
                })),
                cards,
                raridades: RARIDADE_ORDEM.map(chave => ({
                    chave,
                    nome: RARIDADES[chave].nome,
                    icone: RARIDADES[chave].icone,
                    cor: RARIDADES[chave].cor
                })),
                probabilidades: PROBABILIDADES,
                marketplaceFeePercent: MARKETPLACE_FEE_PERCENT
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.get("/catalogo", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();
            const cardsQ = await pg().query(
                `SELECT id, number, name, description, rarity, image_url,
                        scientific_name, habitat, peso
                   FROM sticker_cards
                  WHERE collection_id = $1 AND is_active = TRUE
                  ORDER BY number`,
                [colecao.id]
            );
            res.json({
                ok: true,
                colecao: { id: colecao.id, name: colecao.name, total: Number(colecao.total) },
                cards: cardsQ.rows.map(c => ({ ...c, number: Number(c.number) }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* MEU ÁLBUM — figurinhas possuídas (quantidade). */
    router.get("/meu-album", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const colecao = await colecaoAtiva();
            const q = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.image_url,
                        c.scientific_name, c.habitat, c.peso,
                        COALESCE(us.quantity,0) AS quantidade
                   FROM sticker_cards c
                   LEFT JOIN user_stickers us
                          ON us.card_id = c.id
                         AND us.usuario_id = $1
                  WHERE c.collection_id = $2 AND c.is_active = TRUE
                  ORDER BY c.number`,
                [req.usuario.id, colecao.id]
            );
            res.json({
                ok: true,
                colecao: {
                    name: colecao.name,
                    edition: colecao.edition,
                    total: Number(colecao.total)
                },
                cards: q.rows.map(c => ({
                    id: c.id,
                    number: Number(c.number),
                    name: c.name,
                    rarity: c.rarity,
                    image_url: c.image_url,
                    scientific_name: c.scientific_name,
                    habitat: c.habitat,
                    peso: c.peso,
                    quantidade: Number(c.quantidade)
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* MEU ACERVO — resumo, filtros, busca, ordenação. */
    router.get("/acervo", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const colecao = await colecaoAtiva();

            const {
                raridade, busca, ordenar, repetidas, pagina = 1
            } = req.query;

            const limite = 60;
            const offset = Math.max(0, (Number(pagina) || 1) - 1) * limite;

            const params = [req.usuario.id, colecao.id];
            let where = `us.quantity > 0
                         AND us.usuario_id = $1
                         AND c.collection_id = $2`;

            if (raridade) {
                params.push(raridade);
                where += ` AND c.rarity = $${params.length}`;
            }
            if (busca) {
                params.push(`%${busca}%`);
                where += ` AND (c.name ILIKE $${params.length}
                                OR c.number::text ILIKE $${params.length})`;
            }
            if (repetidas === "novas") {
                where += ` AND us.quantity = 1`;
            } else if (repetidas === "repetidas") {
                where += ` AND us.quantity > 1`;
            }

            let order = "c.number ASC";
            if (ordenar === "raridade") {
                order = "CASE c.rarity WHEN 'COMUM' THEN 1 WHEN 'INCOMUM' THEN 2 WHEN 'RARA' THEN 3 WHEN 'EPICA' THEN 4 WHEN 'LENDARIA' THEN 5 WHEN 'MITICA' THEN 6 ELSE 7 END DESC, c.number ASC";
            } else if (ordenar === "recentes") {
                order = "us.acquired_at DESC, c.number ASC";
            }

            const q = await pg().query(
                `SELECT c.id, c.number, c.name, c.scientific_name, c.habitat, c.peso,
                        c.description, c.rarity, c.image_url,
                        us.quantity, us.acquired_at
                   FROM user_stickers us
                   JOIN sticker_cards c ON c.id = us.card_id
                  WHERE ${where}
                  ORDER BY ${order}
                  LIMIT ${limite} OFFSET ${offset}`,
                params
            );

            /* Listagens ativas do usuário (para calcular disponível). */
            const listaQ = await pg().query(
                `SELECT card_id, COALESCE(SUM(quantity),0)::int AS qtd
                   FROM sticker_listings
                  WHERE seller_id = $1 AND status = 'active'
                  GROUP BY card_id`,
                [req.usuario.id]
            );
            const listadas = new Map(listaQ.rows.map(r => [r.card_id, Number(r.qtd)]));

            const totalQ = await pg().query(
                `SELECT COUNT(*)::int AS total
                   FROM user_stickers us
                   JOIN sticker_cards c ON c.id = us.card_id
                  WHERE ${where}`,
                params
            );

            const statsQ = await pg().query(
                `SELECT
                     COALESCE(SUM(us.quantity),0)::int AS total,
                     COUNT(DISTINCT us.card_id)::int   AS diferentes,
                     COALESCE(SUM(CASE WHEN us.quantity > 1 THEN us.quantity - 1 ELSE 0 END),0)::int AS repetidas,
                     COALESCE(SUM(CASE WHEN c.rarity IN ('RARA','EPICA','LENDARIA','MITICA') THEN 1 ELSE 0 END),0)::int AS raras
                  FROM user_stickers us
                  JOIN sticker_cards c ON c.id = us.card_id
                 WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2`,
                [req.usuario.id, colecao.id]
            );

            res.json({
                ok: true,
                stats: {
                    total: Number(statsQ.rows[0]?.total || 0),
                    diferentes: Number(statsQ.rows[0]?.diferentes || 0),
                    repetidas: Number(statsQ.rows[0]?.repetidas || 0),
                    raras: Number(statsQ.rows[0]?.raras || 0)
                },
                cards: q.rows.map(c => ({
                    id: c.id,
                    number: Number(c.number),
                    name: c.name,
                    description: c.description,
                    rarity: c.rarity,
                    image_url: c.image_url,
                    quantidade: Number(c.quantity),
                    disponivel: Math.max(0, Number(c.quantity) - Number(listadas.get(c.id) || 0)),
                    acquired_at: c.acquired_at
                })),
                pagina: Number(pagina) || 1,
                totalItems: Number(totalQ.rows[0]?.total || 0),
                totalPaginas: Math.max(1, Math.ceil((Number(totalQ.rows[0]?.total || 0)) / limite))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* DETALHE de uma figurinha do acervo. */
    router.get("/figurinha/:id", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const card = await cardPorId(req.params.id);
            if (!card) {
                return res.status(404).json({ error: "Figurinha não encontrada." });
            }

            const q = await pg().query(
                `SELECT quantity, acquired_at FROM user_stickers
                  WHERE usuario_id = $1 AND card_id = $2`,
                [req.usuario.id, card.id]
            );

            const circulQ = await pg().query(
                `SELECT COALESCE(SUM(quantity),0)::int AS total
                   FROM user_stickers WHERE card_id = $1`,
                [card.id]
            );

            res.json({
                ok: true,
                card: {
                    id: card.id,
                    number: Number(card.number),
                    name: card.name,
                    description: card.description,
                    rarity: card.rarity,
                    image_url: card.image_url,
                    scientific_name: card.scientific_name,
                    habitat: card.habitat,
                    peso: card.peso,
                    quantidade: q.rows[0] ? Number(q.rows[0].quantity) : 0,
                    acquired_at: q.rows[0]?.acquired_at || null,
                    disponivel: await quantidadeDisponivel(req.usuario.id, card.id),
                    total_em_circulacao: Number(circulQ.rows[0]?.total || 0)
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       PACOTES — CHECKOUT
    ========================================================= */

    router.post("/packs/:id/checkout", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const validacao = validarComprador(req);
            if (!validacao.ok) {
                return res.status(400).json({ error: validacao.error });
            }
            const comprador = validacao.comprador;

            const packQ = await pg().query(
                `SELECT * FROM sticker_packs
                  WHERE id = $1 AND is_active = TRUE`,
                [req.params.id]
            );
            const pack = packQ.rows[0];
            if (!pack) {
                return res.status(404).json({ error: "Pacote não encontrado." });
            }

            const usuario = await usuarioPorId(req.usuario.id);
            if (!usuario) {
                return res.status(401).json({ error: "Conta não encontrada." });
            }

            const valor = Number(pack.price);
            const orderId = gerarOrderId("COL-PACK");
            const paymentId = crypto.randomUUID();

            /* Preço vem do banco, nunca do frontend. */
            const mp = await criarOrderMercadoPago({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: valor,
                description: `MegaOutdoor Colecionáveis — Pacote ${pack.name}`,
                customer: {
                    name: comprador.nome || usuario.nome,
                    taxID: comprador.documento,
                    email: comprador.email || usuario.email
                },
                paymentMethod: req.body.paymentMethod || "pix",
                paymentMethodId: req.body.paymentMethodId,
                cardToken: req.body.cardToken,
                installments: req.body.installments
            });

            await pg().query(
                `INSERT INTO sticker_pack_purchases
                    (usuario_id, pack_id, order_id, mp_order_id, payment_id,
                     payment_type, price, quantity, status, test, story_opt_in)
                 VALUES ($1,$2,$3,$4,$5,'STICKER_PACK',$6,$7,'pending',$8,$9)`,
                [req.usuario.id, pack.id, orderId, String(mp.orderId), paymentId,
                 valor, Number(pack.sticker_quantity),
                  !!process.env.ALLOW_TEST_MODE,
                  req.body.storyOptIn === true || req.body.storyOptIn === "true"]
            );

            await registrarTransacaoCol(
                req.usuario.id,
                "PACOTE_PEDIDO",
                `Pedido do pacote ${pack.name} criado.`,
                valor,
                orderId
            );

            registrarLog("colecionavel_pacote_pedido", {
                usuarioId: req.usuario.id,
                packId: pack.id,
                orderId
            });

            res.json({
                ok: true,
                orderId: String(mp.orderId),
                externalReference: orderId,
                qrCodeBase64: mp.qrCodeBase64,
                payload: mp.payload,
                ticketUrl: mp.ticketUrl,
                expiresDate: mp.expirationDate,
                paymentId: mp.paymentId,
                valor: valor
            });
        } catch (error) {
            registrarLog("colecionavel_pacote_erro", {
                erro: error.message,
                packId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* Status de um pedido de colecionável (polling do frontend). */
    /* Devolve o sorteio JÁ PERSISTIDO de um pacote pago, na ordem do sorteio.
       Retorna null quando não é um pacote confirmado (CORREÇÃO 7). */
    async function obterResultadoPacotePersistido(usuarioId, orderId) {
        const pool = pg();
        const detQ = await pool.query(
            `SELECT spp.id, spp.quantity, spp.figurinhas, spp.open_status, spp.opened_at,
                    pk.name AS pack_name, pk.collection_id
               FROM sticker_pack_purchases spp
               JOIN sticker_packs pk ON pk.id = spp.pack_id
              WHERE (spp.mp_order_id = $1 OR spp.order_id = $1)
                AND spp.usuario_id = $2
                AND spp.status = 'paid'
                AND spp.figurinhas IS NOT NULL
              LIMIT 1`,
            [orderId, usuarioId]
        );
        const det = detQ.rows[0];
        if (!det) return null;

        const ids = det.figurinhas.map(Number);
        if (!Array.isArray(ids) || !ids.length) return null;

        const cardQ = await pool.query(
            `SELECT id, number, name, rarity, scientific_name, habitat, peso
               FROM sticker_cards WHERE collection_id = $1 AND is_active = TRUE`,
            [det.collection_id]
        );
        const porId = new Map(cardQ.rows.map((r) => [r.id, r]));

        return {
            nome: det.pack_name,
            purchaseId: det.id,
            aberto: det.open_status === "opened",
            abertoEm: det.opened_at,
            quantidade: det.quantity,
            figurinhas: ids.map((id) => {
                const c = porId.get(id) || {};
                return {
                    id,
                    number: c.number,
                    name: c.name,
                    rarity: c.rarity,
                    scientific_name: c.scientific_name,
                    habitat: c.habitat,
                    peso: c.peso
                };
            })
        };
    }

    router.get("/pagamento/:orderId", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const orderId = req.params.orderId;

            /* Verifica se a Order pertence a algum pedido do usuário.
               Aceita tanto o id numérico do Mercado Pago (mp_order_id)
               quanto o externalReference (order_id) usado no frontend. */
            const dono = await pg().query(
                `SELECT usuario_id, mp_order_id, order_id, status, 'pack' AS tipo
                   FROM sticker_pack_purchases
                  WHERE (mp_order_id = $1 OR order_id = $1) AND usuario_id = $2
                 UNION ALL
                 SELECT buyer_id, mp_order_id, order_id, status, 'purchase' AS tipo
                   FROM sticker_orders
                  WHERE (mp_order_id = $1 OR order_id = $1) AND buyer_id = $2
                 UNION ALL
                 SELECT proposer_id, mp_order_id, order_id, status, 'trade' AS tipo
                   FROM sticker_trades
                  WHERE (mp_order_id = $1 OR order_id = $1) AND proposer_id = $2
                 UNION ALL
                 SELECT buyer_id, mp_order_id, order_id, status, 'auction' AS tipo
                   FROM sticker_auction_orders
                  WHERE (mp_order_id = $1 OR order_id = $1) AND buyer_id = $2`,
                [orderId, req.usuario.id]
            );

            if (!dono.rows.length) {
                return res.status(403).json({ error: "Acesso negado a este pedido." });
            }

            const splitOrder = await pg().query(
                `SELECT status FROM sticker_orders
                  WHERE (mp_order_id = $1 OR order_id = $1)
                    AND buyer_id = $2 AND payment_type = 'STICKER_MARKETPLACE_SPLIT'
                  LIMIT 1`,
                [orderId, req.usuario.id]
            );
            if (splitOrder.rows[0]) {
                return res.json({
                    ok: true,
                    status: splitOrder.rows[0].status === "paid" ? "RECEIVED" : "pending",
                    orderId,
                    marketplace: true
                });
            }

            /* Consulta no MP pelo id numérico real da Order. */
            const mpConsultaId = dono.rows[0].mp_order_id || orderId;
            const ordem = await consultarOrderMercadoPago(mpConsultaId);
            const pago = orderPagaMercadoPago(ordem);

            if (pago) {
                const resultado = await processarPagamento({
                    mpOrderId: mpConsultaId,
                    totalCents: paraCentavos(ordem.total_amount)
                });
                if (resultado) {
                    registrarLog("colecionavel_pagamento_confirmado_polling", {
                        orderId: mpConsultaId,
                        usuarioId: req.usuario.id
                    });
                }
            }

            res.json({
                ok: true,
                status: pago ? "RECEIVED" : (ordem.status || "pending"),
                orderId,
                pacote: await obterResultadoPacotePersistido(req.usuario.id, orderId)
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       LEILÕES DE FIGURINHAS
       Sem checkout: o encerramento com lance vencedor fica em
       payment_pending e a unidade permanece reservada.
       ========================================================= */

    async function expirarLeiloesVencidos() {
        if (!pgOk()) return;
        const vencidos = await pg().query(
            `SELECT id FROM sticker_auctions
              WHERE status = 'active' AND ends_at <= NOW()`
        );
        for (const row of vencidos.rows) {
            const client = await pg().connect();
            try {
                await client.query("BEGIN");
                const aq = await client.query(
                    `SELECT * FROM sticker_auctions
                      WHERE id = $1 AND status = 'active' FOR UPDATE`,
                    [row.id]
                );
                const auction = aq.rows[0];
                if (!auction) { await client.query("ROLLBACK"); continue; }
                const bq = await client.query(
                    `SELECT bidder_id, amount FROM sticker_auction_bids
                      WHERE auction_id = $1
                      ORDER BY amount DESC, id ASC LIMIT 1`,
                    [auction.id]
                );
                if (bq.rows[0]) {
                    await client.query(
                        `UPDATE sticker_auctions
                            SET status = 'payment_pending', payment_status = 'pending',
                                current_bid = $2, winner_id = $3, closed_at = NOW()
                          WHERE id = $1`,
                        [auction.id, bq.rows[0].amount, bq.rows[0].bidder_id]
                    );
                } else {
                    await client.query(
                        `UPDATE sticker_auctions SET status = 'expired', closed_at = NOW() WHERE id = $1`,
                        [auction.id]
                    );
                    await client.query(
                        `UPDATE sticker_auction_reservations
                            SET status = 'released', released_at = NOW()
                          WHERE auction_id = $1 AND status = 'reserved'`,
                        [auction.id]
                    );
                }
                await client.query("COMMIT");
            } catch (error) {
                try { await client.query("ROLLBACK"); } catch (e) {}
                throw error;
            } finally { client.release(); }
        }
    }

    function formatarLeilao(row) {
        return {
            id: row.id,
            seller_id: row.seller_id,
            seller_nome: row.seller_nome,
            card_id: row.card_id,
            number: Number(row.number),
            name: row.name,
            rarity: row.rarity,
            image_url: row.image_url,
            minimum_bid: Number(row.minimum_bid),
            current_bid: row.current_bid == null ? null : Number(row.current_bid),
            winner_id: row.winner_id,
            status: row.status,
            payment_status: row.payment_status,
            bid_count: Number(row.bid_count || 0),
            ends_at: row.ends_at,
            created_at: row.created_at,
            closed_at: row.closed_at
        };
    }

    const auctionSelect = `
        SELECT a.id, a.seller_id, a.card_id, a.minimum_bid, a.current_bid,
               a.winner_id, a.status, a.payment_status, a.ends_at,
               a.created_at, a.closed_at,
               c.id AS card_id, c.number, c.name, c.rarity, c.image_url,
               u.nome AS seller_nome
          FROM sticker_auctions a
          JOIN sticker_cards c ON c.id = a.card_id
          JOIN usuarios u ON u.id = a.seller_id`;

    async function comContagemLances(rows) {
        for (const row of rows) {
            const count = await pg().query(
                `SELECT COUNT(*)::int AS qtd FROM sticker_auction_bids WHERE auction_id = $1`,
                [row.id]
            );
            row.bid_count = count.rows[0]?.qtd || 0;
        }
        return rows;
    }

    router.get("/auctions", async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            await expirarLeiloesVencidos();
            const status = req.query.status === "all" ? null : (req.query.status || "active");
            const params = [];
            let where = "c.is_active = TRUE";
            if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }
            const q = await pg().query(`${auctionSelect} WHERE ${where} ORDER BY a.created_at DESC`, params);
            res.json({ ok: true, auctions: (await comContagemLances(q.rows)).map(formatarLeilao) });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    router.get("/auctions/mine", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            await expirarLeiloesVencidos();
            const q = await pg().query(`${auctionSelect} WHERE a.seller_id = $1 ORDER BY a.created_at DESC`, [req.usuario.id]);
            res.json({ ok: true, auctions: (await comContagemLances(q.rows)).map(formatarLeilao) });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    router.get("/auctions/:id", async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            await expirarLeiloesVencidos();
            const q = await pg().query(`${auctionSelect} WHERE a.id = $1`, [Number(req.params.id)]);
            if (!q.rows[0]) return res.status(404).json({ error: "Leilão não encontrado." });
            const bids = await pg().query(
                `SELECT b.id, b.bidder_id, u.nome AS bidder_nome, b.amount, b.created_at
                   FROM sticker_auction_bids b JOIN usuarios u ON u.id = b.bidder_id
                  WHERE b.auction_id = $1 ORDER BY b.amount DESC, b.id ASC`,
                [Number(req.params.id)]
            );
            q.rows[0].bid_count = bids.rows.length;
            res.json({ ok: true, auction: formatarLeilao(q.rows[0]), bids: bids.rows.map(b => ({ ...b, amount: Number(b.amount) })) });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    router.post("/auctions", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });

        /* Regra central de status: vendedor deve poder negociar. */
        const bloqueioSeller = await verificarElegibilidade(req.usuario.id);
        if (bloqueioSeller.bloqueado) return res.status(403).json({ error: bloqueioSeller.motivo });

        const contaRecebimento = await marketplaceConta(req.usuario.id);
        if (!contaRecebimento && process.env.ALLOW_TEST_MODE !== "true") {
            return res.status(400).json({ error: "Para vender ou leiloar figurinhas, conecte sua conta do Mercado Pago." });
        }
        const cardId = Number(req.body.cardId);
        const minimumBid = Math.round(Number(req.body.minimumBid ?? req.body.lanceMinimo) * 100) / 100;
        const endsAt = req.body.endsAt ? new Date(req.body.endsAt) : new Date(Date.now() + 48 * 3600 * 1000);
        if (!Number.isInteger(cardId) || cardId < 1 || !isFinite(minimumBid) || minimumBid <= 0 || minimumBid > 99999) {
            return res.status(400).json({ error: "Figurinha ou lance mínimo inválido." });
        }
        if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now()) {
            return res.status(400).json({ error: "A data de encerramento deve estar no futuro." });
        }
        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            const cardQ = await client.query(`SELECT * FROM sticker_cards WHERE id = $1 AND is_active = TRUE`, [cardId]);
            if (!cardQ.rows[0]) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Figurinha inválida." }); }
            const ownQ = await client.query(`SELECT quantity FROM user_stickers WHERE usuario_id = $1 AND card_id = $2 FOR UPDATE`, [req.usuario.id, cardId]);
            const possui = Number(ownQ.rows[0]?.quantity || 0);
            const blockedQ = await client.query(
                `SELECT
                    (SELECT COALESCE(SUM(quantity),0) FROM sticker_listings WHERE seller_id = $1 AND card_id = $2 AND status = 'active') AS listings,
                    (SELECT COUNT(*) FROM sticker_trade_items ti JOIN sticker_trades t ON t.id = ti.trade_id WHERE ti.owner_id = $1 AND ti.card_id = $2 AND t.status IN ('PENDING','COUNTER_OFFER','ACCEPTED','WAITING_PAYMENT','PAID','PROCESSING')) AS trades,
                    (SELECT COUNT(*) FROM sticker_auction_reservations r JOIN sticker_auctions a ON a.id = r.auction_id WHERE r.owner_id = $1 AND r.card_id = $2 AND r.status = 'reserved' AND a.status IN ('active','payment_pending')) AS auctions`,
                [req.usuario.id, cardId]
            );
            const blocked = Number(blockedQ.rows[0].listings) + Number(blockedQ.rows[0].trades) + Number(blockedQ.rows[0].auctions);
            if (possui - blocked < 1) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Você não possui uma unidade disponível desta figurinha." });
            }
            const inserted = await client.query(
                `INSERT INTO sticker_auctions (seller_id, card_id, minimum_bid, ends_at)
                 VALUES ($1,$2,$3,$4) RETURNING id`,
                [req.usuario.id, cardId, minimumBid, endsAt]
            );
            await client.query(
                `INSERT INTO sticker_auction_reservations (auction_id, owner_id, card_id) VALUES ($1,$2,$3)`,
                [inserted.rows[0].id, req.usuario.id, cardId]
            );
            await client.query("COMMIT");
            res.status(201).json({ ok: true, auctionId: inserted.rows[0].id, status: "active", reserved: true, paymentStatus: "not_applicable" });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (e) {}
            res.status(500).json({ error: error.message });
        } finally { client.release(); }
    });

    router.post("/auctions/:id/bids", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        await expirarLeiloesVencidos();

        /* Regra central de status: lances requerem pagamento futuro (winner),
           logo o bidder deve estar elegível para participar do marketplace. */
        const bloqueioBidder = await verificarElegibilidade(req.usuario.id);
        if (bloqueioBidder.bloqueado) return res.status(403).json({ error: bloqueioBidder.motivo });
        const amount = Math.round(Number(req.body.amount ?? req.body.lance) * 100) / 100;
        if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Valor do lance inválido." });
        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            const q = await client.query(`SELECT * FROM sticker_auctions WHERE id = $1 FOR UPDATE`, [Number(req.params.id)]);
            const auction = q.rows[0];
            if (!auction) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Leilão não encontrado." }); }
            if (auction.status !== "active" || new Date(auction.ends_at).getTime() <= Date.now()) {
                await client.query("ROLLBACK"); return res.status(400).json({ error: "Este leilão não está ativo." });
            }
            if (auction.seller_id === req.usuario.id) { await client.query("ROLLBACK"); return res.status(400).json({ error: "O vendedor não pode dar lance." }); }
            const minimum = Math.max(Number(auction.minimum_bid), Number(auction.current_bid || 0) + 0.01);
            if (amount < minimum) { await client.query("ROLLBACK"); return res.status(400).json({ error: `O lance mínimo é R$ ${minimum.toFixed(2)}.` }); }
            await client.query(`INSERT INTO sticker_auction_bids (auction_id, bidder_id, amount) VALUES ($1,$2,$3)`, [auction.id, req.usuario.id, amount]);
            await client.query(`UPDATE sticker_auctions SET current_bid = $2, winner_id = $3 WHERE id = $1`, [auction.id, amount, req.usuario.id]);
            await client.query("COMMIT");
            res.status(201).json({ ok: true, auctionId: auction.id, amount, status: "active", paymentStatus: "not_applicable" });
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (e) {}
            res.status(500).json({ error: error.message });
        } finally { client.release(); }
    });

    async function encerrarLeilao(id, usuarioId, forcarExpiracao) {
        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            const q = await client.query(`SELECT * FROM sticker_auctions WHERE id = $1 FOR UPDATE`, [id]);
            const auction = q.rows[0];
            if (!auction) { await client.query("ROLLBACK"); return { error: "Leilão não encontrado.", code: 404 }; }
            if (auction.seller_id !== usuarioId) { await client.query("ROLLBACK"); return { error: "Este leilão não é seu.", code: 403 }; }
            if (auction.status !== "active") { await client.query("ROLLBACK"); return { error: "Este leilão não está ativo.", code: 400 }; }
            const bq = await client.query(`SELECT bidder_id, amount FROM sticker_auction_bids WHERE auction_id = $1 ORDER BY amount DESC, id ASC LIMIT 1`, [id]);
            const bid = forcarExpiracao ? null : bq.rows[0];
            if (bid) {
                await client.query(`UPDATE sticker_auctions SET status = 'payment_pending', payment_status = 'pending', current_bid = $2, winner_id = $3, closed_at = NOW() WHERE id = $1`, [id, bid.amount, bid.bidder_id]);
            } else {
                await client.query(`UPDATE sticker_auctions SET status = $2, closed_at = NOW() WHERE id = $1`, [id, forcarExpiracao ? "expired" : "closed"]);
                await client.query(`UPDATE sticker_auction_reservations SET status = 'released', released_at = NOW() WHERE auction_id = $1 AND status = 'reserved'`, [id]);
            }
            await client.query("COMMIT");
            return { ok: true, status: bid ? "payment_pending" : (forcarExpiracao ? "expired" : "closed"), winnerId: bid?.bidder_id || null, paymentStatus: bid ? "pending" : "not_applicable" };
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (e) {}
            throw error;
        } finally { client.release(); }
    }

    router.post("/auctions/:id/close", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try { const result = await encerrarLeilao(Number(req.params.id), req.usuario.id, false); res.status(result.code || 200).json(result); }
        catch (error) { res.status(500).json({ error: error.message }); }
    });

    router.post("/auctions/:id/expire", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try { const result = await encerrarLeilao(Number(req.params.id), req.usuario.id, true); res.status(result.code || 200).json(result); }
        catch (error) { res.status(500).json({ error: error.message }); }
    });

    /* =========================================================
       MERCADO DE FIGURINHAS
    ========================================================= */

    /* Lista anúncios ativos com paginação e filtros. */
    router.get("/marketplace", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const { pagina = 1, raridade, precoMin, precoMax, busca, vendedor } = req.query;
            const limite = 24;
            const offset = Math.max(0, (Number(pagina) || 1) - 1) * limite;

            const params = [];
            let where = `l.status = 'active' AND c.is_active = TRUE`;

            if (raridade) {
                params.push(raridade);
                where += ` AND c.rarity = $${params.length}`;
            }
            if (precoMin) {
                params.push(Number(precoMin));
                where += ` AND l.unit_price >= $${params.length}`;
            }
            if (precoMax) {
                params.push(Number(precoMax));
                where += ` AND l.unit_price <= $${params.length}`;
            }
            if (busca) {
                params.push(`%${busca}%`);
                where += ` AND (c.name ILIKE $${params.length}
                                OR c.number::text ILIKE $${params.length})`;
            }
            if (vendedor) {
                params.push(`%${vendedor}%`);
                where += ` AND u.nome ILIKE $${params.length}`;
            }

            const q = await pg().query(
                `SELECT l.id, l.seller_id, l.unit_price, l.quantity,
                        c.id AS card_id, c.number, c.name, c.rarity, c.image_url,
                        u.nome AS vendedor_nome, u.email AS vendedor_email
                   FROM sticker_listings l
                   JOIN sticker_cards c ON c.id = l.card_id
                   JOIN usuarios u ON u.id = l.seller_id
                  WHERE ${where}
                  ORDER BY l.created_at DESC
                  LIMIT ${limite} OFFSET ${offset}`,
                params
            );

            /* Quantidade realmente vendável de cada anúncio (leva em
               conta reservas de ofertas/leilões/trocas). Marca RESERVADA
               quando nada mais pode ser vendido. */
            const listingsComDisponivel = await Promise.all(q.rows.map(async l => {
                const livre = await disponivelListagem(l.seller_id, l.card_id);
                const disponivel = Math.max(0, Math.min(Number(l.quantity), livre + Number(l.quantity)));
                return { ...l, _disponivel: disponivel };
            }));

            const totalQ = await pg().query(
                `SELECT COUNT(*)::int AS total
                   FROM sticker_listings l
                   JOIN sticker_cards c ON c.id = l.card_id
                   JOIN usuarios u ON u.id = l.seller_id
                  WHERE ${where}`,
                params
            );

            res.json({
                ok: true,
                listings: listingsComDisponivel.map(l => ({
                    id: l.id,
                    seller_id: l.seller_id,
                    seller_nome: l.vendedor_nome,
                    unit_price: Number(l.unit_price),
                    quantity: Number(l.quantity),
                    disponivel: l._disponivel,
                    reservada: l._disponivel <= 0,
                    card_id: l.card_id,
                    number: Number(l.number),
                    name: l.name,
                    rarity: l.rarity,
                    image_url: l.image_url
                })),
                pagina: Number(pagina) || 1,
                totalItems: Number(totalQ.rows[0]?.total || 0),
                totalPaginas: Math.max(1, Math.ceil((Number(totalQ.rows[0]?.total || 0)) / limite))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Cria anúncio de venda. */
    router.post("/listings", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            /* Regra central de status: vendedor deve poder negociar. */
            const bloqueioSeller = await verificarElegibilidade(req.usuario.id);
            if (bloqueioSeller.bloqueado) return res.status(403).json({ error: bloqueioSeller.motivo });

            const contaRecebimento = await marketplaceConta(req.usuario.id);
            if (!contaRecebimento && process.env.ALLOW_TEST_MODE !== "true") {
                return res.status(400).json({ error: "Para vender ou leiloar figurinhas, conecte sua conta do Mercado Pago." });
            }
            const { cardId, quantidade, preco } = req.body;

            const card = await cardPorId(cardId);
            if (!card || !card.is_active) {
                return res.status(400).json({ error: "Figurinha inválida." });
            }

            const qtd = Number(quantidade);
            const precoUnit = Number(preco);

            if (!Number.isInteger(qtd) || qtd < 1) {
                return res.status(400).json({ error: "Quantidade inválida." });
            }
            if (!isFinite(precoUnit) || precoUnit <= 0 || precoUnit > 99999) {
                return res.status(400).json({ error: "Preço inválido." });
            }

            const disponivel = await quantidadeDisponivel(req.usuario.id, card.id);
            if (qtd > disponivel) {
                return res.status(400).json({
                    error: `Você possui apenas ${disponivel} disponível(s) desta figurinha.`
                });
            }

            const insert = await pg().query(
                `INSERT INTO sticker_listings
                    (seller_id, card_id, unit_price, quantity, status)
                 VALUES ($1,$2,$3,$4,'active')
                 RETURNING id`,
                [req.usuario.id, card.id, precoUnit, qtd]
            );
            const listingId = insert.rows[0].id;

            await registrarTransacaoCol(
                req.usuario.id,
                "ANUNCIO_CRIADO",
                `Colocou ${qtd}x #${String(card.number).padStart(3, "0")} ${card.name} à venda por R$ ${precoUnit.toFixed(2)}.`,
                0
            );

            registrarLog("colecionavel_listing_criado", {
                usuarioId: req.usuario.id,
                cardId: card.id,
                quantidade: qtd,
                preco: precoUnit
            });

            res.json({ ok: true, id: listingId });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Meus anúncios. */
    router.get("/listings/mine", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT l.id, l.unit_price, l.quantity, l.status, l.created_at,
                        c.number, c.name, c.rarity, c.image_url
                   FROM sticker_listings l
                   JOIN sticker_cards c ON c.id = l.card_id
                  WHERE l.seller_id = $1
                  ORDER BY l.created_at DESC`,
                [req.usuario.id]
            );
            res.json({
                ok: true,
                listings: q.rows.map(l => ({
                    id: l.id,
                    unit_price: Number(l.unit_price),
                    quantity: Number(l.quantity),
                    status: l.status,
                    created_at: l.created_at,
                    number: Number(l.number),
                    name: l.name,
                    rarity: l.rarity,
                    image_url: l.image_url
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Contexto e conversa de um anúncio (chat comprador <-> vendedor).
       Devolve dados da figurinha, preço, vendedor e o contador de
       mensagens não lidas para quem está abrindo a conversa. */
    async function contextoChatAnuncio(usuarioId, listingId, buyerId, marcarLido) {
        const listingQ = await pg().query(
            `SELECT l.id, l.seller_id, l.unit_price, l.quantity, l.status,
                    c.id AS card_id, c.number, c.name, c.rarity, c.image_url,
                    u.nome AS seller_nome
               FROM sticker_listings l
               JOIN sticker_cards c ON c.id = l.card_id
               JOIN usuarios u ON u.id = l.seller_id
              WHERE l.id = $1`,
            [Number(listingId)]
        );
        const listing = listingQ.rows[0];
        if (!listing) return { erro: 404, mensagem: "Anúncio não encontrado." };
        if (listing.status !== "active") return { erro: 410, mensagem: "Este anúncio já foi encerrado." };

        const ehVendedor = listing.seller_id === usuarioId;

        /* O vendedor precisa indicar QUAL interessado (comprador).
           Sem isso, devolve a lista de interessados em vez de erro. */
        if (ehVendedor && !buyerId) {
            const interessadosQ = await pg().query(
                `SELECT DISTINCT m.buyer_id, u.nome AS nome, u.nome AS buyer_nome
                   FROM sticker_listing_messages m
                   JOIN usuarios u ON u.id = m.buyer_id
                  WHERE m.listing_id = $1 AND m.seller_id = $2
                  ORDER BY u.nome ASC`,
                [listing.id, listing.seller_id]
            );
            const convsQ = await pg().query(
                `SELECT c.buyer_id, u.nome AS nome
                   FROM sticker_listing_conversations c
                   JOIN usuarios u ON u.id = c.buyer_id
                  WHERE c.listing_id = $1 AND c.seller_id = $2
                  ORDER BY c.updated_at DESC`,
                [listing.id, listing.seller_id]
            );
            const jaVistos = new Map();
            [...interessadosQ.rows, ...convsQ.rows].forEach(r => { if (r.buyer_id != null && !jaVistos.has(Number(r.buyer_id))) jaVistos.set(Number(r.buyer_id), r.nome); });
            return {
                contexto: {
                    listingId: listing.id, cardId: listing.card_id,
                    numero: listing.number, nome: listing.name, raridade: listing.rarity,
                    imagem: listing.image_url, preco: Number(listing.unit_price),
                    vendedorId: listing.seller_id, vendedorNome: listing.seller_nome,
                    ehVendedor: true
                },
                interessados: [...jaVistos.entries()].map(([id, nome]) => ({ id, nome }))
            };
        }

        const buyer = buyerId ? Number(buyerId) : usuarioId;
        if (!Number.isInteger(buyer) || buyer < 1 || buyer === listing.seller_id) {
            return { erro: 400, mensagem: "Interessado inválido." };
        }
        const permitido = listing.seller_id === usuarioId || buyer === usuarioId;
        if (!permitido) return { erro: 403, mensagem: "Acesso negado à conversa." };

        const convQ = await pg().query(
            `INSERT INTO sticker_listing_conversations (listing_id, seller_id, buyer_id)
             VALUES ($1,$2,$3)
             ON CONFLICT (listing_id, seller_id, buyer_id)
             DO UPDATE SET updated_at = NOW()
             RETURNING *`,
            [listing.id, listing.seller_id, buyer]
        );
        const conv = convQ.rows[0];

        const messagesQ = await pg().query(
            `SELECT m.id, m.author_id, u.nome AS autor_nome, m.text, m.created_at
               FROM sticker_listing_messages m JOIN usuarios u ON u.id = m.author_id
              WHERE m.listing_id = $1 AND m.seller_id = $2 AND m.buyer_id = $3
              ORDER BY m.created_at ASC`,
            [listing.id, listing.seller_id, buyer]
        );
        const minhaLeitura = ehVendedor ? conv.seller_read_at : conv.buyer_read_at;
        const naoLidas = messagesQ.rows.filter(m => m.author_id !== usuarioId && (!minhaLeitura || new Date(m.created_at) > new Date(minhaLeitura))).length;

        if (marcarLido) {
            await pg().query(
                ehVendedor
                    ? `UPDATE sticker_listing_conversations SET seller_read_at = NOW(), updated_at = NOW() WHERE id = $1`
                    : `UPDATE sticker_listing_conversations SET buyer_read_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [conv.id]
            );
        }

        /* Negociação relacionada, quando existir (oferta nesta figurinha
           entre vendedor e comprador). */
        const ofertaQ = await pg().query(
            `SELECT id, amount, quantity, status FROM sticker_offers
              WHERE card_id = $1
                AND ((offeror_id = $2 AND offeree_id = $3) OR (offeror_id = $3 AND offeree_id = $2))
              ORDER BY created_at DESC LIMIT 1`,
            [listing.card_id, listing.seller_id, buyer]
        );
        const oferta = ofertaQ.rows[0] || null;

        return {
            contexto: {
                listingId: listing.id, cardId: listing.card_id,
                numero: listing.number, nome: listing.name, raridade: listing.rarity,
                imagem: listing.image_url, preco: Number(listing.unit_price),
                quantidadeDisponivel: Number(listing.quantity),
                vendedorId: listing.seller_id, vendedorNome: listing.seller_nome,
                compradorId: buyer, ehVendedor
            },
            buyerId: buyer,
            sellerId: listing.seller_id,
            messages: messagesQ.rows,
            naoLidas,
            oferta: oferta
                ? { id: oferta.id, valor: Number(oferta.amount), quantidade: Number(oferta.quantity), status: oferta.status }
                : null
        };
    }

    router.get("/listings/:id/chat", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            const buyerId = Number(req.query.buyerId) || null;
            const r = await contextoChatAnuncio(req.usuario.id, req.params.id, buyerId, String(req.query.marcarLido) === "1");
            if (r.erro) return res.status(r.erro).json({ error: r.mensagem });
            res.json({ ok: true, ...r });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    router.post("/listings/:id/chat", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            const text = String(req.body.text || "").trim();
            if (!text || text.length > 500) return res.status(400).json({ error: "Mensagem inválida." });
            const listingQ = await pg().query(
                `SELECT id, seller_id FROM sticker_listings WHERE id = $1`,
                [Number(req.params.id)]
            );
            const listing = listingQ.rows[0];
            if (!listing) return res.status(404).json({ error: "Anúncio não encontrado." });
            const ehVendedor = listing.seller_id === req.usuario.id;
            const buyerId = ehVendedor ? Number(req.body.buyerId) : req.usuario.id;
            if (!Number.isInteger(buyerId) || buyerId < 1 || buyerId === listing.seller_id) return res.status(400).json({ error: "Informe o interessado da conversa." });
            if (!ehVendedor && buyerId !== req.usuario.id) return res.status(403).json({ error: "Acesso negado à conversa." });

            const convQ = await pg().query(
                `INSERT INTO sticker_listing_conversations (listing_id, seller_id, buyer_id)
                 VALUES ($1,$2,$3)
                 ON CONFLICT (listing_id, seller_id, buyer_id)
                 DO UPDATE SET updated_at = NOW()
                 RETURNING id`,
                [listing.id, listing.seller_id, buyerId]
            );
            await pg().query(
                `INSERT INTO sticker_listing_messages (listing_id, seller_id, buyer_id, author_id, text)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id, author_id, text, created_at`,
                [listing.id, listing.seller_id, buyerId, req.usuario.id, text]
            );
            const r = await contextoChatAnuncio(req.usuario.id, listing.id, buyerId, false);
            if (r.erro) return res.status(r.erro).json({ error: r.mensagem });
            res.status(201).json({ ok: true, ...r });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    /* Conversas do usuário (vendedor ou comprador). */
    router.get("/chat/conversas", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            const q = await pg().query(
                `SELECT c.listing_id, c.buyer_id, c.seller_id,
                        c.seller_read_at, c.buyer_read_at, c.updated_at,
                        l.card_id, l.unit_price, l.quantity, l.status AS listing_status,
                        c2.number, c2.name, c2.image_url,
                        u.nome AS comprador_nome, v.nome AS vendedor_nome
                   FROM sticker_listing_conversations c
                   JOIN sticker_listings l ON l.id = c.listing_id
                   JOIN sticker_cards c2 ON c2.id = l.card_id
                   JOIN usuarios u ON u.id = c.buyer_id
                   JOIN usuarios v ON v.id = c.seller_id
                  WHERE c.seller_id = $1 OR c.buyer_id = $1
                  ORDER BY c.updated_at DESC
                  LIMIT 50`,
                [req.usuario.id]
            );
            const conversas = [];
            for (const c of q.rows) {
                const souVendedor = c.seller_id === req.usuario.id;
                const minhaLeitura = souVendedor ? c.seller_read_at : c.buyer_read_at;
                const msgsQ = await pg().query(
                    `SELECT author_id, created_at FROM sticker_listing_messages
                      WHERE listing_id = $1 AND seller_id = $2 AND buyer_id = $3
                        AND author_id <> $4`,
                    [c.listing_id, c.seller_id, c.buyer_id, req.usuario.id]
                );
                const naoLidas = msgsQ.rows.filter(m =>
                    !minhaLeitura || new Date(m.created_at) > new Date(minhaLeitura)
                ).length;
                conversas.push({
                    listingId: c.listing_id,
                    buyerId: c.buyer_id,
                    sellerId: c.seller_id,
                    souVendedor,
                    compradorNome: c.comprador_nome,
                    vendedorNome: c.vendedor_nome,
                    cardId: c.card_id,
                    numero: Number(c.number),
                    nome: c.name,
                    imagem: c.image_url,
                    preco: Number(l.unit_price),
                    quantidade: Number(l.quantity),
                    listingStatus: c.listing_status,
                    atualizadoEm: c.updated_at,
                    naoLidas
                });
            }
            res.json({ ok: true, conversas });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    /* Cancela anúncio (devolve figurinhas à disponibilidade). */
    router.delete("/listings/:id", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_listings WHERE id = $1`,
                [req.params.id]
            );
            const listing = q.rows[0];
            if (!listing) {
                return res.status(404).json({ error: "Anúncio não encontrado." });
            }
            if (listing.seller_id !== req.usuario.id) {
                return res.status(403).json({ error: "Este anúncio não é seu." });
            }
            if (listing.status !== "active") {
                return res.status(400).json({ error: "Este anúncio não está ativo." });
            }

            await pg().query(
                `UPDATE sticker_listings SET status = 'cancelled'
                  WHERE id = $1`,
                [listing.id]
            );

            const card = await cardPorId(listing.card_id);
            await registrarTransacaoCol(
                req.usuario.id,
                "ANUNCIO_CANCELADO",
                `Cancelou o anúncio de ${listing.quantity}x ${card ? card.name : "figurinha"}.`,
                0
            );

            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Compra de um anúncio — cria pedido com pagamento. */
    router.post("/listings/:id/buy", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const validacao = validarComprador(req);
            if (!validacao.ok) {
                return res.status(400).json({ error: validacao.error });
            }
            const comprador = validacao.comprador;

            const q = await pg().query(
                `SELECT * FROM sticker_listings WHERE id = $1`,
                [req.params.id]
            );
            const listing = q.rows[0];
            if (!listing || listing.status !== "active") {
                return res.status(404).json({ error: "Anúncio não disponível." });
            }

            if (listing.seller_id === req.usuario.id) {
                return res.status(400).json({ error: "Você não pode comprar do próprio anúncio." });
            }

            const contaVendedor = await marketplaceConta(listing.seller_id);
            if (!contaVendedor && process.env.ALLOW_TEST_MODE !== "true") {
                return res.status(400).json({ error: "Este vendedor ainda não conectou o Mercado Pago." });
            }
            if ((!mercadopagoMarketplaceSplitEnabled || typeof criarOrderMercadoPagoSplit !== "function") && process.env.ALLOW_TEST_MODE !== "true") {
                return res.status(503).json({ error: "O pagamento deste anúncio ainda não está disponível porque o Marketplace não está configurado." });
            }

            /* Quantidade realmente vendável: o anúncio não pode vender
               unidade que esteja reservada por oferta/leilão/troca. */
            const livre = await quantidadeDisponivel(listing.seller_id, listing.card_id);
            const vendavel = Math.max(0, Math.min(Number(listing.quantity), livre + Number(listing.quantity)));
            if (vendavel < 1) {
                return res.status(409).json({ error: "Este anúncio está reservado para outro interessado no momento." });
            }
            const qtd = Math.max(1, Math.min(Number(req.body.quantidade) || 1, vendavel));

            const total = Math.round(listing.unit_price * qtd * 100) / 100;
            const { feeCents, netSellerCents } = calcularComissao(paraCentavos(total), mercadopagoMarketplaceFeePercent || MARKETPLACE_FEE_PERCENT);
            const fee = centavosParaReais(feeCents);
            const netSeller = centavosParaReais(netSellerCents);
            const splitUsado = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function" && !!contaVendedor;

            const usuario = await usuarioPorId(req.usuario.id);
            if (!usuario) {
                return res.status(401).json({ error: "Conta não encontrada." });
            }

            const orderId = gerarOrderId("COL-BUY");
            const paymentId = crypto.randomUUID();

            const criarOrder = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function"
                ? criarOrderMercadoPagoSplit : criarOrderMercadoPago;
            const mp = await criarOrder({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: total,
                sellerAccount: contaVendedor,
                platformFee: fee,
                description: `MegaOutdoor Colecionáveis — Compra no mercado`,
                customer: {
                    name: comprador.nome || usuario.nome,
                    taxID: comprador.documento,
                    email: comprador.email || usuario.email
                },
                paymentMethod: req.body.paymentMethod || "pix",
                paymentMethodId: req.body.paymentMethodId,
                cardToken: req.body.cardToken,
                installments: req.body.installments
            });

            await pg().query(
                `INSERT INTO sticker_orders
                    (buyer_id, seller_id, card_id, listing_id, quantity,
                      unit_price, total, fee, net_seller, order_id, mp_order_id, payment_id,
                      payment_type, status, test)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                         $13,'pending',$14)`,
                [req.usuario.id, listing.seller_id, listing.card_id, listing.id,
                 qtd, Number(listing.unit_price), total, fee, netSeller,
                 orderId, String(mp.orderId), paymentId, splitUsado ? "STICKER_MARKETPLACE_SPLIT" : "STICKER_PURCHASE", !!process.env.ALLOW_TEST_MODE]
            );

            await registrarTransacaoCol(
                req.usuario.id,
                "PEDIDO_MERCADO",
                `Pedido de compra no mercado (${qtd}x) criado.`,
                total,
                orderId
            );

            registrarLog("colecionavel_pedido_mercado", {
                usuarioId: req.usuario.id,
                listingId: listing.id,
                orderId
            });

            res.json({
                ok: true,
                orderId: String(mp.orderId),
                externalReference: orderId,
                qrCodeBase64: mp.qrCodeBase64,
                payload: mp.payload,
                ticketUrl: mp.ticketUrl,
                expiresDate: mp.expirationDate,
                paymentId: mp.paymentId,
                total,
                fee,
                netSeller
            });
        } catch (error) {
            registrarLog("colecionavel_mercado_erro", {
                erro: error.message,
                listingId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* =========================================================
       OFERTAS (FAZER OFERTA / NEGOCIAÇÃO)
       Estados: PENDENTE -> ACEITA/RECUSADA/CANCELADA/EXPIRADA
                ACEITA -> CONCLUIDA (após pagamento) ou CANCELADA
       Contraproposta cria uma nova oferta (parent_offer_id) e
       recusa a original.
    ========================================================= */

    router.get("/offers/mine", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            await expirarNegociacoesVencidas();
            const q = await pg().query(
                `SELECT o.id, o.offeror_id, o.offeree_id, o.card_id, o.quantity,
                        o.amount, o.message, o.status, o.parent_offer_id,
                        o.created_at, o.updated_at, o.responded_at, o.expires_at,
                        c.number AS card_number, c.name AS card_name, c.rarity AS card_rarity,
                        uo.nome AS offeror_nome, ue.nome AS offeree_nome
                   FROM sticker_offers o
                   JOIN sticker_cards c ON c.id = o.card_id
                   JOIN usuarios uo ON uo.id = o.offeror_id
                   JOIN usuarios ue ON ue.id = o.offeree_id
                  WHERE o.offeror_id = $1 OR o.offeree_id = $1
                  ORDER BY o.created_at DESC
                  LIMIT 200`,
                [req.usuario.id]
            );
            const rows = q.rows;
            res.json({
                ok: true,
                recebidas: rows.filter(o => o.offeree_id === req.usuario.id),
                enviadas: rows.filter(o => o.offeror_id === req.usuario.id)
            });
        } catch (error) {
            registrarLog("colecionavel_ofertas_lista_erro", { erro: error.message, usuarioId: req.usuario.id });
            res.status(500).json({ error: "Não foi possível carregar as ofertas." });
        }
    });

    router.post("/offers", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            await expirarNegociacoesVencidas();
            const cardId = Number(req.body.cardId);
            const offereeId = Number(req.body.offereeId);
            const quantidade = Math.max(1, Math.floor(Number(req.body.quantidade) || 1));
            const amount = Math.round(Number(req.body.valor ?? req.body.amount) * 100) / 100;
            const mensagem = String(req.body.mensagem ?? req.body.message ?? "").slice(0, 500);

            if (!Number.isInteger(cardId) || cardId < 1) return res.status(400).json({ error: "Figurinha inválida." });
            if (!Number.isInteger(offereeId) || offereeId < 1) return res.status(400).json({ error: "Colecionador inválido." });
            if (offereeId === req.usuario.id) return res.status(400).json({ error: "Você não pode fazer oferta para si mesmo." });
            if (!isFinite(amount) || amount <= 0 || amount > 99999) return res.status(400).json({ error: "Valor da oferta inválido." });
            if (quantidade < 1 || quantidade > 99) return res.status(400).json({ error: "Quantidade inválida." });

            const card = await cardPorId(cardId);
            if (!card || !card.is_active) return res.status(400).json({ error: "Figurinha inválida." });

            const offeree = await usuarioPorId(offereeId);
            if (!offeree) return res.status(404).json({ error: "Colecionador não encontrado." });

            /* Regra central de elegibilidade. */
            const bloqueioOferta = await verificarElegibilidade(req.usuario.id, offereeId);
            if (bloqueioOferta.bloqueado) return res.status(403).json({ error: bloqueioOferta.motivo });

            const dupQ = await pg().query(
                `SELECT id FROM sticker_offers
                  WHERE offeror_id = $1 AND offeree_id = $2 AND card_id = $3
                    AND status = 'PENDENTE' LIMIT 1`,
                [req.usuario.id, offereeId, cardId]
            );
            if (dupQ.rows[0]) {
                return res.status(400).json({ error: "Você já tem uma oferta pendente para esta figurinha." });
            }

            const q = await pg().query(
                `INSERT INTO sticker_offers
                    (offeror_id, offeree_id, card_id, quantity, amount, message, status, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'PENDENTE', NOW() + INTERVAL '7 days')
                 RETURNING *`,
                [req.usuario.id, offereeId, cardId, quantidade, amount, mensagem]
            );
            const offer = q.rows[0];
            const cardLabel = `#${String(card.number).padStart(3, "0")} ${card.name}`;
            await registrarTransacaoCol(
                req.usuario.id,
                "OFERTA_ENVIADA",
                `Você ofertou R$ ${amount.toFixed(2)} por ${quantidade}x ${cardLabel}.`,
                0,
                String(offer.id)
            );
            registrarLog("colecionavel_oferta_criada", {
                ofertaId: offer.id, offerorId: req.usuario.id, offereeId, cardId, valor: amount
            });
            
            // Notificar o destinatário sobre a nova oferta
            if (typeof criarNotificacao === "function") {
                await criarNotificacao(
                    offereeId,
                    "oferta_recebida",
                    "Nova oferta recebida",
                    `Você recebeu uma oferta de R$ ${amount.toFixed(2)} pela figurinha ${cardLabel}.`,
                    { offerId: offer.id, cardId, offerorId: req.usuario.id }
                );
            }
            
            res.status(201).json({ ok: true, oferta: offer });
        } catch (error) {
            registrarLog("colecionavel_oferta_criar_erro", { erro: error.message, usuarioId: req.usuario && req.usuario.id });
            res.status(500).json({ error: "Não foi possível enviar a oferta." });
        }
    });

    router.post("/offers/:id/accept", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const offerId = Number(req.params.id);
        if (!Number.isInteger(offerId) || offerId < 1) return res.status(400).json({ error: "Oferta inválida." });
        const oq = await pg().query(`SELECT * FROM sticker_offers WHERE id = $1`, [offerId]);
        const offer = oq.rows[0];
        if (!offer) return res.status(404).json({ error: "Oferta não encontrada." });
        if (offer.offeree_id !== req.usuario.id) return res.status(403).json({ error: "Somente quem recebeu a oferta pode aceitá-la." });
        if (offer.status !== "PENDENTE") return res.status(400).json({ error: "Esta oferta não está mais pendente." });

        /* Regra central de status: vendedor (offeree) deve poder negociar. */
        const bloqueioVendedor = await verificarElegibilidade(offer.offeree_id);
        if (bloqueioVendedor.bloqueado) return res.status(403).json({ error: bloqueioVendedor.motivo });

        /* Ofertante (offeror) também deve poder negociar. */
        const bloqueioOfertante = await verificarElegibilidade(offer.offeror_id);
        if (bloqueioOfertante.bloqueado) return res.status(403).json({ error: "O ofertante não pode mais participar de negociações." });

        const contaVendedor = await marketplaceConta(req.usuario.id);
        const splitHabilitado = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function";
        if (process.env.ALLOW_TEST_MODE !== "true") {
            if (!contaVendedor) {
                return res.status(400).json({ error: "Sua conta do Mercado Pago não está conectada. Conecte sua conta para receber pagamentos." });
            }
            if (!splitHabilitado) {
                return res.status(503).json({ error: "O sistema de split do Marketplace está temporariamente indisponível. Tente novamente mais tarde." });
            }
        }

        const client = await pg().connect();
        try {
            await client.query("BEGIN");
            /* Serializa aceites concorrentes para a mesma figurinha+vendedor:
               trava a linha de user_stickers do vendedor (row lock). */
            await client.query(
                `SELECT id FROM user_stickers WHERE usuario_id = $1 AND card_id = $2 FOR UPDATE`,
                [offer.offeree_id, offer.card_id]
            );

            const oq2 = await client.query(`SELECT * FROM sticker_offers WHERE id = $1 FOR UPDATE`, [offerId]);
            const of2 = oq2.rows[0];
            if (!of2 || of2.status !== "PENDENTE") {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Esta oferta não está mais pendente." });
            }

            const disp = await quantidadeDisponivel(req.usuario.id, of2.card_id);
            if (disp < Number(of2.quantity)) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Você não tem quantidade suficiente desta figurinha para aceitar a oferta." });
            }

            await client.query(
                `UPDATE sticker_offers
                    SET status = 'ACEITA', responded_at = NOW(), updated_at = NOW()
                  WHERE id = $1`,
                [of2.id]
            );
            await client.query(
                `INSERT INTO sticker_offer_reservations (offer_id, card_id, owner_id, quantity, status)
                 VALUES ($1,$2,$3,$4,'ATIVA')`,
                [of2.id, of2.card_id, of2.offeree_id, of2.quantity]
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            registrarLog("colecionavel_oferta_aceitar_erro", { erro: error.message, ofertaId: offerId });
            console.error("[OFERTA] erro ao aceitar:", error.message);
            return res.status(500).json({ error: "Não foi possível aceitar a oferta." });
        } finally {
            client.release();
        }

        // Notificar o ofertante que a oferta foi aceita
        if (typeof criarNotificacao === "function") {
            const card = await cardPorId(offer.card_id);
            const cardLabel = card ? `#${String(card.number).padStart(3, "0")} ${card.name}` : "figurinha";
            await criarNotificacao(
                offer.offeror_id,
                "oferta_aceita",
                "Oferta aceita!",
                `Sua oferta por ${cardLabel} foi aceita. Agora você pode prosseguir para o pagamento.`,
                { offerId: offer.id, cardId: offer.card_id }
            );
        }

        res.json({ ok: true, ofertaId: offerId, mensagem: "Oferta aceita! O comprador agora pode prosseguir para o pagamento." });
    });

    router.post("/offers/:id/decline", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            const offerId = Number(req.params.id);
            const oq = await pg().query(`SELECT * FROM sticker_offers WHERE id = $1`, [offerId]);
            const offer = oq.rows[0];
            if (!offer) return res.status(404).json({ error: "Oferta não encontrada." });
            if (offer.offeree_id !== req.usuario.id) return res.status(403).json({ error: "Somente quem recebeu a oferta pode recusá-la." });
            if (offer.status !== "PENDENTE") return res.status(400).json({ error: "Esta oferta não está mais pendente." });
            await pg().query(
                `UPDATE sticker_offers SET status = 'RECUSADA', responded_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [offerId]
            );
            
            // Notificar o ofertante que a oferta foi recusada
            if (typeof criarNotificacao === "function") {
                const card = await cardPorId(offer.card_id);
                const cardLabel = card ? `#${String(card.number).padStart(3, "0")} ${card.name}` : "figurinha";
                await criarNotificacao(
                    offer.offeror_id,
                    "oferta_recusada",
                    "Oferta recusada",
                    `Sua oferta por ${cardLabel} foi recusada.`,
                    { offerId: offer.id, cardId: offer.card_id }
                );
            }
            
            res.json({ ok: true, ofertaId: offerId, mensagem: "Oferta recusada." });
        } catch (error) {
            registrarLog("colecionavel_oferta_recusar_erro", { erro: error.message, ofertaId: req.params.id });
            console.error("[OFERTA] erro ao recusar:", error.message);
            res.status(500).json({ error: "Não foi possível recusar a oferta." });
        }
    });

    router.post("/offers/:id/cancel", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const client = await pg().connect();
        try {
            const offerId = Number(req.params.id);
            await client.query("BEGIN");
            const oq = await client.query(`SELECT * FROM sticker_offers WHERE id = $1 FOR UPDATE`, [offerId]);
            const offer = oq.rows[0];
            if (!offer) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Oferta não encontrada." });
            }
            const ehEnvolvido = offer.offeror_id === req.usuario.id || offer.offeree_id === req.usuario.id;
            if (!ehEnvolvido) {
                await client.query("ROLLBACK");
                return res.status(403).json({ error: "Somente os envolvidos podem cancelar a oferta." });
            }
            if (offer.status === "PENDENTE") {
                await client.query(
                    `UPDATE sticker_offers SET status = 'CANCELADA', updated_at = NOW() WHERE id = $1`,
                    [offerId]
                );
            } else if (offer.status === "ACEITA") {
                if (offer.offeror_id !== req.usuario.id) {
                    await client.query("ROLLBACK");
                    return res.status(403).json({ error: "Somente quem ofertou pode cancelar uma oferta aceita." });
                }
                await client.query(
                    `UPDATE sticker_offers SET status = 'CANCELADA', updated_at = NOW() WHERE id = $1`,
                    [offerId]
                );
                await client.query(
                    `UPDATE sticker_offer_reservations SET status = 'LIBERADA' WHERE offer_id = $1 AND status = 'ATIVA'`,
                    [offerId]
                );
            } else {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Esta oferta não pode mais ser cancelada." });
            }
            await client.query("COMMIT");
            
            // Notificar a outra parte sobre o cancelamento
            if (typeof criarNotificacao === "function") {
                const outraParte = offer.offeror_id === req.usuario.id ? offer.offeree_id : offer.offeror_id;
                const card = await cardPorId(offer.card_id);
                const cardLabel = card ? `#${String(card.number).padStart(3, "0")} ${card.name}` : "figurinha";
                await criarNotificacao(
                    outraParte,
                    "oferta_cancelada",
                    "Oferta cancelada",
                    `A oferta por ${cardLabel} foi cancelada.`,
                    { offerId: offer.id, cardId: offer.card_id }
                );
            }
            
            res.json({ ok: true, ofertaId: offerId, mensagem: "Oferta cancelada." });
        } catch (error) {
            await client.query("ROLLBACK");
            registrarLog("colecionavel_oferta_cancelar_erro", { erro: error.message, ofertaId: req.params.id });
            console.error("[OFERTA] erro ao cancelar:", error.message);
            res.status(500).json({ error: "Não foi possível cancelar a oferta." });
        } finally {
            client.release();
        }
    });

    router.post("/offers/:id/counter", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        try {
            const offerId = Number(req.params.id);
            const amount = Math.round(Number(req.body.valor ?? req.body.amount) * 100) / 100;
            const quantidade = Math.max(1, Math.floor(Number(req.body.quantidade) || 1));
            const mensagem = String(req.body.mensagem ?? req.body.message ?? "").slice(0, 500);

            const oq = await pg().query(`SELECT * FROM sticker_offers WHERE id = $1`, [offerId]);
            const original = oq.rows[0];
            if (!original) return res.status(404).json({ error: "Oferta não encontrada." });
            if (original.offeree_id !== req.usuario.id) return res.status(403).json({ error: "Somente quem recebeu a oferta pode contrapor." });
            if (original.status !== "PENDENTE") return res.status(400).json({ error: "A oferta original não está mais pendente." });
            if (!isFinite(amount) || amount <= 0 || amount > 99999) return res.status(400).json({ error: "Valor da contraproposta inválido." });
            if (quantidade < 1 || quantidade > 99) return res.status(400).json({ error: "Quantidade inválida." });

            /* Regra central de status: ambos os usuários devem poder negociar. */
            const bloqueioCounter = await verificarElegibilidade(req.usuario.id);
            if (bloqueioCounter.bloqueado) return res.status(403).json({ error: bloqueioCounter.motivo });
            const bloqueioOriginalOfferor = await verificarElegibilidade(original.offeror_id);
            if (bloqueioOriginalOfferor.bloqueado) return res.status(403).json({ error: "O ofertante original não pode mais participar de negociações." });

            const card = await cardPorId(original.card_id);
            if (!card || !card.is_active) return res.status(400).json({ error: "Figurinha inválida." });

            const q = await pg().query(
                `INSERT INTO sticker_offers
                    (offeror_id, offeree_id, card_id, quantity, amount, message,
                     status, parent_offer_id, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'PENDENTE',$7, NOW() + INTERVAL '7 days')
                 RETURNING *`,
                [req.usuario.id, original.offeror_id, original.card_id, quantidade, amount, mensagem, original.id]
            );
            await pg().query(
                `UPDATE sticker_offers SET status = 'CONTRAPROPOSTA', responded_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [original.id]
            );
            const nova = q.rows[0];
            const cardLabel = `#${String(card.number).padStart(3, "0")} ${card.name}`;
            await registrarTransacaoCol(
                req.usuario.id,
                "CONTRAPROPOSTA",
                `Contraproposta de R$ ${amount.toFixed(2)} por ${quantidade}x ${cardLabel}.`,
                0,
                String(nova.id)
            );
            registrarLog("colecionavel_contraproposta", { ofertaId: nova.id, originalId: original.id });
            res.status(201).json({ ok: true, oferta: nova });
        } catch (error) {
            registrarLog("colecionavel_oferta_contrapor_erro", { erro: error.message, ofertaId: req.params.id });
            res.status(500).json({ error: "Não foi possível enviar a contraproposta." });
        }
    });

    router.post("/offers/:id/pay", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const validacao = validarComprador(req);
        if (!validacao.ok) return res.status(400).json({ error: validacao.error });
        const comprador = validacao.comprador;

        const offerId = Number(req.params.id);
        const oq = await pg().query(`SELECT * FROM sticker_offers WHERE id = $1`, [offerId]);
        const offer = oq.rows[0];
        if (!offer) return res.status(404).json({ error: "Oferta não encontrada." });
        if (offer.offeror_id !== req.usuario.id) return res.status(403).json({ error: "Somente quem ofertou pode pagar esta oferta." });
        if (offer.status !== "ACEITA" && offer.status !== "AGUARDANDO_PAGAMENTO") return res.status(400).json({ error: "Esta oferta não está aceita para pagamento." });

        const contaVendedor = await marketplaceConta(offer.offeree_id);
        if (!contaVendedor && process.env.ALLOW_TEST_MODE !== "true") {
            return res.status(400).json({ error: "Este vendedor ainda não conectou o Mercado Pago." });
        }
        if ((!mercadopagoMarketplaceSplitEnabled || typeof criarOrderMercadoPagoSplit !== "function") && process.env.ALLOW_TEST_MODE !== "true") {
            return res.status(503).json({ error: "O pagamento desta oferta ainda não está disponível porque o Marketplace não está configurado." });
        }

        try {
            const usuario = await usuarioPorId(req.usuario.id);
            if (!usuario) return res.status(401).json({ error: "Conta não encontrada." });

            const total = Math.round(Number(offer.amount) * 100) / 100;
            const { feeCents, netSellerCents } = calcularComissao(paraCentavos(total), mercadopagoMarketplaceFeePercent);
            const fee = centavosParaReais(feeCents);
            const netSeller = centavosParaReais(netSellerCents);
            const splitUsado = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function" && !!contaVendedor;

            const orderId = gerarOrderId("COL-OFFER");
            const paymentId = crypto.randomUUID();

            const criarOrder = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function"
                ? criarOrderMercadoPagoSplit : criarOrderMercadoPago;
            const mp = await criarOrder({
                idempotencyKey: orderId,
                externalReference: orderId,
                value: total,
                sellerAccount: contaVendedor,
                platformFee: fee,
                description: `MegaOutdoor Colecionáveis — Oferta aceita`,
                customer: {
                    name: comprador.nome || usuario.nome,
                    taxID: comprador.documento,
                    email: comprador.email || usuario.email
                },
                paymentMethod: req.body.paymentMethod || "pix",
                paymentMethodId: req.body.paymentMethodId,
                cardToken: req.body.cardToken,
                installments: req.body.installments
            });

            await pg().query(
                `INSERT INTO sticker_orders
                    (buyer_id, seller_id, card_id, listing_id, quantity,
                      unit_price, total, fee, net_seller, order_id, mp_order_id, payment_id,
                      payment_type, status, test, offer_id)
                 VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,
                         $12,'pending',$13,$14)`,
                [req.usuario.id, offer.offeree_id, offer.card_id,
                 offer.quantity, total, total, fee, netSeller,
                 orderId, String(mp.orderId), paymentId, splitUsado ? "STICKER_MARKETPLACE_SPLIT" : "STICKER_PURCHASE",
                 !!process.env.ALLOW_TEST_MODE, offer.id]
            );

            await registrarTransacaoCol(
                req.usuario.id,
                "PEDIDO_OFERTA",
                `Pagamento da oferta aceita (${offer.quantity}x) criado.`,
                total,
                orderId
            );

            /* Estado AGUARDANDO_PAGAMENTO: o comprador iniciou o
               pagamento; a oferta só vira CONCLUIDA após a
               confirmação real do Mercado Pago (webhook/polling). */
            await pg().query(
                `UPDATE sticker_offers
                    SET status = 'AGUARDANDO_PAGAMENTO', updated_at = NOW()
                  WHERE id = $1`,
                [offer.id]
            );
            registrarLog("colecionavel_oferta_pedido", { ofertaId: offer.id, orderId, usuarioId: req.usuario.id });

            res.json({
                ok: true,
                orderId: String(mp.orderId),
                externalReference: orderId,
                qrCodeBase64: mp.qrCodeBase64,
                payload: mp.payload,
                ticketUrl: mp.ticketUrl,
                expiresDate: mp.expirationDate,
                paymentId: mp.paymentId,
                total,
                fee,
                netSeller
            });
        } catch (error) {
            registrarLog("colecionavel_oferta_pay_erro", {
                erro: error.message,
                ofertaId: offer.id,
                usuarioId: req.usuario && req.usuario.id
            });
            console.error("[OFERTA] erro ao pagar:", error.message);
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    router.post("/auctions/:id/pay", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const validacao = validarComprador(req);
        if (!validacao.ok) return res.status(400).json({ error: validacao.error });
        try {
            const q = await pg().query(
                `SELECT a.*, u.nome AS seller_nome
                   FROM sticker_auctions a JOIN usuarios u ON u.id = a.seller_id
                  WHERE a.id = $1 AND a.status = 'payment_pending'`,
                [Number(req.params.id)]
            );
            const auction = q.rows[0];
            if (!auction || auction.winner_id !== req.usuario.id) return res.status(403).json({ error: "Somente o vencedor pode pagar este leilão." });
            const contaVendedor = await marketplaceConta(auction.seller_id);
            const splitDisponivel = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function";
            if ((!contaVendedor || !splitDisponivel) && process.env.ALLOW_TEST_MODE !== "true") {
                return res.status(503).json({ error: "O pagamento deste leilão ainda não está disponível. O vendedor precisa conectar o Mercado Pago." });
            }
            const orderId = gerarOrderId("COL-AUCTION");
            const total = Number(auction.current_bid);
            const { feeCents } = calcularComissao(paraCentavos(total), mercadopagoMarketplaceFeePercent);
            const criarOrder = splitDisponivel ? criarOrderMercadoPagoSplit : criarOrderMercadoPago;
            const mp = await criarOrder({
                idempotencyKey: orderId, externalReference: orderId, value: total,
                sellerAccount: contaVendedor,
                platformFee: centavosParaReais(feeCents),
                description: "Milhão Door Colecionáveis — Leilão",
                customer: { name: validacao.comprador.nome || req.usuario.nome, taxID: validacao.comprador.documento, email: validacao.comprador.email || req.usuario.email },
                paymentMethod: req.body.paymentMethod || "pix",
                paymentMethodId: req.body.paymentMethodId,
                cardToken: req.body.cardToken,
                installments: req.body.installments
            });
            await pg().query(
                `INSERT INTO sticker_auction_orders (auction_id, buyer_id, order_id, mp_order_id, payment_id, total, fee, seller_amount)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [auction.id, req.usuario.id, orderId, String(mp.orderId), mp.paymentId || null, total, Math.round(total * 0.1 * 100) / 100, Math.round(total * 0.9 * 100) / 100]
            );
            res.json({ ok: true, orderId: String(mp.orderId), externalReference: orderId, qrCodeBase64: mp.qrCodeBase64, payload: mp.payload, ticketUrl: mp.ticketUrl, valor: total });
        } catch (error) { res.status(500).json({ error: formatarErroPagamento(error) }); }
    });

    /* =========================================================
       NEGOCIAÇÕES (TROCAS)
       ========================================================= */

    async function validarItemsTroca(items) {
        if (!Array.isArray(items) || !items.length) {
            return { error: "Selecione pelo menos uma figurinha." };
        }
        const norm = [];
        const vistos = new Set();
        for (const item of items) {
            const cardId = Number(item?.cardId);
            if (!Number.isInteger(cardId) || cardId < 1) {
                return { error: "Figurinha inválida na proposta." };
            }
            if (vistos.has(cardId)) continue;
            vistos.add(cardId);
            norm.push({ cardId });
        }
        return { items: norm };
    }

    /* Cria proposta de troca. */
    router.post("/trades", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();

            const receiverId = Number(req.body.receiverId);
            if (!Number.isInteger(receiverId) || receiverId === req.usuario.id) {
                return res.status(400).json({ error: "Destinatário inválido." });
            }
            const receptor = await usuarioPorId(receiverId);
            if (!receptor) {
                return res.status(404).json({ error: "Usuário não encontrado." });
            }

            /* Regra central de status: ambos os usuários devem poder negociar. */
            const bloqueioProposer = await verificarElegibilidade(req.usuario.id);
            if (bloqueioProposer.bloqueado) return res.status(403).json({ error: bloqueioProposer.motivo });
            const bloqueioReceiver = await verificarElegibilidade(receiverId);
            if (bloqueioReceiver.bloqueado) return res.status(403).json({ error: "Este usuário não pode participar de trocas no momento." });

            const minhas = await validarItemsTroca(req.body.ofereco);
            if (minhas.error) return res.status(400).json({ error: minhas.error });
            const delas = await validarItemsTroca(req.body.recebo);
            if (delas.error) return res.status(400).json({ error: delas.error });

            let cashAmount = Math.max(0, Number(req.body.cashAmount) || 0);
            if (cashAmount > 0) {
                cashAmount = Math.round(cashAmount * 100) / 100;
                if (cashAmount > 5000) {
                    return res.status(400).json({ error: "Valor da diferença muito alto." });
                }
            }
            const cashDirection = req.body.cashDirection || null;
            if (cashAmount > 0 && cashDirection !== "proposer_pays" && cashDirection !== "receiver_pays") {
                return res.status(400).json({ error: "Defina quem paga a diferença." });
            }

            /* Valida propriedade e disponibilidade (race-safe via lock) */
            for (const item of minhas.items) {
                const possuo = await quantidadeDisponivel(req.usuario.id, item.cardId);
                if (possuo < 1) {
                    return res.status(400).json({ error: "Uma figurinha que você oferece não está disponível." });
                }
                const card = await cardPorId(item.cardId);
                if (!card) return res.status(400).json({ error: "Figurinha inválida." });
            }

            /* O destinatário precisa possuir as figurinhas pedidas */
            for (const item of delas.items) {
                const possuo = await quantidadePossuida(receiverId, item.cardId);
                if (possuo < 1) {
                    return res.status(400).json({ error: "O destinatário não possui uma das figurinhas pedidas." });
                }
            }

            const expiresAt = new Date(Date.now() + TRADE_TTL_HORAS * 3600 * 1000);

            const tQ = await pg().query(
                `INSERT INTO sticker_trades
                    (proposer_id, receiver_id, status, cash_direction,
                     cash_amount, order_id, payment_type, expires_at)
                 VALUES ($1,$2,'PENDING',$3,$4,$5,'STICKER_TRADE',$6)
                 RETURNING id`,
                [req.usuario.id, receiverId, cashDirection,
                 cashAmount, cashAmount > 0 ? gerarOrderId("COL-TRADE") : null,
                 expiresAt]
            );
            const tradeId = tQ.rows[0].id;

            for (const item of minhas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'proposer')`,
                    [tradeId, req.usuario.id, item.cardId]
                );
            }
            for (const item of delas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'receiver')`,
                    [tradeId, receiverId, item.cardId]
                );
            }

            const hist = `[CRIADA] Proposta de troca criada por ${req.usuario.nome}.`;
            await pg().query(
                `UPDATE sticker_trades SET history = $2 WHERE id = $1`,
                [tradeId, hist]
            );

            await registrarTransacaoDupla(
                req.usuario.id,
                receiverId,
                "TROCA_PROPOSTA",
                `Proposta de troca ${cashAmount > 0 ? "com diferença de R$ " + cashAmount.toFixed(2) : "simples"} criada.`,
                cashAmount
            );

            registrarLog("colecionavel_troca_criada", {
                tradeId,
                proposer: req.usuario.id,
                receiver: receiverId,
                comDinheiro: cashAmount > 0
            });

            res.json({ ok: true, tradeId });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Lista negociações em que o usuário participa. */
    router.get("/trades/mine", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const q = await pg().query(
                `SELECT t.*, pu.nome AS proposer_nome, ru.nome AS receiver_nome
                   FROM sticker_trades t
                   JOIN usuarios pu ON pu.id = t.proposer_id
                   JOIN usuarios ru ON ru.id = t.receiver_id
                  WHERE t.proposer_id = $1 OR t.receiver_id = $1
                  ORDER BY t.updated_at DESC
                  LIMIT 100`,
                [req.usuario.id]
            );

            /* Itens e mensagens de cada negociação (para o card completo). */
            const trades = [];
            for (const t of q.rows) {
                const itemsQ = await pg().query(
                    `SELECT ti.owner_id, ti.card_id, c.number, c.name, c.rarity
                       FROM sticker_trade_items ti
                       JOIN sticker_cards c ON c.id = ti.card_id
                      WHERE ti.trade_id = $1`,
                    [t.id]
                );
                const msgsQ = await pg().query(
                    `SELECT m.id, m.usuario_id, m.text, m.created_at, u.nome AS autor_nome
                       FROM sticker_trade_messages m
                       JOIN usuarios u ON u.id = m.usuario_id
                      WHERE m.trade_id = $1
                      ORDER BY m.created_at ASC`,
                    [t.id]
                );
                trades.push({
                    id: t.id,
                    proposer_id: t.proposer_id,
                    proposer_nome: t.proposer_nome,
                    receiver_id: t.receiver_id,
                    receiver_nome: t.receiver_nome,
                    status: t.status,
                    cash_direction: t.cash_direction,
                    cash_amount: Number(t.cash_amount),
                    created_at: t.created_at,
                    updated_at: t.updated_at,
                    expires_at: t.expires_at,
                    history: t.history || "",
                    items: itemsQ.rows,
                    messages: msgsQ.rows
                });
            }

            res.json({
                ok: true,
                trades
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Detalhe de uma negociação (itens + histórico + chat). */
    router.get("/trades/:id", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const q = await pg().query(
                `SELECT t.*, pu.nome AS proposer_nome, ru.nome AS receiver_nome
                   FROM sticker_trades t
                   JOIN usuarios pu ON pu.id = t.proposer_id
                   JOIN usuarios ru ON ru.id = t.receiver_id
                  WHERE t.id = $1`,
                [req.params.id]
            );
            const trade = q.rows[0];
            if (!trade) {
                return res.status(404).json({ error: "Negociação não encontrada." });
            }
            if (trade.proposer_id !== req.usuario.id && trade.receiver_id !== req.usuario.id) {
                return res.status(403).json({ error: "Acesso negado a esta negociação." });
            }

            const itemsQ = await pg().query(
                `SELECT ti.id, ti.owner_id, ti.card_id, ti.side,
                        c.number, c.name, c.rarity, c.image_url
                   FROM sticker_trade_items ti
                   JOIN sticker_cards c ON c.id = ti.card_id
                  WHERE ti.trade_id = $1`,
                [trade.id]
            );

            const msgsQ = await pg().query(
                `SELECT m.id, m.usuario_id, m.text, m.created_at, u.nome
                   FROM sticker_trade_messages m
                   JOIN usuarios u ON u.id = m.usuario_id
                  WHERE m.trade_id = $1
                  ORDER BY m.created_at ASC`,
                [trade.id]
            );

            res.json({
                ok: true,
                trade: {
                    id: trade.id,
                    proposer_id: trade.proposer_id,
                    proposer_nome: trade.proposer_nome,
                    receiver_id: trade.receiver_id,
                    receiver_nome: trade.receiver_nome,
                    status: trade.status,
                    cash_direction: trade.cash_direction,
                    cash_amount: Number(trade.cash_amount),
                    order_id: trade.order_id,
                    created_at: trade.created_at,
                    updated_at: trade.updated_at,
                    expires_at: trade.expires_at,
                    history: trade.history || "",
                    euSouProposer: trade.proposer_id === req.usuario.id,
                    items: itemsQ.rows,
                    messages: msgsQ.rows
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Chat da negociação. */
    router.post("/trades/:id/messages", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_trades WHERE id = $1`,
                [req.params.id]
            );
            const trade = q.rows[0];
            if (!trade) {
                return res.status(404).json({ error: "Negociação não encontrada." });
            }
            if (trade.proposer_id !== req.usuario.id && trade.receiver_id !== req.usuario.id) {
                return res.status(403).json({ error: "Acesso negado." });
            }

            const texto = String(req.body.text || "").trim();
            if (!texto || texto.length > 500) {
                return res.status(400).json({ error: "Mensagem inválida." });
            }

            const mQ = await pg().query(
                `INSERT INTO sticker_trade_messages (trade_id, usuario_id, text)
                 VALUES ($1,$2,$3)
                 RETURNING id, usuario_id, text, created_at`,
                [trade.id, req.usuario.id, texto]
            );

            res.json({ ok: true, message: mQ.rows[0] });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    async function podeAtualizarTrade(tradeId, usuarioId, roles) {
        const q = await pg().query(
            `SELECT * FROM sticker_trades WHERE id = $1`,
            [tradeId]
        );
        const trade = q.rows[0];
        if (!trade) return { trade: null };
        const ehProposer = trade.proposer_id === usuarioId;
        const ehReceiver = trade.receiver_id === usuarioId;
        const ok = (roles.proposer && ehProposer) || (roles.receiver && ehReceiver);
        return { trade, ok };
    }

    async function registrarHistoricoTrade(tradeId, linha) {
        await pg().query(
            `UPDATE sticker_trades
                SET history = COALESCE(history,'') || E'\n' || $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [tradeId, linha]
        );
    }

    /* Aceitar proposta. Se houver diferença em dinheiro, cria
       cobrança e aguarda pagamento (WAITING_PAYMENT). Caso contrário,
       executa a troca imediatamente. */
    router.post("/trades/:id/accept", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();

            const { trade } = await podeAtualizarTrade(
                req.params.id, req.usuario.id, { proposer: true, receiver: true }
            );

            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            const podeAceitar = trade.status === "COUNTER_OFFER"
                ? trade.proposer_id === req.usuario.id
                : trade.receiver_id === req.usuario.id;
            if (!podeAceitar) return res.status(403).json({ error: "Este usuário não pode aceitar a etapa atual." });

            if (trade.status !== "PENDING" && trade.status !== "COUNTER_OFFER") {
                return res.status(400).json({ error: "Esta proposta não pode mais ser aceita." });
            }
            if (new Date(trade.expires_at) < new Date()) {
                return res.status(400).json({ error: "Esta proposta expirou." });
            }

            /* Revalida disponibilidade das figurinhas antes de aceitar.
               A própria troca ainda está PENDING — exclui-a do bloqueio. */
            const itemsQ = await pg().query(
                `SELECT * FROM sticker_trade_items WHERE trade_id = $1`,
                [trade.id]
            );
            for (const item of itemsQ.rows) {
                const disp = await quantidadeDisponivel(item.owner_id, item.card_id, trade.id);
                if (disp < 1) {
                    return res.status(400).json({
                        error: "Uma das figurinhas não está mais disponível."
                    });
                }
            }

            if (Number(trade.cash_amount) > 0) {
                const validacao = validarComprador(req);
                if (!validacao.ok) {
                    return res.status(400).json({ error: validacao.error });
                }
                const comprador = validacao.comprador;

                /* Cobrança da diferença. Quem paga = cash_direction */
                const paganteId = trade.cash_direction === "proposer_pays"
                    ? trade.proposer_id : trade.receiver_id;

                const pagante = await usuarioPorId(paganteId);
                const orderId = trade.order_id || gerarOrderId("COL-TRADE-PAY");
                const sellerId = trade.cash_direction === "proposer_pays" ? trade.receiver_id : trade.proposer_id;
                const sellerAccount = await marketplaceConta(sellerId);
                const splitUsado = mercadopagoMarketplaceSplitEnabled && typeof criarOrderMercadoPagoSplit === "function" && !!sellerAccount;
                if (!splitUsado && process.env.ALLOW_TEST_MODE !== "true") {
                    return res.status(503).json({ error: "O split oficial do marketplace ainda não está disponível para esta negociação." });
                }

                const criarOrder = splitUsado ? criarOrderMercadoPagoSplit : criarOrderMercadoPago;
                const mp = await criarOrder({
                    idempotencyKey: orderId,
                    externalReference: orderId,
                    value: Number(trade.cash_amount),
                    sellerAccount: sellerAccount,
                    platformFee: centavosParaReais(calcularComissao(paraCentavos(trade.cash_amount), mercadopagoMarketplaceFeePercent).feeCents),
                    description: `MegaOutdoor Colecionáveis — Diferença de troca`,
                    customer: {
                        name: comprador.nome || pagante.nome,
                        taxID: comprador.documento,
                        email: comprador.email || pagante.email
                    },
                    paymentMethod: req.body.paymentMethod || "pix",
                    paymentMethodId: req.body.paymentMethodId,
                    cardToken: req.body.cardToken,
                    installments: req.body.installments
                });

                await pg().query(
                    `UPDATE sticker_trades
                        SET status = 'WAITING_PAYMENT',
                            order_id = $2,
                            mp_order_id = $3,
                            payment_type = $4,
                            updated_at = NOW()
                      WHERE id = $1`,
                    [trade.id, orderId, String(mp.orderId), splitUsado ? "STICKER_TRADE_SPLIT" : "STICKER_TRADE"]
                );

                await registrarHistoricoTrade(trade.id, `[ACEITA] Negociação aceita. Aguardando pagamento da diferença.`);
                await registrarTransacaoCol(
                    paganteId,
                    "TROCA_DIFERENCA_PEDIDO",
                    `Cobrança da diferença de R$ ${Number(trade.cash_amount).toFixed(2)} criada.`,
                    Number(trade.cash_amount),
                    orderId
                );

                registrarLog("colecionavel_troca_aguardando_pagamento", {
                    tradeId: trade.id,
                    orderId,
                    paganteId
                });

                return res.json({
                    ok: true,
                    status: "WAITING_PAYMENT",
                    orderId: String(mp.orderId),
                    externalReference: orderId,
                    qrCodeBase64: mp.qrCodeBase64,
                    payload: mp.payload,
                    ticketUrl: mp.ticketUrl,
                    expiresDate: mp.expirationDate,
                    paymentId: mp.paymentId,
                    valor: Number(trade.cash_amount)
                });
            }

            /* Troca simples — executa imediatamente */
            await executarTroca(trade);

            await registrarHistoricoTrade(trade.id, `[CONCLUÍDA] Troca executada.`);
            await registrarTransacaoDupla(
                trade.proposer_id,
                trade.receiver_id,
                "TROCA_CONCLUIDA",
                "Troca de figurinhas concluída.",
                0
            );

            const colecao = await colecaoAtiva();
            if (colecao) {
                await verificarConquistas(trade.proposer_id, colecao.id);
                await verificarConquistas(trade.receiver_id, colecao.id);
                await desbloquearConquista(trade.proposer_id, "primeira_troca");
                await desbloquearConquista(trade.receiver_id, "primeira_troca");
            }

            registrarLog("colecionavel_troca_concluida", { tradeId: trade.id });

            res.json({ ok: true, status: "COMPLETED" });
        } catch (error) {
            registrarLog("colecionavel_troca_erro", {
                erro: error.message,
                tradeId: req.params.id,
                usuarioId: req.usuario && req.usuario.id
            });
            res.status(500).json({ error: formatarErroPagamento(error) });
        }
    });

    /* Recusar proposta. */
    router.post("/trades/:id/decline", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const { trade, ok } = await podeAtualizarTrade(
                req.params.id, req.usuario.id, { proposer: true, receiver: true }
            );
            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (!ok) return res.status(403).json({ error: "Você não participa desta negociação." });

            if (["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED"].includes(trade.status)) {
                return res.status(400).json({ error: "Esta negociação já foi finalizada." });
            }

            await pg().query(
                `UPDATE sticker_trades SET status = 'DECLINED', updated_at = NOW()
                  WHERE id = $1`,
                [trade.id]
            );
            await registrarHistoricoTrade(trade.id, `[RECUSADA] Proposta recusada.`);

            registrarLog("colecionavel_troca_recusada", { tradeId: trade.id });

            res.json({ ok: true, status: "DECLINED" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Cancelar proposta (apenas o proponente). */
    router.post("/trades/:id/cancel", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_trades WHERE id = $1`,
                [req.params.id]
            );
            const trade = q.rows[0];
            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (trade.proposer_id !== req.usuario.id) {
                return res.status(403).json({ error: "Somente quem propôs pode cancelar." });
            }
            if (["COMPLETED", "DECLINED", "CANCELLED", "EXPIRED"].includes(trade.status)) {
                return res.status(400).json({ error: "Esta negociação já foi finalizada." });
            }

            await pg().query(
                `UPDATE sticker_trades SET status = 'CANCELLED', updated_at = NOW()
                  WHERE id = $1`,
                [trade.id]
            );
            await registrarHistoricoTrade(trade.id, `[CANCELADA] Proposta cancelada pelo proponente.`);

            registrarLog("colecionavel_troca_cancelada", { tradeId: trade.id });

            res.json({ ok: true, status: "CANCELLED" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Contraproposta. */
    router.post("/trades/:id/counter", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();

            const { trade, ok } = await podeAtualizarTrade(
                req.params.id, req.usuario.id, { proposer: false, receiver: true }
            );
            if (!trade) return res.status(404).json({ error: "Negociação não encontrada." });
            if (!ok) return res.status(403).json({ error: "Somente o destinatário pode contrapor." });

            if (trade.status !== "PENDING" && trade.status !== "COUNTER_OFFER") {
                return res.status(400).json({ error: "Esta proposta não pode mais receber contraproposta." });
            }
            if (new Date(trade.expires_at) < new Date()) {
                return res.status(400).json({ error: "Esta proposta expirou." });
            }

            const minhas = await validarItemsTroca(req.body.recebo);   // novo: o que o receiver oferece
            if (minhas.error) return res.status(400).json({ error: minhas.error });
            const delas = await validarItemsTroca(req.body.ofereco);   // novo: o que pede do proposer
            if (delas.error) return res.status(400).json({ error: delas.error });

            let cashAmount = Math.max(0, Number(req.body.cashAmount) || 0);
            if (cashAmount > 0) {
                cashAmount = Math.round(cashAmount * 100) / 100;
                if (cashAmount > 5000) return res.status(400).json({ error: "Valor da diferença muito alto." });
            }
            const cashDirection = req.body.cashDirection || null;
            if (cashAmount > 0 && cashDirection !== "proposer_pays" && cashDirection !== "receiver_pays") {
                return res.status(400).json({ error: "Defina quem paga a diferença." });
            }

            for (const item of minhas.items) {
                const disp = await quantidadeDisponivel(req.usuario.id, item.cardId, trade.id);
                if (disp < 1) return res.status(400).json({ error: "Uma figurinha que você oferece não está disponível." });
            }
            for (const item of delas.items) {
                const possuo = await quantidadePossuida(trade.proposer_id, item.cardId);
                if (possuo < 1) return res.status(400).json({ error: "O proponente não possui uma figurinha pedida." });
            }

            /* Substitui os itens da negociação */
            await pg().query(`DELETE FROM sticker_trade_items WHERE trade_id = $1`, [trade.id]);

            for (const item of minhas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'receiver')`,
                    [trade.id, req.usuario.id, item.cardId]
                );
            }
            for (const item of delas.items) {
                await pg().query(
                    `INSERT INTO sticker_trade_items (trade_id, owner_id, card_id, side)
                     VALUES ($1,$2,$3,'proposer')`,
                    [trade.id, trade.proposer_id, item.cardId]
                );
            }

            const novoExpira = new Date(Date.now() + TRADE_TTL_HORAS * 3600 * 1000);

            await pg().query(
                `UPDATE sticker_trades
                    SET status = 'COUNTER_OFFER',
                        cash_direction = $2,
                        cash_amount = $3,
                        order_id = $4,
                        expires_at = $5,
                        updated_at = NOW()
                  WHERE id = $1`,
                [trade.id, cashDirection, cashAmount,
                 cashAmount > 0 ? gerarOrderId("COL-TRADE") : null,
                 novoExpira]
            );

            await registrarHistoricoTrade(trade.id,
                `[CONTRAPROPOSTA] ${req.usuario.nome} fez uma contraproposta.` +
                (cashAmount > 0 ? ` Diferença de R$ ${cashAmount.toFixed(2)}.` : ""));

            await registrarTransacaoDupla(
                trade.proposer_id,
                trade.receiver_id,
                "TROCA_CONTRAPROPOSTA",
                `Contraproposta ${cashAmount > 0 ? "com diferença de R$ " + cashAmount.toFixed(2) : "simples"}.`,
                cashAmount
            );

            registrarLog("colecionavel_troca_contraproposta", { tradeId: trade.id });

            res.json({ ok: true, status: "COUNTER_OFFER" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       PERFIL DO COLECIONADOR
    ========================================================= */

    router.get("/perfil", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const colecao = await colecaoAtiva();
            const euQ = await pg().query(
                `SELECT album_publico FROM usuarios WHERE id = $1`,
                [req.usuario.id]
            );
            const albumPublico = euQ.rows[0]?.album_publico === true;

            const statsQ = await pg().query(
                `SELECT
                     COALESCE(SUM(us.quantity),0)::int AS total,
                     COUNT(DISTINCT us.card_id)::int AS diferentes,
                     COALESCE(SUM(GREATEST(us.quantity - 1, 0)),0)::int AS repetidas,
                     COUNT(DISTINCT CASE WHEN c.rarity='RARA'     THEN us.card_id END)::int AS raras,
                     COUNT(DISTINCT CASE WHEN c.rarity='EPICA'    THEN us.card_id END)::int AS epicas,
                     COUNT(DISTINCT CASE WHEN c.rarity='LENDARIA' THEN us.card_id END)::int AS lendarias,
                     COUNT(DISTINCT CASE WHEN c.rarity='MITICA'   THEN us.card_id END)::int AS miticas
                  FROM user_stickers us
                  JOIN sticker_cards c ON c.id = us.card_id
                 WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2`,
                [req.usuario.id, colecao.id]
            );

            const st = statsQ.rows[0] || {};

            const tradesQ = await pg().query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS trocas,
                     COUNT(*) FILTER (WHERE status = 'COMPLETED' AND cash_amount > 0)::int AS trocas_dinheiro
                  FROM sticker_trades
                 WHERE (proposer_id = $1 OR receiver_id = $1)`,
                [req.usuario.id]
            );

            const vendasQ = await pg().query(
                `SELECT COUNT(*)::int AS vendas
                   FROM sticker_orders
                  WHERE seller_id = $1 AND status = 'paid'`,
                [req.usuario.id]
            );

            const comprasQ = await pg().query(
                `SELECT COUNT(*)::int AS compras
                   FROM sticker_orders
                  WHERE buyer_id = $1 AND status = 'paid'`,
                [req.usuario.id]
            );

            /* Pacotes de figurinhas abertos (pagos) — estatística visual. */
            const pacotesQ = await pg().query(
                `SELECT COUNT(*)::int AS pacotes
                   FROM sticker_pack_purchases
                  WHERE usuario_id = $1 AND status = 'paid' AND open_status = 'opened'`,
                [req.usuario.id]
            );

            const mensalQ = await pg().query(
                `SELECT reward_key, completed_at FROM sticker_monthly_rewards
                  WHERE usuario_id = $1 ORDER BY completed_at DESC LIMIT 1`,
                [req.usuario.id]
            );

            const conquistasQ = await pg().query(
                `SELECT a.slug, a.name, a.icon
                   FROM sticker_user_achievements ua
                   JOIN sticker_achievements a ON a.id = ua.achievement_id
                  WHERE ua.usuario_id = $1
                  ORDER BY a.id`,
                [req.usuario.id]
            );

            /* Ranking: posição entre todos os colecionadores
               (ordenado por quantidade de figurinhas diferentes). */
            const rankQ = await pg().query(
                `SELECT 1 + COUNT(*)::int AS posicao
                   FROM (
                       SELECT usuario_id, COUNT(DISTINCT card_id) AS dif
                         FROM user_stickers
                        WHERE quantity > 0
                        GROUP BY usuario_id
                   ) t
                  WHERE t.dif > $1`,
                [Number(st.diferentes || 0)]
            );

            const totalColecionadores = await pg().query(
                `SELECT COUNT(*)::int AS total
                   FROM (
                       SELECT usuario_id
                         FROM user_stickers
                        WHERE quantity > 0
                        GROUP BY usuario_id
                   ) t`
            );

            const completas = Number(st.diferentes) >= Number(colecao.total) ? 1 : 0;

            /* Todas as conquistas com status (para o perfil do frontend). */
            const todasQ = await pg().query(
                `SELECT * FROM sticker_achievements ORDER BY id`
            );
            const desbloqueadasSet = new Set(conquistasQ.rows.map(r => r.slug));

            res.json({
                ok: true,
                perfil: {
                    nome: req.usuario.nome,
                    email: req.usuario.email,
                    album_publico: albumPublico,
                    figurinhas: Number(st.total || 0),
                    diferentes: Number(st.diferentes || 0),
                    repetidas: Number(st.repetidas || 0),
                    raras: Number(st.raras || 0),
                    epicas: Number(st.epicas || 0),
                    lendarias: Number(st.lendarias || 0),
                    miticas: Number(st.miticas || 0),
                    colecoes_completas: completas,
                    album_completo: completas === 1,
                    trocas: Number(tradesQ.rows[0]?.trocas || 0),
                    trocas_dinheiro: Number(tradesQ.rows[0]?.trocas_dinheiro || 0),
                    vendas: Number(vendasQ.rows[0]?.vendas || 0),
                    compras: Number(comprasQ.rows[0]?.compras || 0),
                    pacotes_abertos: Number(pacotesQ.rows[0]?.pacotes || 0),
                    recompensa_mensal: mensalQ.rows[0] ? {
                        reward: mensalQ.rows[0].reward_key,
                        completedAt: mensalQ.rows[0].completed_at
                    } : null,
                    ranking: Number(rankQ.rows[0]?.posicao || 1),
                    total_colecionadores: Number(totalColecionadores.rows[0]?.total || 0),
                    stats: {
                        total: Number(st.total || 0),
                        diferentes: Number(st.diferentes || 0),
                        repetidas: Number(st.repetidas || 0),
                        raras: Number(st.raras || 0)
                    },
                    conquistas: conquistasQ.rows
                },
                conquistas: todasQ.rows.map(a => ({
                    id: a.id,
                    slug: a.slug,
                    name: a.name,
                    description: a.description,
                    icon: a.icon,
                    desbloqueada: desbloqueadasSet.has(a.slug)
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Perfil público de outro usuário (para o marketplace/trocas). */
    router.get("/colecionador/:id", async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const usuario = await usuarioPorId(req.params.id);
            if (!usuario) {
                return res.status(404).json({ error: "Usuário não encontrado." });
            }
            const colecao = await colecaoAtiva();
            const albumPublico = usuario.album_publico === true;

            const statsQ = await pg().query(
                `SELECT
                     COALESCE(SUM(us.quantity),0)::int AS total,
                     COUNT(DISTINCT us.card_id)::int AS diferentes,
                     COALESCE(SUM(GREATEST(us.quantity - 1, 0)),0)::int AS repetidas
                  FROM user_stickers us
                  JOIN sticker_cards c ON c.id = us.card_id
                 WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2`,
                [usuario.id, colecao.id]
            );
            const st = statsQ.rows[0] || {};

            const vendasQ = await pg().query(
                `SELECT COUNT(*)::int AS qtd FROM sticker_listings
                  WHERE seller_id = $1 AND status = 'active'`,
                [usuario.id]
            );

            const perfil = {
                id: usuario.id,
                nome: usuario.nome,
                album_publico: albumPublico,
                privado: !albumPublico,
                figurinhas: Number(st.total || 0),
                diferentes: Number(st.diferentes || 0),
                repetidas: Number(st.repetidas || 0),
                vendas: Number(vendasQ.rows[0]?.qtd || 0),
                disponiveis_troca: Number(st.repetidas || 0)
            };

            /* Álbum privado: não expõe o acervo. */
            if (!albumPublico) {
                return res.json({ ok: true, perfil, cards: [] });
            }

            /* Álbum público: expõe apenas dados da coleção (nunca e-mail,
               tokens ou dados financeiros). */
            const cardsQ = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.image_url,
                        us.quantity
                   FROM user_stickers us
                   JOIN sticker_cards c ON c.id = us.card_id
                  WHERE us.quantity > 0 AND us.usuario_id = $1 AND c.collection_id = $2
                  ORDER BY c.number`,
                [usuario.id, colecao.id]
            );
            const cards = cardsQ.rows.map(c => ({
                id: c.id,
                number: c.number,
                name: c.name,
                rarity: c.rarity,
                image_url: c.image_url,
                quantity: Number(c.quantity)
            }));

            /* Anúncios ativos do colecionador (para COMPRAR no perfil). */
            const listaQ = await pg().query(
                `SELECT id, card_id, quantity, unit_price
                   FROM sticker_listings
                  WHERE seller_id = $1 AND status = 'active'`,
                [usuario.id]
            );
            const listings = {};
            for (const l of listaQ.rows) {
                listings[Number(l.card_id)] = {
                    id: l.id,
                    quantity: Number(l.quantity),
                    unit_price: Number(l.unit_price)
                };
            }
            for (const c of cards) {
                c.listing = listings[c.id] || null;
            }

            res.json({ ok: true, perfil, cards });
        } catch (error) {
            registrarLog && registrarLog("colecionador_publico_erro", { erro: error.message, id: req.params.id });
            res.status(500).json({ error: error.message });
        }
    });

    /* Alterna a visibilidade do álbum (PRIVADO/PÚBLICO). */
    router.put("/perfil/visibilidade", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        const albumPublico = req.body.albumPublico === true;
        try {
            await pg().query(
                `UPDATE usuarios SET album_publico = $1 WHERE id = $2`,
                [albumPublico, req.usuario.id]
            );
            registrarLog("colecionavel_album_visibilidade", {
                usuarioId: req.usuario.id,
                albumPublico
            });
            res.json({ ok: true, albumPublico, mensagem: albumPublico ? "Seu álbum agora é público." : "Seu álbum agora é privado." });
        } catch (error) {
            registrarLog("colecionavel_album_visibilidade_erro", { erro: error.message, usuarioId: req.usuario.id });
            res.status(500).json({ error: "Não foi possível alterar a visibilidade do álbum." });
        }
    });

    /* =========================================================
       DIAGNÓSTICO DE PAGAMENTOS / SPLIT (apenas para o usuário logado)
       Retorna apenas SIM/NÃO e percentuais — NUNCA expõe tokens,
       secrets ou credenciais.
    ========================================================= */

    router.get("/diagnostico/pagamentos", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const splitHabilitado = mercadopagoMarketplaceSplitEnabled === true &&
                typeof criarOrderMercadoPagoSplit === "function";
            let conta = null;
            let tokenValido = false;
            let vendedorConectado = false;
            let autorizacaoPresente = false;
            try {
                conta = await marketplaceConta(req.usuario.id);
                vendedorConectado = !!conta;
                if (conta) {
                    tokenValido = !!(conta.accessToken && String(conta.accessToken).length > 20) &&
                        (!conta.expiresAt || new Date(conta.expiresAt).getTime() > Date.now());
                    autorizacaoPresente = !!(conta.sellerUserId || conta.publicKey);
                }
            } catch (erroConta) {
                registrarLog && registrarLog("diagnostico_pagamentos_conta", { erro: String(erroConta && erroConta.message || erroConta) });
            }

            res.json({
                ok: true,
                split: {
                    habilitado: splitHabilitado ? "SIM" : "NÃO",
                    fee_percent: mercadopagoMarketplaceFeePercent
                },
                credenciais: {
                    producao_configurada: !!(process.env.MERCADOPAGO_CLIENT_ID && process.env.MERCADOPAGO_CLIENT_SECRET) ? "SIM" : "NÃO",
                    access_token_plataforma: !!process.env.MERCADOPAGO_ACCESS_TOKEN ? "SIM" : "NÃO",
                    ambiente: process.env.MERCADOPAGO_SANDBOX === "true" ? "TESTE" : "PRODUÇÃO"
                },
                vendedor: {
                    conectado: vendedorConectado ? "SIM" : "NÃO",
                    token_oauth_valido: tokenValido ? "SIM" : "NÃO",
                    autorizacao_presente: autorizacaoPresente ? "SIM" : "NÃO"
                }
            });
        } catch (error) {
            registrarLog && registrarLog("diagnostico_pagamentos_erro", { erro: String(error && error.message || error) });
            res.status(500).json({ error: "Não foi possível gerar o diagnóstico de pagamentos." });
        }
    });

    /* =========================================================
       CONQUISTAS
    ========================================================= */

    router.get("/conquistas", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            await expirarNegociacoesVencidas();
            const allQ = await pg().query(
                `SELECT * FROM sticker_achievements ORDER BY id`
            );
            const haveQ = await pg().query(
                `SELECT achievement_id, created_at
                   FROM sticker_user_achievements
                  WHERE usuario_id = $1`,
                [req.usuario.id]
            );
            const have = new Map(haveQ.rows.map(r => [r.achievement_id, r.created_at]));

            res.json({
                ok: true,
                conquistas: allQ.rows.map(a => ({
                    id: a.id,
                    slug: a.slug,
                    name: a.name,
                    description: a.description,
                    icon: a.icon,
                    desbloqueada: have.has(a.id),
                    desbloqueada_em: have.get(a.id) || null
                }))
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       HISTÓRICO
    ========================================================= */

    router.get("/historico", obterAuthUsuario(), async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_transactions
                  WHERE usuario_id = $1
                  ORDER BY created_at DESC
                  LIMIT 200`,
                [req.usuario.id]
            );
            res.json({
                ok: true,
                historico: q.rows
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       MODO TESTE (ALLOW_TEST_MODE)
       Simula a confirmação de pagamento SEM pagamento real.
       NUNCA ativo em produção.
    ========================================================= */

    router.post("/test/confirm/:orderId", obterAuthUsuario(), async (req, res) => {
        if (process.env.ALLOW_TEST_MODE !== "true") {
            return res.status(403).json({ error: "Modo de teste desativado." });
        }
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const orderId = req.params.orderId;

            const dono = await pg().query(
                `SELECT usuario_id FROM sticker_pack_purchases WHERE order_id = $1
                 UNION ALL
                 SELECT buyer_id AS usuario_id FROM sticker_orders WHERE order_id = $1
                 UNION ALL
                 SELECT proposer_id AS usuario_id FROM sticker_trades WHERE (order_id = $1 OR mp_order_id = $1) AND status = 'WAITING_PAYMENT'`,
                [orderId]
            );
            if (!dono.rows.length) {
                return res.status(404).json({ error: "Pedido não encontrado." });
            }
            if (dono.rows[0].usuario_id !== req.usuario.id) {
                return res.status(403).json({ error: "Acesso negado a este pedido." });
            }

            const resultado = await processarPagamento({ mpOrderId: orderId });
            if (!resultado) {
                return res.status(400).json({ error: "Nenhum pedido pendente para este código." });
            }

            registrarLog("colecionavel_pagamento_testado", {
                orderId,
                usuarioId: req.usuario.id,
                tipo: resultado.tipo
            });

            res.json({ ok: true, tipo: resultado.tipo });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* =========================================================
       ADMIN (protegido por authAdmin)
       Leitura/escrita administrativa do sistema de colecionáveis.
       Todas as rotas exigem o token JWT de administrador.
    ========================================================= */

    router.get("/admin/resumo", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();

            const cardsQ = await pg().query(
                `SELECT rarity, COUNT(*)::int AS qtd,
                        SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS ativos
                   FROM sticker_cards WHERE collection_id = $1 GROUP BY rarity`,
                [colecao.id]
            );

            const circulacaoQ = await pg().query(
                `SELECT COALESCE(SUM(quantity),0)::int AS total
                   FROM user_stickers`
            );

            const colecionadoresQ = await pg().query(
                `SELECT COUNT(*)::int AS total FROM
                   (SELECT DISTINCT usuario_id FROM user_stickers) s`
            );

            const compradoresQ = await pg().query(
                `SELECT COUNT(DISTINCT usuario_id)::int AS total
                   FROM sticker_pack_purchases`
            );

            const pacotesQ = await pg().query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'paid')::int AS vendas_pacotes,
                     COALESCE(SUM(price) FILTER (WHERE status = 'paid'),0)::numeric AS receita_pacotes
                  FROM sticker_pack_purchases
                 WHERE test = FALSE`
            );

            const mercadoQ = await pg().query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'paid')::int AS vendas_mercado,
                     COALESCE(SUM(total) FILTER (WHERE status = 'paid'),0)::numeric AS receita_mercado
                  FROM sticker_orders
                 WHERE test = FALSE`
            );

            const trocasQ = await pg().query(
                `SELECT
                     COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE status IN
                         ('PENDING','COUNTER_OFFER','ACCEPTED',
                          'WAITING_PAYMENT','PAID','PROCESSING'))::int AS em_andamento,
                     COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS concluidas
                   FROM sticker_trades`
            );

            const conquistasQ = await pg().query(
                `SELECT COUNT(*)::int AS desbloqueadas
                   FROM sticker_user_achievements`
            );

            const pacotesAtivosQ = await pg().query(
                `SELECT COUNT(*)::int AS ativos FROM sticker_packs
                  WHERE collection_id = $1 AND is_active = TRUE`,
                [colecao.id]
            );

            res.json({
                ok: true,
                colecao: {
                    name: colecao.name,
                    total: Number(colecao.total),
                    cards: cardsQ.rows.reduce((s, r) => s + Number(r.qtd), 0),
                    packs_ativos: Number(pacotesAtivosQ.rows[0].ativos)
                },
                cardsPorRaridade: cardsQ.rows,
                figurinhas_em_circulacao: Number(circulacaoQ.rows[0].total),
                colecionadores: Number(colecionadoresQ.rows[0].total),
                compradores: Number(compradoresQ.rows[0].total),
                pacotes: pacotesQ.rows[0],
                mercado: mercadoQ.rows[0],
                trocas: trocasQ.rows[0],
                conquistas: {
                    desbloqueadas: Number(conquistasQ.rows[0].desbloqueadas),
                    total: CONQUISTAS.length
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar colecionadores (admin). */
    router.get("/admin/colecionadores", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT u.id, u.nome, u.email, u.criado_em,
                        COALESCE(s.diferentes,0)::int AS diferentes,
                        COALESCE(s.total,0)::int AS total_figurinhas,
                        COALESCE(s.repetidas,0)::int AS repetidas,
                        COALESCE(a.conquistas,0)::int AS conquistas
                   FROM usuarios u
                   LEFT JOIN (
                       SELECT usuario_id,
                              COUNT(*) FILTER (WHERE quantity > 0)::int AS diferentes,
                              SUM(quantity)::int AS total,
                              SUM(quantity) - COUNT(*) FILTER (WHERE quantity > 0)::int AS repetidas
                         FROM user_stickers GROUP BY usuario_id
                   ) s ON s.usuario_id = u.id
                   LEFT JOIN (
                       SELECT usuario_id, COUNT(*)::int AS conquistas
                         FROM sticker_user_achievements GROUP BY usuario_id
                   ) a ON a.usuario_id = u.id
                  ORDER BY s.diferentes DESC NULLS LAST, u.nome
                  LIMIT 500`
            );
            res.json({ ok: true, colecionadores: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Álbum/progresso de um usuário específico (admin). */
    router.get("/admin/usuario/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const usuarioId = Number(req.params.id);
            if (!Number.isInteger(usuarioId)) {
                return res.status(400).json({ error: "ID de usuário inválido." });
            }
            const colecao = await colecaoAtiva();
            const usuario = await usuarioPorId(usuarioId);
            if (!usuario) {
                return res.status(404).json({ error: "Usuário não encontrado." });
            }

            const cardsQ = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.image_url,
                        COALESCE(us.quantity,0)::int AS quantidade
                   FROM sticker_cards c
                   LEFT JOIN user_stickers us
                          ON us.card_id = c.id AND us.usuario_id = $2
                  WHERE c.collection_id = $1
                  ORDER BY c.number`,
                [colecao.id, usuarioId]
            );
            const cards = cardsQ.rows.map(c => ({ ...c, number: Number(c.number) }));

            const conquistasQ = await pg().query(
                `SELECT a.slug, a.name, a.icon
                   FROM sticker_achievements a
                   JOIN sticker_user_achievements ua ON ua.achievement_id = a.id
                  WHERE ua.usuario_id = $1
                  ORDER BY a.id`,
                [usuarioId]
            );

            const diferentes = cards.filter(c => c.quantidade > 0).length;
            const total = Number(colecao.total);
            const repetidas = cards.reduce((s, c) => s + Math.max(0, c.quantidade - 1), 0);

            res.json({
                ok: true,
                usuario,
                progresso: {
                    diferentes,
                    total,
                    repetidas,
                    album_completo: diferentes >= total
                },
                cards,
                conquistas: conquistasQ.rows
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Estoque/disponibilidade por figurinha (admin). */
    router.get("/admin/estoque", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const colecao = await colecaoAtiva();
            const q = await pg().query(
                `SELECT c.id, c.number, c.name, c.rarity, c.is_active,
                        COALESCE(s.total,0)::int AS em_circulacao,
                        COALESCE(l.listado,0)::int AS listado,
                        COALESCE(t.em_troca,0)::int AS em_troca
                   FROM sticker_cards c
                   LEFT JOIN (
                       SELECT card_id, SUM(quantity)::int AS total
                         FROM user_stickers GROUP BY card_id
                   ) s ON s.card_id = c.id
                   LEFT JOIN (
                       SELECT card_id, SUM(quantity)::int AS listado
                         FROM sticker_listings WHERE status = 'active'
                        GROUP BY card_id
                   ) l ON l.card_id = c.id
                   LEFT JOIN (
                       SELECT ti.card_id, COUNT(*)::int AS em_troca
                         FROM sticker_trade_items ti
                         JOIN sticker_trades t ON t.id = ti.trade_id
                        WHERE t.status IN
                             ('PENDING','COUNTER_OFFER','ACCEPTED',
                              'WAITING_PAYMENT','PAID','PROCESSING')
                        GROUP BY ti.card_id
                   ) t ON t.card_id = c.id
                  WHERE c.collection_id = $1
                  ORDER BY c.number`,
                [colecao.id]
            );
            const rows = q.rows.map(r => ({
                ...r,
                number: Number(r.number),
                em_circulacao: Number(r.em_circulacao),
                listado: Number(r.listado),
                em_troca: Number(r.em_troca),
                disponivel: Math.max(0,
                    Number(r.em_circulacao) - Number(r.listado) - Number(r.em_troca))
            }));
            res.json({ ok: true, cards: rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Compras de pacotes (admin). */
    router.get("/admin/compras", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT p.id, p.order_id, p.pack_id, pk.name AS pack_name,
                        p.price, p.quantity, p.status, p.test, p.created_at,
                        u.id AS usuario_id, u.nome, u.email
                   FROM sticker_pack_purchases p
                   JOIN usuarios u ON u.id = p.usuario_id
                   LEFT JOIN sticker_packs pk ON pk.id = p.pack_id
                  ORDER BY p.created_at DESC
                  LIMIT 500`
            );
            res.json({ ok: true, compras: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Vendas no marketplace (admin). */
    router.get("/admin/vendas", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT o.id, o.order_id, o.card_id, c.number, c.name AS card_name,
                        c.rarity, o.quantity, o.unit_price, o.total, o.fee,
                        o.net_seller, o.status, o.test, o.created_at,
                        cb.id AS buyer_id, cb.nome AS buyer_nome, cb.email AS buyer_email,
                        sv.id AS seller_id, sv.nome AS seller_nome, sv.email AS seller_email
                   FROM sticker_orders o
                   JOIN usuarios cb ON cb.id = o.buyer_id
                   JOIN usuarios sv ON sv.id = o.seller_id
                   JOIN sticker_cards c ON c.id = o.card_id
                  ORDER BY o.created_at DESC
                  LIMIT 500`
            );
            res.json({ ok: true, vendas: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Transações do sistema de colecionáveis (admin). */
    router.get("/admin/transacoes", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT t.*, u.nome, u.email
                   FROM sticker_transactions t
                   JOIN usuarios u ON u.id = t.usuario_id
                  ORDER BY t.created_at DESC
                  LIMIT 500`
            );
            res.json({ ok: true, transacoes: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Conquistas (admin). */
    router.get("/admin/conquistas", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT a.id, a.slug, a.name, a.description, a.icon,
                        COUNT(ua.id)::int AS desbloqueios
                   FROM sticker_achievements a
                   LEFT JOIN sticker_user_achievements ua ON ua.achievement_id = a.id
                  GROUP BY a.id
                  ORDER BY a.id`
            );
            res.json({ ok: true, conquistas: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Atualizar figurinha (admin): nome, número, raridade, arte,
       descrição e status ativo/inativo. */
    router.post("/admin/cards/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const cardId = Number(req.params.id);
            if (!Number.isInteger(cardId)) {
                return res.status(400).json({ error: "ID de figurinha inválido." });
            }
            const card = await cardPorId(cardId);
            if (!card) {
                return res.status(404).json({ error: "Figurinha não encontrada." });
            }

            const campos = [];
            const params = [cardId];

            if (req.body.name !== undefined) {
                const name = String(req.body.name).trim();
                if (!name || name.length > 200) {
                    return res.status(400).json({ error: "Nome inválido." });
                }
                params.push(name);
                campos.push(`name = $${params.length}`);
            }

            if (req.body.number !== undefined) {
                const number = Number(req.body.number);
                if (!Number.isInteger(number) || number < 1 || number > 9999) {
                    return res.status(400).json({ error: "Número inválido." });
                }
                const dup = await pg().query(
                    `SELECT COUNT(*)::int AS qtd FROM sticker_cards
                      WHERE collection_id = $1 AND number = $2 AND id <> $3`,
                    [card.collection_id, number, cardId]
                );
                if (Number(dup.rows[0].qtd) > 0) {
                    return res.status(400).json({ error: "Já existe outra figurinha com este número." });
                }
                params.push(number);
                campos.push(`number = $${params.length}`);
            }

            if (req.body.rarity !== undefined) {
                const rarity = String(req.body.rarity).trim().toUpperCase();
                if (!RARIDADES[rarity]) {
                    return res.status(400).json({ error: "Raridade inválida." });
                }
                const limite = rarity === "LENDARIA" ? 5 : rarity === "MITICA" ? 3 : null;
                if (limite && card.rarity !== rarity) {
                    const qtdQ = await pg().query(
                        `SELECT COUNT(*)::int AS qtd FROM sticker_cards
                          WHERE collection_id = $1 AND rarity = $2 AND is_active = TRUE`,
                        [card.collection_id, rarity]
                    );
                    if (Number(qtdQ.rows[0]?.qtd || 0) >= limite) {
                        return res.status(400).json({ error: `A edição deve manter no máximo ${limite} ${rarity}.` });
                    }
                }
                params.push(rarity);
                campos.push(`rarity = $${params.length}`);
            }

            if (req.body.description !== undefined) {
                const description = req.body.description === null ? null : String(req.body.description);
                params.push(description);
                campos.push(`description = $${params.length}`);
            }

            if (req.body.scientific_name !== undefined) {
                const sn = req.body.scientific_name === null ? null : String(req.body.scientific_name).trim();
                if (sn !== null && sn.length > 200) {
                    return res.status(400).json({ error: "Nome científico inválido." });
                }
                params.push(sn);
                campos.push(`scientific_name = $${params.length}`);
            }

            if (req.body.habitat !== undefined) {
                const habitat = req.body.habitat === null ? null : String(req.body.habitat).trim();
                if (habitat !== null && habitat.length > 120) {
                    return res.status(400).json({ error: "Habitat inválido." });
                }
                params.push(habitat);
                campos.push(`habitat = $${params.length}`);
            }

            if (req.body.peso !== undefined) {
                const peso = req.body.peso === null ? null : String(req.body.peso).trim();
                if (peso !== null && peso.length > 80) {
                    return res.status(400).json({ error: "Peso inválido." });
                }
                params.push(peso);
                campos.push(`peso = $${params.length}`);
            }

            if (req.body.image_url !== undefined) {
                const img = String(req.body.image_url || "").trim();
                if (img && !/^https?:\/\//i.test(img)) {
                    return res.status(400).json({ error: "URL de imagem inválida." });
                }
                params.push(img || null);
                campos.push(`image_url = $${params.length}`);
            }

            if (req.body.is_active !== undefined) {
                const ativo = req.body.is_active === true || req.body.is_active === "true";
                params.push(ativo);
                campos.push(`is_active = $${params.length}`);
            }

            if (!campos.length) {
                return res.status(400).json({ error: "Nenhum campo para atualizar." });
            }

            await pg().query(
                `UPDATE sticker_cards SET ${campos.join(", ")} WHERE id = $1`,
                params
            );

            registrarLog("colecionavel_admin_cards", {
                cardId,
                campos: campos.map(c => c.split(" ")[0])
            });

            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar pacotes (admin). */
    router.get("/admin/packs", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT p.*, c.name AS collection_name
                   FROM sticker_packs p
                   LEFT JOIN sticker_collections c ON c.id = p.collection_id
                  ORDER BY p.collection_id, p.price`
            );
            res.json({ ok: true, packs: q.rows.map(p => ({
                ...p,
                price: Number(p.price),
                sticker_quantity: Number(p.sticker_quantity),
                is_active: !!p.is_active
            })) });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar coleções (admin). */
    router.get("/admin/colecoes", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT c.*,
                        (SELECT COUNT(*) FROM sticker_cards WHERE collection_id = c.id) AS cards,
                        (SELECT COUNT(*) FROM sticker_packs WHERE collection_id = c.id) AS packs
                   FROM sticker_collections c
                  ORDER BY c.id`
            );
            res.json({ ok: true, colecoes: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar cards (admin). */
    router.get("/admin/cards", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT * FROM sticker_cards ORDER BY number LIMIT 500`
            );
            res.json({ ok: true, cards: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Listar negociações (admin, moderação). */
    router.get("/admin/trades", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const q = await pg().query(
                `SELECT t.*, pu.nome AS proposer_nome, ru.nome AS receiver_nome
                   FROM sticker_trades t
                   JOIN usuarios pu ON pu.id = t.proposer_id
                   JOIN usuarios ru ON ru.id = t.receiver_id
                  ORDER BY t.updated_at DESC
                  LIMIT 200`
            );
            res.json({ ok: true, trades: q.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /* Atualizar pacote (admin): preço, quantidade, nome, descrição e
       status ativo/inativo. */
    router.post("/admin/packs/:id", authAdmin, async (req, res) => {
        if (!pgOk()) {
            return res.status(503).json({ error: "Sistema de colecionáveis indisponível no momento." });
        }
        try {
            const packId = Number(req.params.id);
            if (!Number.isInteger(packId)) {
                return res.status(400).json({ error: "ID de pacote inválido." });
            }

            const campos = [];
            const params = [packId];

            if (req.body.price !== undefined) {
                const preco = Number(req.body.price);
                if (!isFinite(preco) || preco <= 0) {
                    return res.status(400).json({ error: "Preço inválido." });
                }
                params.push(Math.round(preco * 100) / 100);
                campos.push(`price = $${params.length}`);
            }

            if (req.body.sticker_quantity !== undefined) {
                const qtd = Number(req.body.sticker_quantity);
                if (!Number.isInteger(qtd) || qtd < 1 || qtd > 100) {
                    return res.status(400).json({ error: "Quantidade inválida." });
                }
                params.push(qtd);
                campos.push(`sticker_quantity = $${params.length}`);
            }

            if (req.body.name !== undefined) {
                const name = String(req.body.name).trim();
                if (!name || name.length > 100) {
                    return res.status(400).json({ error: "Nome inválido." });
                }
                params.push(name);
                campos.push(`name = $${params.length}`);
            }

            if (req.body.description !== undefined) {
                const description = req.body.description === null ? null : String(req.body.description);
                params.push(description);
                campos.push(`description = $${params.length}`);
            }

            if (req.body.is_active !== undefined) {
                const ativo = req.body.is_active === true || req.body.is_active === "true";
                params.push(ativo);
                campos.push(`is_active = $${params.length}`);
            }

            if (!campos.length) {
                return res.status(400).json({ error: "Nenhum campo para atualizar." });
            }

            const r = await pg().query(
                `UPDATE sticker_packs SET ${campos.join(", ")} WHERE id = $1`,
                params
            );
            if (!r.rowCount) {
                return res.status(404).json({ error: "Pacote não encontrado." });
            }

            registrarLog("colecionavel_admin_packs", {
                packId,
                campos: campos.map(c => c.split(" ")[0])
            });

            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return {
        router,
        migrar,
        processarPagamento,
        processarMarketplacePayment,
        sortearRaridade,
        sortearCards,
        entregarPacoteParaUsuario
    };
};
