#!/usr/bin/env node
/* Configuration-validation tests for the content API.
 *
 * Covers the one place where a wrong server credential must be caught before the
 * school notices: SUPABASE_SERVICE_ROLE_KEY / assertProductionConfig(). Every key
 * below is a fabricated test vector — no real credential exists in this file, and
 * the code under test never echoes a key back, which is asserted here too.
 *
 *   cd tools && node test-config-validation.mjs
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG = "file://" + path.join(ROOT, "api/_lib/config.mjs");
const PORT = 8500 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, pass: false, detail: error?.message || String(error) });
    console.log(` FAIL  ${name} — ${error?.message || error}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* Test vectors. `jwt()` builds a real (unsigned) JWT so the payload decoding path
 * is exercised exactly as production exercises it. */
const b64url = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
const jwt = (claims) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64url({ aud: "auth", iss: "supabase", exp: 1780000000, ...claims })}.ZmFrZXNpZ25hdHVyZQ`;
const SERVICE_JWT = jwt({ role: "service_role", tenant: "testproj" });
const ANON_JWT = jwt({ role: "anon", tenant: "testproj" });
const SB_SECRET = "sb_secret_FabricatedTestVector0000000000000000";
const SB_PUBLISHABLE = "sb_publishable_FabricatedTestVector0000000000000";

/** Runs config.mjs in a fresh process with the given environment and returns its verdict. */
const evaluate = (key) => {
  const script = `
    const { assertProductionConfig, config } = await import(${JSON.stringify(CONFIG)});
    console.log(JSON.stringify({
      problems: assertProductionConfig(),
      normalizedLength: config.supabaseServiceRoleKey.length,
      url: config.supabaseUrl,
    }));
  `;
  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        CMS_DRIVER: "supabase",
        NODE_ENV: "production",
        SUPABASE_URL: "https://fabricated-project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: key,
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(stdout.trim());
};

console.log("\n— which credentials pass the service-role check —");
await check("a valid service_role JWT is accepted", () => {
  const { problems } = evaluate(SERVICE_JWT);
  assert(problems.length === 0, problems.join(" | "));
});
await check("the same key with quotes, spaces, a newline or a Bearer prefix still passes", () => {
  for (const wrapped of [`"${SERVICE_JWT}"`, `  ${SERVICE_JWT}\n`, `Bearer ${SERVICE_JWT}`, SERVICE_JWT.replace(/=/g, "%3D")]) {
    const { problems } = evaluate(wrapped);
    assert(problems.length === 0, `${JSON.stringify(wrapped.slice(0, 12))}… -> ${problems.join(" | ")}`);
  }
});
await check("Supabase's current sb_secret_* key is accepted (it is not a JWT)", () => {
  const { problems } = evaluate(SB_SECRET);
  assert(problems.length === 0, problems.join(" | "));
});
await check("an anon JWT is refused and the message names the role", () => {
  const { problems } = evaluate(ANON_JWT);
  assert(problems.length === 1, `problems: ${JSON.stringify(problems)}`);
  assert(/"anon"/.test(problems[0]), problems[0]);
  assert(/public \(anon\) key/.test(problems[0]), problems[0]);
});
await check("the publishable key is refused", () => {
  const { problems } = evaluate(SB_PUBLISHABLE);
  assert(problems.length === 1 && /sb_publishable_/.test(problems[0]), JSON.stringify(problems));
});
await check("a truncated or unreadable key is refused with a length, not a value", () => {
  const truncated = SERVICE_JWT.slice(0, 40);
  const { problems } = evaluate(truncated);
  assert(problems.length === 1, JSON.stringify(problems));
  assert(/40 characters/.test(problems[0]), problems[0]);
  assert(/neither a decodable service_role JWT nor an sb_secret_ key/.test(problems[0]), problems[0]);
});
await check("a missing key is reported as not set", () => {
  const { problems } = evaluate("");
  assert(problems.length === 1 && /is not set/.test(problems[0]), JSON.stringify(problems));
});
await check("no message ever contains the secret or a piece of it", () => {
  for (const key of [ANON_JWT, SB_PUBLISHABLE, SB_SECRET.slice(0, 20), "garbage-value"]) {
    const { problems } = evaluate(key);
    for (const problem of problems) {
      assert(!problem.includes(key), "message contains the whole key");
      const tail = key.slice(6);
      assert(!tail || !problem.includes(tail), "message contains part of the key");
    }
  }
});
await check("the project URL is normalised (quotes, whitespace, a copied /rest/v1 suffix)", () => {
  for (const value of ['"https://fabricated-project.supabase.co/"', "https://fabricated-project.supabase.co/rest/v1", " https://fabricated-project.supabase.co "]) {
    const script = `const { config } = await import(${JSON.stringify(CONFIG)}); console.log(config.supabaseUrl)`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CMS_DRIVER: "supabase", SUPABASE_URL: value, SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT },
      encoding: "utf8",
    }).trim();
    assert(out === "https://fabricated-project.supabase.co", out);
  }
});

/* ------------------------------------------------------------------ end to end */

const startServer = async (env) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-config-"));
  const server = spawn(process.execPath, [path.join(ROOT, "tools/dev-server.mjs")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      CMS_DRIVER: "supabase",
      CMS_ALLOW_SETUP: "1",
      CMS_LOCAL_DIR: dir,
      SUPABASE_URL: "http://127.0.0.1:1", // deliberately unreachable
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT,
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  server.stderr.on("data", (chunk) => (log += chunk));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/public/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    close: () => {
      server.kill("SIGTERM");
      return fs.rm(dir, { recursive: true, force: true });
    },
    log: () => log,
  };
};

console.log("\n— the endpoints that gate on this check —");
await check("status reports a clean configuration for a real service_role key", async () => {
  const running = await startServer({});
  try {
    const body = await (await fetch(`${BASE}/api/cms/status`)).json();
    assert(body.driver === "supabase", body.driver);
    assert(body.configProblems.length === 0, JSON.stringify(body.configProblems));
    assert(body.setupUnlocked === true, "setup should be unlocked with CMS_ALLOW_SETUP=1");
  } finally {
    await running.close();
  }
});

for (const [label, key, expectation] of [
  ["a valid service_role JWT", SERVICE_JWT, "pass"],
  ["an sb_secret_ key", SB_SECRET, "pass"],
  ["an anon JWT", ANON_JWT, "block"],
  ["a publishable key", SB_PUBLISHABLE, "block"],
]) {
  await check(`login ${expectation === "pass" ? "gets past configuration validation" : "is stopped by configuration validation"} with ${label}`, async () => {
    const running = await startServer({ SUPABASE_SERVICE_ROLE_KEY: key });
    try {
      const response = await fetch(`${BASE}/api/cms/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "teacher@school.edu", password: "whatever-12345" }),
      });
      const body = await response.json();
      const incomplete = /অসম্পূর্ণ/.test(body.message || "");
      if (expectation === "pass") {
        assert(!incomplete, `validation still blocked login: ${body.message}`);
        // Nothing else can work with an unreachable database, and that is the point:
        // the request must fail *after* the config gate, at the database.
        assert(response.status === 503, `expected the database to be reached and fail (503), got ${response.status}: ${body.message}`);
        assert(/ডেটাবেস/.test(body.message), body.message);
      } else {
        assert(response.status === 400 && incomplete, `${response.status} ${body.message}`);
      }
      assert(!JSON.stringify(body).includes(key), "the response echoed the key");
      assert(!running.log().includes(key), "the server log echoed the key");
    } finally {
      await running.close();
    }
  });
}

