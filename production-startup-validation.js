const fs = require("fs");

const EXPECTED_DATA_DIR = "/var/lib/megaoutdoor/data";
const EXPECTED_UPLOAD_DIR = "/var/lib/megaoutdoor/uploads";
const EXPECTED_PERSISTENT_ROOT = "/var/lib/megaoutdoor";

function isProduction(env) {
    const render = String(env.RENDER || "").toLowerCase();
    return env.NODE_ENV === "production" || render === "true" || render === "1";
}

function isValidProductionDatabaseUrl(value) {
    if (!value || !String(value).trim()) return false;
    try {
        const url = new URL(String(value));
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) return false;
        return !['localhost', '127.0.0.1', '::1', 'memoria'].includes(url.hostname.toLowerCase());
    } catch (error) {
        return false;
    }
}

function assertDirectory(fsImpl, directory, label) {
    try {
        if (!fsImpl.existsSync(directory) || !fsImpl.statSync(directory).isDirectory()) {
            throw new Error(`Diretório ${directory} ausente ou inválido.`);
        }
        fsImpl.accessSync(directory, fsImpl.constants.R_OK | fsImpl.constants.W_OK);
    } catch (error) {
        throw new Error(`Startup bloqueado: ${label} não está disponível: ${directory}.`);
    }
}

function validateProductionEnvironment(env = process.env, fsImpl = fs) {
    if (!isProduction(env)) return { production: false };

    if (String(env.RESET_DATA || "").toLowerCase() === "true") {
        throw new Error("Startup bloqueado: RESET_DATA=true não é permitido em produção.");
    }
    if (!isValidProductionDatabaseUrl(env.DATABASE_URL)) {
        throw new Error("Startup bloqueado: DATABASE_URL não configurada ou inválida para produção.");
    }
    if (env.DATA_DIR !== EXPECTED_DATA_DIR) {
        throw new Error("Startup bloqueado: DATA_DIR não aponta para o armazenamento persistente de produção.");
    }
    if (env.UPLOAD_DIR !== EXPECTED_UPLOAD_DIR) {
        throw new Error("Startup bloqueado: UPLOAD_DIR não aponta para o armazenamento persistente de produção.");
    }
    if (String(env.ALLOW_TEST_MODE || "").toLowerCase() === "true") {
        throw new Error("Startup bloqueado: ALLOW_TEST_MODE=true não é permitido em produção.");
    }
    if (String(env.MERCADOPAGO_SANDBOX || "").toLowerCase() === "true") {
        throw new Error("Startup bloqueado: MERCADOPAGO_SANDBOX=true não é permitido em produção.");
    }

    assertDirectory(fsImpl, EXPECTED_PERSISTENT_ROOT, "o disco persistente");
    assertDirectory(fsImpl, EXPECTED_DATA_DIR, "DATA_DIR");
    assertDirectory(fsImpl, EXPECTED_UPLOAD_DIR, "UPLOAD_DIR");
    return { production: true };
}

module.exports = {
    EXPECTED_DATA_DIR,
    EXPECTED_UPLOAD_DIR,
    EXPECTED_PERSISTENT_ROOT,
    isProduction,
    isValidProductionDatabaseUrl,
    validateProductionEnvironment
};
