const assert = require("assert");
const { spawnSync } = require("child_process");
const {
    EXPECTED_DATA_DIR,
    EXPECTED_UPLOAD_DIR,
    EXPECTED_PERSISTENT_ROOT,
    isStarterBootstrap,
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

/* =========================
   BOOTSTRAP TEMPORÁRIO (RENDER_STARTER_BOOTSTRAP)
   A chave só libera as checagens de DISCO; as demais
   proteções continuam valendo. Sem a chave, nada muda.
========================= */

const bootstrapEnv = {
    NODE_ENV: "production",
    RENDER: "true",
    RENDER_STARTER_BOOTSTRAP: "true",
    DATABASE_URL: "postgres://db.example.invalid:5432/mega",
    DATA_DIR: "C:/data",
    UPLOAD_DIR: "C:/uploads",
    ALLOW_TEST_MODE: "false",
    MERCADOPAGO_SANDBOX: "false"
};

/* 1. Bootstrap permite startup SEM disco persistente e com DATA_DIR/UPLOAD_DIR errados */
assert.deepStrictEqual(
    validateProductionEnvironment(bootstrapEnv, fakeFs({ missing: [EXPECTED_PERSISTENT_ROOT, EXPECTED_DATA_DIR, EXPECTED_UPLOAD_DIR] })),
    { production: true, starterBootstrap: true }
);
console.log("PASS | bootstrap permite startup sem disco persistente");

/* 2. Bootstrap NÃO libera ALLOW_TEST_MODE */
assert.throws(() => validateProductionEnvironment({ ...bootstrapEnv, ALLOW_TEST_MODE: "true" }, fakeFs()), /ALLOW_TEST_MODE/);
console.log("PASS | bootstrap não libera ALLOW_TEST_MODE");

/* 3. Bootstrap NÃO libera sandbox do Mercado Pago */
assert.throws(() => validateProductionEnvironment({ ...bootstrapEnv, MERCADOPAGO_SANDBOX: "true" }, fakeFs()), /MERCADOPAGO_SANDBOX/);
console.log("PASS | bootstrap não libera sandbox do Mercado Pago");

/* 4. Bootstrap NÃO libera RESET_DATA */
assert.throws(() => validateProductionEnvironment({ ...bootstrapEnv, RESET_DATA: "true" }, fakeFs()), /RESET_DATA/);
console.log("PASS | bootstrap não libera RESET_DATA");

/* 5. Bootstrap continua exigindo DATABASE_URL válida */
assert.throws(() => validateProductionEnvironment({ ...bootstrapEnv, DATABASE_URL: "postgres://memoria" }, fakeFs()), /DATABASE_URL/);
console.log("PASS | bootstrap continua exigindo DATABASE_URL válida");

/* 6. Sem a chave temporária, a proteção original bloqueia o startup */
assert.throws(
    () => validateProductionEnvironment({ ...bootstrapEnv, RENDER_STARTER_BOOTSTRAP: "false" }, fakeFs()),
    /DATA_DIR/
);
assert.throws(
    () => validateProductionEnvironment({ ...bootstrapEnv, RENDER_STARTER_BOOTSTRAP: undefined }, fakeFs()),
    /DATA_DIR/
);
console.log("PASS | sem a chave temporária, proteção original volta a valer");

/* 7. A chave exige produção + Render juntos */
assert.strictEqual(isStarterBootstrap({ NODE_ENV: "production", RENDER: "true", RENDER_STARTER_BOOTSTRAP: "true" }), true);
assert.strictEqual(isStarterBootstrap({ NODE_ENV: "production", RENDER: "1", RENDER_STARTER_BOOTSTRAP: "true" }), true);
assert.strictEqual(isStarterBootstrap({ NODE_ENV: "development", RENDER: "true", RENDER_STARTER_BOOTSTRAP: "true" }), false);
assert.strictEqual(isStarterBootstrap({ NODE_ENV: "production", RENDER: "false", RENDER_STARTER_BOOTSTRAP: "true" }), false);
assert.strictEqual(isStarterBootstrap({ NODE_ENV: "production", RENDER: "true", RENDER_STARTER_BOOTSTRAP: "false" }), false);
assert.strictEqual(isStarterBootstrap({ NODE_ENV: "production", RENDER: "true" }), false);
console.log("PASS | chave exige NODE_ENV=production + RENDER=true + RENDER_STARTER_BOOTSTRAP=true");

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