/* --------------------------------------------------- drivers vs schema.sql */

console.log("\n— what the drivers select must exist in supabase/schema.sql —");
await check("every privileged read column and table is created by the schema", async () => {
  const sql = await fs.readFile(path.join(ROOT, "supabase/schema.sql"), "utf8");
  const tables = new Map();
  const pattern = /create table if not exists (\w+) \(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(pattern)) {
    const columns = match[2]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^(constraint|check|primary key|unique|foreign key)\b/i.test(line))
      .map((line) => line.split(/\s+/)[0]);
    tables.set(match[1], new Set(columns));
  }
  assert(tables.size >= 8, `parsed ${tables.size} tables from schema.sql`);

  const { PRIVILEGED } = await import("file://" + path.join(ROOT, "api/_lib/drivers/supabase.mjs"));
  const offenders = [];
  for (const [table, projections] of Object.entries(PRIVILEGED)) {
    if (!tables.has(table)) {
      offenders.push(`${table} (no such table in schema.sql)`);
      continue;
    }
    for (const column of new Set([...projections.read, ...projections.all])) {
      if (!tables.get(table).has(column)) offenders.push(`${table}.${column}`);
    }
  }
  assert(offenders.length === 0, `drivers read columns the schema never creates: ${offenders.join(", ")}`);
});
await check("no driver still mentions last_seen_at or cms_login_attempts", async () => {
  const files = ["api/_lib/db.mjs", "api/_lib/auth.mjs", "api/_lib/drivers/supabase.mjs", "api/_lib/drivers/local.mjs"];
  const hits = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(ROOT, file), "utf8");
    if (/last_seen_at|cms_login_attempts/.test(text)) hits.push(file);
  }
  assert(hits.length === 0, hits.join(", "));
});

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
