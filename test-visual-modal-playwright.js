/* Auditoria do MODAL da figurinha (desktop e mobile):
   - o verso ("6.000 kg", "Compr...") usa fonte FIXA pequena, nunca
     herdada do .modal-arte (font-size:90px);
   - o flip 3D funciona (toggle .virado);
   - sem overflow estrutural com o modal aberto. */
const { chromium } = require("playwright");
const path = require("path");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const root = path.resolve(__dirname, "public");
    const fs = require("fs");
    const failures = [];

    /* colecionaveis.html referencia /js/* com caminho absoluto, que não
       resolve em file://. Injeta os scripts antes do load da página. */
    const uiSource = fs.readFileSync(path.join(root, "js", "colecao-ui.js"), "utf8");
    const imagensSource = fs.readFileSync(path.join(root, "js", "imagens-animais.js"), "utf8");

    const cardMock = {
        id: 3, number: 3, name: "Elefante-africano", rarity: "COMUM",
        image_url: "", scientific_name: "Loxodonta africana",
        habitat: "Savana", peso: "6000", comprimento: "6,0 m",
        description: "O maior animal terrestre.",
        curiosity: "Pode consumir até 150 kg de vegetação por dia."
    };

    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage();
        await page.setViewportSize(viewport);
        await page.addInitScript(([a, b]) => {
            try { new Function(b)(); } catch (e) { console.error("injetar imagens:", e); }
            try { new Function(a)(); } catch (e) { console.error("injetar colecao-ui:", e); }
        }, [uiSource, imagensSource]);
        await page.goto("file://" + path.join(root, "colecionaveis.html"), { waitUntil: "domcontentloaded" });

        const r = await page.evaluate((card) => {
            const conteiner = document.createElement("div");
            conteiner.id = "modalTeste";
            document.body.appendChild(conteiner);
            conteiner.innerHTML = window.cardModalArte ? window.cardModalArte(card) : "";
            const versoTxt = conteiner.querySelector(".cc-verso-lista");
            const versoSize = versoTxt ? getComputedStyle(versoTxt).fontSize : null;
            const modalPremium = conteiner.querySelector(".modal-arte-premium");
            const premiumSize = modalPremium ? getComputedStyle(modalPremium).fontSize : null;

            /* flip: aciona o toggle (procura o container id usado pelo modal) */
            if (window.toggleModalFlip && conteiner.querySelector("#modalFlipContainer")) {
                window.toggleModalFlip.call(conteiner.querySelector("#modalFlipContainer"));
            }
            const virado = !!conteiner.querySelector(".cc-flipper.virado");

            const frontTxt = conteiner.querySelector(".cc-frente");
            return {
                versoSize,
                premiumSize,
                virado,
                overflow: conteiner.scrollWidth > window.innerWidth + 2,
                cardOk: !!conteiner.querySelector(".colecao-card"),
                qtdMeta: conteiner.querySelector(".cc-meta") ? conteiner.querySelector(".cc-meta").textContent : ""
            };
        }, cardMock);

        const desc = viewport.width + "px";
        if (r.versoSize !== "11px") failures.push(`modal ${desc}: verso ${r.versoSize} (esperado 11px) — FONTE GIGANTE`);
        if (r.premiumSize !== "14px") failures.push(`modal ${desc}: modal-arte-premium ${r.premiumSize} (esperado 14px)`);
        if (!r.virado) failures.push(`modal ${desc}: flip 3D não ativou (.virado)`);
        if (r.overflow) failures.push(`modal ${desc}: overflow horizontal`);
        if (!r.cardOk) failures.push(`modal ${desc}: card não renderizou`);
        await page.close();
    }

    await browser.close();
    console.log(failures.length ? "FAIL\n" + failures.join("\n") : "PASS | Modal desktop/mobile: fonte do verso OK, flip OK, sem overflow");
    process.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });