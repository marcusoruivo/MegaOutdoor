/* Smoke test do frontend: selector visual de modo de publicação e modal
   de edição (EDITAR PUBLICAÇÃO) em desktop e mobile. Arquivo estático. */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const root = path.resolve(__dirname, "public");
    const failures = [];
    const errosJS = [];

    page.on("pageerror", e => errosJS.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error") errosJS.push("console: " + m.text()); });

    await page.goto("file://" + path.join(root, "index.html"), { waitUntil: "domcontentloaded" });

    /* 1. Selector visual do checkout pós-compra (2 espaços) */
    const r1 = await page.evaluate(() => {
        paidSpaces = [100, 101];
        document.getElementById("publicacao").style.display = "block";
        iniciarModoPublicacaoCheckout();
        const box = document.getElementById("modoPublicacaoOpcoes");
        const botoes = [...box.querySelectorAll(".modo-pub-btn")];
        const estendida = botoes.find(b => b.dataset.modo === "estendida");
        return {
            qtd: botoes.length,
            svg: box.querySelectorAll("svg").length,
            estendidaDisabled: estendida ? estendida.disabled : null,
            selecionado: box.querySelectorAll(".modo-pub-btn.selecionado").length,
            explica: document.getElementById("modoPublicacaoExplica").textContent.trim(),
            select: document.getElementById("modoAnuncio").value
        };
    });
    const ok1 = r1.qtd === 2 && r1.svg === 2 && r1.estendidaDisabled === false && r1.selecionado === 1 && r1.explica.includes("Cada espaço") && r1.select === "individual";
    if (!ok1) failures.push("checkout 2 espaços: " + JSON.stringify(r1));

    /* 2. Com 1 espaço, estendida fica desabilitada */
    const r2 = await page.evaluate(() => {
        paidSpaces = [100];
        iniciarModoPublicacaoCheckout();
        const estendida = [...document.querySelectorAll("#modoPublicacaoOpcoes .modo-pub-btn")].find(b => b.dataset.modo === "estendida");
        const explica = document.getElementById("modoPublicacaoExplica").textContent;
        return { disabled: estendida ? estendida.disabled : null, explica };
    });
    if (!r2.disabled) failures.push("checkout 1 espaço estendida deveria estar desabilitada: " + JSON.stringify(r2));

    /* 3. Modal de edição: cartões de modo renderizam */
    const r3 = await page.evaluate(() => {
        orderTokens[100] = "tok-dono";
        db[100] = { id: 100, status: "paid", title: "Empresa X", orderToken: "tok-dono", displayMode: "individual", imageGroupSpaces: [100] };
        editarFoto(100);
        const box = document.getElementById("editModoPublicacao");
        const botoes = [...box.querySelectorAll(".modo-pub-btn")];
        const estendida = botoes.find(b => b.dataset.modo === "estendida");
        return {
            qtd: botoes.length,
            svg: box.querySelectorAll("svg").length,
            estendidaDisabled: estendida ? estendida.disabled : null,
            selecionado: box.querySelectorAll(".modo-pub-btn.selecionado").length,
            semImg: document.getElementById("editSemImagem").style.display,
            titulo: document.getElementById("editTitulo").value,
            modal: document.getElementById("editModal").style.display
        };
    });
    if (!(r3.qtd === 2 && r3.svg === 2 && r3.estendidaDisabled === true && r3.selecionado === 1 && r3.semImg === "block" && r3.titulo === "Empresa X" && r3.modal === "flex")) failures.push("edit modal: " + JSON.stringify(r3));

    /* 4. Estendida em edição: dono de 2 espaços consecutivos */
    const r4 = await page.evaluate(() => {
        orderTokens[100] = "tok-dono";
        orderTokens[101] = "tok-dono";
        db[100] = { id: 100, status: "paid", title: "X", orderToken: "tok-dono", displayMode: "individual", imageGroupSpaces: [100] };
        db[101] = { id: 101, status: "paid", title: "X", orderToken: "tok-dono", displayMode: "individual", imageGroupSpaces: [101] };
        editarFoto(100);
        const estendida = [...document.querySelectorAll("#editModoPublicacao .modo-pub-btn")].find(b => b.dataset.modo === "estendida");
        estendida.click();
        const chips = document.querySelectorAll("#editExtensao .modo-ext-chip").length;
        const checked = document.querySelectorAll("#editExtensao input:checked").length;
        return { chips, checked, explica: document.getElementById("editModoExplica").textContent.trim() };
    });
    if (!(r4.chips >= 2 && r4.checked >= 2 && r4.explica.includes("contínua"))) failures.push("edit estendida: " + JSON.stringify(r4));

    /* 5. Responsividade mobile: modal de edição não estoura a tela */
    await page.setViewportSize({ width: 390, height: 844 });
    const r5 = await page.evaluate(() => {
        document.getElementById("editModal").style.display = "flex";
        const box = document.querySelector("#editModal .box");
        const r = box.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, vw: window.innerWidth, overflowX: document.documentElement.scrollWidth };
    });
    if (r5.left < -1 || r5.right > r5.vw + 1 || r5.overflowX > r5.vw + 2) failures.push("mobile editModal overflow: " + JSON.stringify(r5));

    await browser.close();

    if (errosJS.length) {
        const reais = errosJS.filter(e =>
            !e.includes("Failed to load resource") &&
            !e.includes("net::ERR") &&
            !e.includes("Fetch API cannot load file://") &&
            !e.includes("Origin") &&
            !e.includes("Failed to fetch"));
        if (reais.length) failures.push("erros JS: " + reais.slice(0, 5).join(" | "));
    }

    console.log(failures.length ? "FAIL\n" + failures.join("\n") : "PASS | frontend publicação/edição desktop+mobile sem overflow e sem erros JS");
    process.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });