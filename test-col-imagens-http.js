/* Valida por HTTP que TODAS as imagens do catálogo (100) retornam imagem válida.
   Usa Range para baixar só o início do arquivo e verifica status 2xx + content-type de imagem. */
const { IMAGENS_ANIMAIS } = require("./public/js/imagens-animais.js");

const BROKEN_ANTERIORES = {
    "Caranguejo-eremita": "caranguejo-eremita corrigido (hash MD5)",
    "Geco-leopardo": "geco-leopardo substituído por foto real",
    "Musaranho-elefante": "musaranho-elefante substituído por foto real",
    "Vaquita": "vaquita substituída por foto real (NOAA)",
    "Lula-colossal": "lula-colossal substituída por foto real (Te Papa)"
};

function ehImagem(ct) {
    return /^image\/(jpeg|jpg|png|gif|webp|svg)/i.test(ct || "");
}

async function verificarUrl(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: { "Range": "bytes=0-4096", "User-Agent": "MegaOutdoor-CatalogCheck/1.0" },
            redirect: "follow",
            signal: controller.signal
        });
        const ok = (res.status === 200 || res.status === 206);
        const ct = res.headers.get("content-type") || "";
        return { ok: ok && ehImagem(ct), status: res.status, ct };
    } catch (e) {
        return { ok: false, status: "erro", ct: e.name || e.message };
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function verificarComRetry(url) {
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
        const r = await verificarUrl(url);
        if (r.ok) return r;
        if (r.status === 429 || r.status === 503 || r.status === 502 || r.status === "erro") {
            await sleep(tentativa * 2000);
            continue;
        }
        return r;
    }
    return { ok: false, status: "429-repetido", ct: "rate limit" };
}

(async () => {
    const nomes = Object.keys(IMAGENS_ANIMAIS);
    const resultados = [];
    let passou = 0, falhou = 0;
    const concurrency = 3;
    for (let i = 0; i < nomes.length; i += concurrency) {
        const lote = nomes.slice(i, i + concurrency);
        const resLote = await Promise.all(lote.map(nome => verificarComRetry(IMAGENS_ANIMAIS[nome]).then(r => ({ nome, url: IMAGENS_ANIMAIS[nome], ...r }))));
        for (const r of resLote) {
            if (r.ok) { passou++; resultados.push("PASS | " + r.nome + " (HTTP " + r.status + " " + r.ct + ")"); }
            else { falhou++; resultados.push("FAIL | " + r.nome + " (HTTP " + r.status + " " + r.ct + ") " + r.url); }
        }
        await sleep(1200);
    }
    console.log(resultados.join("\n"));
    console.log("--------------------------------------------------");
    console.log("IMAGENS: " + nomes.length + " verificadas | " + passou + " ok | " + falhou + " quebradas");
    const ausentes = Object.keys(BROKEN_ANTERIORES).filter(nome => !resultados.some(r => r.startsWith("PASS | " + nome)));
    if (ausentes.length) {
        console.log("Ainda quebradas (esperadas corrigidas): " + ausentes.join(", "));
        process.exit(1);
    }
    if (falhou) {
        const quebradas = resultados.filter(r => r.startsWith("FAIL")).map(r => r.split(" (")[0].replace("FAIL | ", ""));
        console.log("Imagens quebradas restantes: " + quebradas.join(", "));
        process.exit(1);
    }
    console.log("ALL PASS | catálogo com imagens válidas (inclusive as 5 corrigidas)");
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });