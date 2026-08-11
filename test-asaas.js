require("dotenv").config();

const apiKey = process.env.ASAAS_API_KEY;

if (!apiKey) {
    console.error("ERRO: ASAAS_API_KEY não foi encontrada no arquivo .env");
    process.exit(1);
}

async function testar() {
    try {
        const response = await fetch(
            "https://api-sandbox.asaas.com/v3/customers?limit=1",
            {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    "access_token": apiKey
                }
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Asaas respondeu HTTP " + response.status);
            console.error(data);
            process.exit(1);
        }

        console.log("======================================");
        console.log(" CONEXAO COM ASAAS SANDBOX: OK");
        console.log(" HTTP:", response.status);
        console.log(" Clientes encontrados:", data.totalCount ?? 0);
        console.log("======================================");
        console.log("A chave NÃO foi exibida.");

    } catch (error) {
        console.error("ERRO AO CONECTAR AO ASAAS:");
        console.error(error.message);
        process.exit(1);
    }
}

testar();