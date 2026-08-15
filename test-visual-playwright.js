/* Auditoria visual estática desktop/mobile. Não depende de checkout real. */
const { chromium } = require("playwright");
const path = require("path");
const os = require("os");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const root = path.resolve(__dirname, "public");
    const failures = [];
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        for (const file of ["index.html", "colecionaveis.html"]) {
            await page.goto("file://" + path.join(root, file), { waitUntil: "domcontentloaded" });
            const result = await page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                viewport: window.innerWidth,
                objectText: document.body.innerText.includes("[object Object]"),
                modal: !!document.querySelector(".modal, .modal-overlay"),
                images: [...document.images].filter(img => img.src && img.complete && img.naturalWidth === 0 && !img.src.startsWith("data:") && !img.src.includes("logo-milhao-door.png")).length
            }));
            if (result.width > result.viewport + 2) failures.push(`${file} ${viewport.width}: overflow ${result.width}/${result.viewport}`);
            if (result.objectText) failures.push(`${file} ${viewport.width}: [object Object]`);
            if (result.images) failures.push(`${file} ${viewport.width}: ${result.images} imagem(ns) quebrada(s)`);
        }
    }
    const screenshotDir = path.join(os.tmpdir(), "megaoutdoor-playwright");
    const fs = require("fs");
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("file://" + path.join(root, "colecionaveis.html"), { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: path.join(screenshotDir, "colecionaveis-mobile.png"), fullPage: true });
    await browser.close();
    console.log(failures.length ? "FAIL\n" + failures.join("\n") : "PASS | Playwright desktop/mobile sem overflow estrutural");
    console.log("Screenshot: " + path.join(screenshotDir, "colecionaveis-mobile.png"));
    process.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
