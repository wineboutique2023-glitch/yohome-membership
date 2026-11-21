import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve(".yohome-preview");
const project = "yohome-crm-final-preview";
const api = "http://127.0.0.1:56321";
const windows = process.platform === "win32";
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(result.error?.message || `${command} ${args[0]} failed.`);
  return result.stdout?.trim();
};
const cli = (args, capture = false) => {
  const invocation = ["--yes", "supabase@3.2.0", ...args];
  const opts = { cwd: directory, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" };
  return windows ? run("cmd.exe", ["/d", "/c", "npx", ...invocation], opts) : run("npx", invocation, opts);
};

if (process.env.DOCKER_HOST || !/^(unix|npipe):/.test(run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]))) {
  throw new Error("Switch Docker Desktop to a local context before starting this preview.");
}
mkdirSync(directory, { recursive: true });
const config = join(directory, "supabase", "config.toml");
if (!existsSync(config)) {
  cli(["init"]);
  const original = readFileSync(config, "utf8");
  const configured = original.replace(/^project_id\s*=.*$/m, `project_id = "${project}"`)
    .replace(/\b5432([0-9])\b/g, "5632$1");
  if (!configured.includes(`project_id = "${project}"`) || !/port\s*=\s*56321\b/.test(configured)) {
    throw new Error("The local CLI template has an unexpected project ID or API port.");
  }
  writeFileSync(config, configured);
}
const currentConfig = readFileSync(config, "utf8");
if (!currentConfig.includes(`project_id = "${project}"`) || existsSync(join(directory, "supabase", ".temp", "project-ref"))) {
  throw new Error("Use a fresh unlinked preview folder.");
}
const migrations = join(directory, "supabase", "migrations");
mkdirSync(migrations, { recursive: true });
const fixture = readFileSync("tests/fixtures/crm.sql", "utf8");
const publicSchema = fixture.slice(fixture.indexOf("create table public.members"));
writeFileSync(join(migrations, "20261120000000_synthetic_crm.sql"), publicSchema);
for (const migration of ["20261121000000_gift_cards.sql", "20261121010000_crm_auth_gift_checkout.sql", "20261121020000_preserve_legacy_crm_behaviour.sql"]) {
  copyFileSync(join("supabase", "migrations", migration), join(migrations, migration));
}

try {
  cli(["status", "-o", "env"], true);
} catch {
  cli(["start"]);
}
const status = Object.fromEntries(cli(["status", "-o", "env"], true).split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line);
  return match ? [[match[1], match[2].replace(/^"|"$/g, "")]] : [];
}));
if (!["http://127.0.0.1:56321", "http://localhost:56321"].includes(status.API_URL) ||
    !status.SERVICE_ROLE_KEY || !(status.PUBLISHABLE_KEY || status.ANON_KEY)) {
  throw new Error("The CLI did not report the expected local isolated API.");
}
const sql = (statement) => run("docker", [
  "exec", "-i", `supabase_db_${project}`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
], { input: statement });
const loginFile = join(directory, "preview-accounts.json");
let accounts;
if (existsSync(loginFile)) {
  accounts = JSON.parse(readFileSync(loginFile, "utf8"));
} else {
  accounts = [];
  for (const role of ["owner", "staff"]) {
    const email = `${role}@preview.example.test`;
    const password = randomUUID();
    const response = await fetch(`${api}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: status.SERVICE_ROLE_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const { id } = await response.json();
    if (!response.ok || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Couldn't create the local ${role} account.`);
    accounts.push({ role, email, password, id });
    sql(`insert into gift_private.users(user_id,role,display_name) values ('${id}','${role}','Preview ${role}');`);
  }
  writeFileSync(loginFile, JSON.stringify(accounts, null, 2));
}
sql(`
insert into public.service_items (id,name,normal_price,member_price,staff_pay) values
  ('preview60','Preview 60 min',100,80,30), ('preview90','Preview 90 min',140,110,40),
  ('preview30','Preview 30 min',60,50,20) on conflict do nothing;
insert into gift_private.services (code,name,price) values
  ('preview60','Preview 60 min',10000),('preview90','Preview 90 min',14000),
  ('preview30','Preview 30 min',6000) on conflict do nothing;
insert into public.sales_people(name) values ('Preview Therapist') on conflict do nothing;
insert into gift_private.cards(barcode,status) values ('0000100','stock'),('0000200','stock')
  on conflict do nothing;
`);
console.log("Local preview: http://127.0.0.1:5173");
console.log(`Demo passwords: ${loginFile}`);
const env = {
  ...process.env,
  VITE_SUPABASE_URL: api,
  VITE_SUPABASE_ANON_KEY: status.PUBLISHABLE_KEY || status.ANON_KEY,
  VITE_ENABLE_GIFT_CARDS: "true",
  VITE_TERMS_PDF_URL: "",
};
delete env.VERCEL_ENV;
run(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], { env, stdio: "inherit" });
