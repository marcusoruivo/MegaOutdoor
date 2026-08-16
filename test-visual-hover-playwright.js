/* Teste funcional: números dos espaços só aparecem no hover/seleção (canvas). */
const { chromium } = require("playwright");
const path = require("path");

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto("file://" + path.resolve(__dirname, "public/index.html"), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof draw === "function" && typeof getMousePos === "function" && typeof fecharTutorial === "function" && document.querySelector("#canvas"));
    await page.evaluate(() => { try { localStorage.setItem("mega_tutorial_visto", "1"); } catch (e) {} fecharTutorial(); });
    await page.waitForTimeout(300);

    const result = await page.evaluate(() => {
        const canvas = document.querySelector("#canvas");
        const ctx = canvas.getContext("2d");
        const W = canvas.width, H = canvas.height;

        function screenPos(col, row) {
            return { sx: x + col * T * sc, sy: y + row * T * sc };
        }

        function sampleLabel(col, row) {
            const p = screenPos(col, row);
            const lx = Math.max(0, Math.round(p.sx + 35 * sc));
            const ly = Math.max(0, Math.round(p.sy + 35 * sc));
            const lw = Math.max(1, Math.round(30 * sc));
            const lh = Math.max(1, Math.round(30 * sc));
            const img = ctx.getImageData(lx, ly, lw, lh).data;
            let yellow = 0;
            for (let i = 0; i < img.length; i += 4) {
                const r = img[i], g = img[i + 1], b = img[i + 2];
                if (r > 180 && g > 120 && b < 110) yellow++;
            }
            return { yellow, lx, ly, lw, lh };
        }

        function findUnsoldOnScreen() {
            let best = null, bestDist = Infinity;
            const cx = W / 2, cy = H / 2;
            for (let row = 0; row < C; row++) {
                const py = y + row * T * sc;
                if (py < 0 || py + T * sc > H) continue;
                for (let col = 0; col < C; col++) {
                    const px = x + col * T * sc;
                    if (px < 0 || px + T * sc > W) continue;
                    const id = row * C + col + 1;
                    if (!db[id]) {
                        const d = Math.abs(px + T * sc / 2 - cx) + Math.abs(py + T * sc / 2 - cy);
                        if (d < bestDist) { bestDist = d; best = { id, col, row }; }
                    }
                }
            }
            return best;
        }

        const target = findUnsoldOnScreen();
        if (!target) return { error: "nenhum espaço livre na tela" };
        const p = screenPos(target.col, target.row);
        const rect = area.getBoundingClientRect();
        return {
            target,
            sx: rect.left + p.sx + T * sc / 2,
            sy: rect.top + p.sy + T * sc / 2,
            before: sampleLabel(target.col, target.row),
            W, H, T, sc, x, y, C
        };
    });

    if (result.error) { await browser.close(); console.log("SKIP | " + result.error); process.exit(0); }

    const out = { id: result.target.id, beforeYellow: result.before.yellow };
    if (result.before.yellow > 2) { await browser.close(); console.log("FAIL | número visível sem hover (yellow=" + result.before.yellow + ")"); process.exit(1); }

    await page.locator("#area").scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.mouse.move(result.sx, result.sy);
    await page.waitForTimeout(250);
    out.hoverYellow = await page.evaluate(([col, row]) => {
        const canvas = document.querySelector("#canvas");
        const ctx = canvas.getContext("2d");
        const lx = Math.max(0, Math.round(x + (col * T + 35) * sc));
        const ly = Math.max(0, Math.round(y + (row * T + 35) * sc));
        const lw = Math.max(1, Math.round(30 * sc));
        const lh = Math.max(1, Math.round(30 * sc));
        const img = ctx.getImageData(lx, ly, lw, lh).data;
        let yellow = 0;
        for (let i = 0; i < img.length; i += 4) {
            const r = img[i], g = img[i + 1], b = img[i + 2];
            if (r > 180 && g > 120 && b < 110) yellow++;
        }
        return yellow;
    }, [result.target.col, result.target.row]);

    if (out.hoverYellow <= out.beforeYellow) {
        await browser.close();
        console.log("FAIL | número não apareceu no hover (yellow=" + out.hoverYellow + ")" + JSON.stringify(out));
        process.exit(1);
    }

    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    out.afterLeaveYellow = await page.evaluate(([col, row]) => {
        const canvas = document.querySelector("#canvas");
        const ctx = canvas.getContext("2d");
        const lx = Math.max(0, Math.round(x + (col * T + 35) * sc));
        const ly = Math.max(0, Math.round(y + (row * T + 35) * sc));
        const lw = Math.max(1, Math.round(30 * sc));
        const lh = Math.max(1, Math.round(30 * sc));
        const img = ctx.getImageData(lx, ly, lw, lh).data;
        let yellow = 0;
        for (let i = 0; i < img.length; i += 4) {
            const r = img[i], g = img[i + 1], b = img[i + 2];
            if (r > 180 && g > 120 && b < 110) yellow++;
        }
        return yellow;
    }, [result.target.col, result.target.row]);

    await page.mouse.click(result.sx, result.sy);
    await page.waitForTimeout(250);
    out.selectedYellow = await page.evaluate(([col, row]) => {
        const canvas = document.querySelector("#canvas");
        const ctx = canvas.getContext("2d");
        const lx = Math.max(0, Math.round(x + (col * T + 35) * sc));
        const ly = Math.max(0, Math.round(y + (row * T + 35) * sc));
        const lw = Math.max(1, Math.round(30 * sc));
        const lh = Math.max(1, Math.round(30 * sc));
        const img = ctx.getImageData(lx, ly, lw, lh).data;
        let yellow = 0;
        for (let i = 0; i < img.length; i += 4) {
            const r = img[i], g = img[i + 1], b = img[i + 2];
            if (r > 180 && g > 120 && b < 110) yellow++;
        }
        return yellow;
    }, [result.target.col, result.target.row]);

    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    out.selectedAfterLeaveYellow = await page.evaluate(([col, row]) => {
        const canvas = document.querySelector("#canvas");
        const ctx = canvas.getContext("2d");
        const lx = Math.max(0, Math.round(x + (col * T + 35) * sc));
        const ly = Math.max(0, Math.round(y + (row * T + 35) * sc));
        const lw = Math.max(1, Math.round(30 * sc));
        const lh = Math.max(1, Math.round(30 * sc));
        const img = ctx.getImageData(lx, ly, lw, lh).data;
        let yellow = 0;
        for (let i = 0; i < img.length; i += 4) {
            const r = img[i], g = img[i + 1], b = img[i + 2];
            if (r > 180 && g > 120 && b < 110) yellow++;
        }
        return yellow;
    }, [result.target.col, result.target.row]);

    await browser.close();
    if (out.afterLeaveYellow > out.beforeYellow) {
        console.log("FAIL | número permaneceu após sair do espaço" + JSON.stringify(out));
        process.exit(1);
    }
    if (out.selectedYellow <= out.beforeYellow) {
        console.log("FAIL | número não apareceu após selecionar o espaço" + JSON.stringify(out));
        process.exit(1);
    }
    if (out.selectedAfterLeaveYellow <= out.beforeYellow) {
        console.log("FAIL | número do espaço selecionado sumiu após mover o mouse" + JSON.stringify(out));
        process.exit(1);
    }
    console.log("PASS | hover/seleção: hover " + out.hoverYellow + " -> fora " + out.afterLeaveYellow + " -> selecionado " + out.selectedYellow + " -> fora (sel) " + out.selectedAfterLeaveYellow + " (espaço " + out.id + ")");
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });