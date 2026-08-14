/* Teste rápido: validação de aceite das regras no checkout.
   Requer servidor rodando com ALLOW_TEST_MODE=true.
   Uso: node test-acesso.js   (após subir o servidor na porta 3000) */
const BASE = "http://localhost:3000";
const log = [];
function t(nome, cond, extra) {
    log.push((cond ? "PASS" : "FAIL") + " | " + nome + (extra ? " | " + extra : ""));
}

async function main() {
    // 1. Registrar usuário
    const email = "teste-acesso-" + Date.now() + "@teste.com";
    let r = await fetch(BASE + "/api/auth/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Teste Acesso", email, senha: "senha-teste-123" })
    });
    let data = await r.json();
    t("registro usuario", r.status === 200 || r.status === 201, "status=" + r.status);

    // 2. Login
    r = await fetch(BASE + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha: "senha-teste-123" })
    });
    data = await r.json();
    t("login", r.status === 200, "status=" + r.status);
    const token = data.token;
    const auth = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

    // 3. Checkout sem aceite -> deve falhar (400)
    r = await fetch(BASE + "/api/checkout", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
            spaces: [999999],
            name: "Teste Acesso",
            email,
            cpfCnpj: "12345678909",
            paymentMethod: "pix",
            licensePlan: "1_year"
            // sem aceiteRegras
        })
    });
    data = await r.json();
    t("checkout bloqueado sem aceite", r.status === 400 && /aceitar as regras/i.test(data.error || ""), "status=" + r.status + " err=" + (data.error || ""));

    // 4. Checkout com aceite -> deve chegar ao passo de pagamento (falha por MP não configurado ou erro de MP)
    r = await fetch(BASE + "/api/checkout", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
            spaces: [999999],
            name: "Teste Acesso",
            email,
            cpfCnpj: "12345678909",
            paymentMethod: "pix",
            licensePlan: "1_year",
            aceiteRegras: true,
            regrasVisualizadas: true
        })
    });
    data = await r.json();
    // Pode falhar por MP (503/500) mas NÃO deve falhar por aceite (400 de regras)
    const bloqueadoPorAceite = r.status === 400 && /aceitar as regras/i.test(data.error || "");
    t("checkout avanca com aceite", r.status !== 400 || !bloqueadoPorAceite, "status=" + r.status + " err=" + (data.error || "").slice(0, 80));

    // 5. /api/auth/me
    r = await fetch(BASE + "/api/auth/me", { headers: { "Authorization": "Bearer " + token } });
    data = await r.json();
    t("auth/me", r.status === 200 && data.ok, "status=" + r.status);

    console.log(log.join("\n"));
    const fails = log.filter(x => x.startsWith("FAIL")).length;
    console.log("-----------------------------");
    console.log("ACESSO: " + (log.length - fails) + "/" + log.length);
    process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
