const assert = require("assert");
const { spawnSync } = require("child_process");
const {
    EXPECTED_DATA_DIR,
    EXPECTED_UPLOAD_DIR,
    EXPECTED_PERSISTENT_ROOT,
    isValidProductionDatabaseUrl,
    validateProductionEnvironment
} = require("./production-startup-validation");

const validEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://db.example.invalid:5432/mega",
    DATA_DIR: EXPECTED_DATA_DIR,
    UPLOAD_DIR: EXPECTED_UPLOAD_DIR,
    ALLOW_TEST_MODE: "false",
    MERCADOPAGO_SANDBOX: "false"
};

function fakeFs(options = {}) {
    const present = new Set(options.missing || []);
    return {
        constants: { R_OK: 4, W_OK: 2 },
        existsSync: p => !present.has(p),
        statSync: () => ({ isDirectory: () => true }),
        accessSync: () => {}
    };
}

function mustBlock(name, mutate, expected) {
    const env = { ...validEnv };
    mutate(env);
    assert.throws(() => validateProductionEnvironment(env, fakeFs()), new RegExp(expected));
    console.log("PASS | " + name);
}

mustBlock("RESET_DATA=true bloqueia", e => { e.RESET_DATA = "true"; }, "RESET_DATA=true");
mustBlock("DATABASE_URL ausente bloqueia", e => { delete e.DATABASE_URL; }, "DATABASE_URL");
mustBlock("DATABASE_URL inválida bloqueia", e => { e.DATABASE_URL = "not-a-database"; }, "DATABASE_URL");
mustBlock("DATA_DIR incorreto bloqueia", e => { e.DATA_DIR = "C:/data"; }, "DATA_DIR");
mustBlock("UPLOAD_DIR incorreto bloqueia", e => { e.UPLOAD_DIR = "C:/uploads"; }, "UPLOAD_DIR");
assert.throws(
    () => validateProductionEnvironment(validEnv, fakeFs({ missing: [EXPECTED_PERSISTENT_ROOT] })),
    /disco persistente/
);
console.log("PASS | disco persistente ausente bloqueia");
mustBlock("ALLOW_TEST_MODE=true bloqueia", e => { e.ALLOW_TEST_MODE = "true"; }, "ALLOW_TEST_MODE");
mustBlock("Mercado Pago Sandbox bloqueia", e => { e.MERCADOPAGO_SANDBOX = "true"; }, "MERCADOPAGO_SANDBOX");

assert.deepStrictEqual(validateProductionEnvironment(validEnv, fakeFs()), { production: true });
assert.strictEqual(validateProductionEnvironment({ NODE_ENV: "development" }, fakeFs()).production, false);
assert.strictEqual(isValidProductionDatabaseUrl(validEnv.DATABASE_URL), true);
assert.strictEqual(isValidProductionDatabaseUrl("postgres://memoria"), false);
console.log("PASS | configuração válida permite startup");
console.log("PASS | desenvolvimento permanece permitido");
console.log("PASS | URL pg-mem rejeitada em produção");

const cleanup = spawnSync(process.execPath, ["limpar-dados-teste.js", "--apply"], {
    cwd: __dirname,
    encoding: "utf8",
    env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: validEnv.DATABASE_URL,
        DATA_DIR: EXPECTED_DATA_DIR,
        UPLOAD_DIR: EXPECTED_UPLOAD_DIR
    }
});
assert.notStrictEqual(cleanup.status, 0);
assert.match(cleanup.stderr, /Limpeza bloqueada/);
console.log("PASS | limpar-dados-teste --apply bloqueado em produção");
