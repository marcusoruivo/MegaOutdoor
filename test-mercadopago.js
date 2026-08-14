require("dotenv").config();

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

if (!accessToken) {
    console.error("ERRO: MERCADOPAGO_ACCESS_TOKEN não foi encontrado no arquivo .env");
    process.exit(1);
}

const sandbox = accessToken.startsWith("TEST-");
const apiBase = "https://api.mercadopago.com";

async function testar() {
    try {
        const response = await fetch(
            `${apiBase}/v1/payment_methods`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${accessToken}`
                }
            }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            console.error("Mercado Pago respondeu HTTP " + response.status);
            console.error(data);
            process.exit(1);
        }

        const pix = data.find(m => m.id === "pix");

        console.log("======================================");
        console.log(" CONEXAO COM MERCADO PAGO: OK");
        console.log(" HTTP:", response.status);
        console.log(" Ambiente:", sandbox ? "SANDBOX" : "PRODUCAO");
        console.log(" Pix disponível:", pix ? "SIM" : "NAO");
        console.log("======================================");
        console.log("O Access Token NAO foi exibido.");

    } catch (error) {
        console.error("ERRO AO CONECTAR AO MERCADO PAGO:");
        console.error(error.message);
        process.exit(1);
    }
}

testar();
