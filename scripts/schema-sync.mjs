#!/usr/bin/env node
/**
 * Sincroniza o schema de um projeto Supabase (origem) para outro (destino), só com a
 * Management API (sem senha do banco). Introspecta a origem e gera DDL IDEMPOTENTE e
 * ADITIVA: cria o que falta, alinha colunas/funções/policies/triggers/índices/grants,
 * publication realtime, storage e cron. Nunca apaga tabelas/colunas extras do destino.
 *
 *   node scripts/schema-sync.mjs generate --from <ref> --to <ref> --out sync.sql
 *   node scripts/schema-sync.mjs apply --to <ref> sync.sql
 *
 * `apply` roda bloco a bloco (marcadores `-- @@`), segue em caso de erro e imprime, ao
 * final de cada bloco, os objetos que falharam (tabela public._schema_sync_log, apagada
 * no fim). Comandos de cron com segredo embutido são listados e NÃO aplicados.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readToken() {
    if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
    try {
        return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
    } catch {
        console.error("Access token não encontrado. Defina SUPABASE_ACCESS_TOKEN ou rode `supabase login`.");
        process.exit(1);
    }
}

const token = readToken();

async function query(ref, sql) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
    });
    const text = await res.text();
    if (!res.ok) { let m = text; try { m = JSON.parse(text).message ?? text; } catch { /* cru */ } const e = new Error(m); e.status = res.status; throw e; }
    try { return JSON.parse(text); } catch { return text; }
}

const ident = (s) => /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
const lit = (s) => s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
/** Dollar-quote com tag única, para embutir DDL dentro de EXECUTE. */
const dq = (s) => { let tag = "sync"; let i = 0; while (s.includes(`$${tag}$`)) tag = `sync${++i}`; return `$${tag}$${s}$${tag}$`; };
const pgArray = (s) => (s ?? "{}").replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((r) => r.replace(/^"|"$/g, ""));

/** Envelopa um statement: erro vira linha no log em vez de derrubar o bloco. */
function guarded(block, obj, ddl, fallback) {
    const inner = fallback
        ? `BEGIN EXECUTE ${dq(ddl)}; EXCEPTION WHEN others THEN BEGIN ${fallback} EXCEPTION WHEN others THEN INSERT INTO public._schema_sync_log VALUES (${lit(block)}, ${lit(obj)}, SQLERRM); END; END;`
        : `BEGIN EXECUTE ${dq(ddl)}; EXCEPTION WHEN others THEN INSERT INTO public._schema_sync_log VALUES (${lit(block)}, ${lit(obj)}, SQLERRM); END;`;
    return `DO $g$ ${inner} $g$;`;
}

const LOG_TABLE = `CREATE TABLE IF NOT EXISTS public._schema_sync_log (block text, obj text, err text);
ALTER TABLE public._schema_sync_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._schema_sync_log FROM anon, authenticated;`;

async function generate(from, to, out) {
    const q = (sql) => query(from, sql);
    const sections = [];
    const push = (title, statements) => { if (statements.length) sections.push(`-- @@ ${title}\n${LOG_TABLE}\nSET check_function_bodies = off;\n${statements.join("\n")}\nSELECT block, obj, left(err, 300) AS err FROM public._schema_sync_log WHERE block = ${lit(title)};`); };

    // 1. extensões
    const exts = await q(`select extname, n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where extname not in ('plpgsql')`);
    push("extensoes", exts.map((e) => guarded("extensoes", e.extname, `CREATE EXTENSION IF NOT EXISTS ${ident(e.extname)} WITH SCHEMA ${ident(e.schema)}`)));

    // 2. enums
    const enums = await q(`select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typnamespace='public'::regnamespace group by t.typname order by 1`);
    const enumStmts = [];
    for (const en of enums) {
        const labels = Array.isArray(en.labels) ? en.labels : pgArray(en.labels);
        enumStmts.push(`DO $e$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname=${lit(en.typname)} AND typnamespace='public'::regnamespace) THEN CREATE TYPE public.${ident(en.typname)} AS ENUM (${labels.map(lit).join(", ")}); END IF; END $e$;`);
        for (const l of labels) enumStmts.push(guarded("enums", `${en.typname}.${l}`, `ALTER TYPE public.${ident(en.typname)} ADD VALUE IF NOT EXISTS ${lit(l)}`));
    }
    push("enums", enumStmts);

    // 3. sequences
    const seqs = await q(`select sequencename, data_type from pg_sequences where schemaname='public'`);
    push("sequences", seqs.map((s) => guarded("sequences", s.sequencename, `CREATE SEQUENCE IF NOT EXISTS public.${ident(s.sequencename)} AS ${s.data_type}`)));

    // 4. tabelas e colunas
    const cols = await q(`select c.relname, c.relrowsecurity, c.relforcerowsecurity, a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as def, a.attidentity, a.attgenerated
        from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
        where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and c.relname !~ '^_' order by c.relname, a.attnum`);
    const byTable = new Map();
    for (const r of cols) { if (!byTable.has(r.relname)) byTable.set(r.relname, { rls: r.relrowsecurity, force: r.relforcerowsecurity, cols: [] }); byTable.get(r.relname).cols.push(r); }
    const tableStmts = [];
    for (const [t, info] of byTable) {
        tableStmts.push(`CREATE TABLE IF NOT EXISTS public.${ident(t)} ();`);
        for (const c of info.cols) {
            const isIdentity = c.attidentity === "a" || c.attidentity === "d";
            const isGenerated = c.attgenerated === "s";
            let add = `ALTER TABLE public.${ident(t)} ADD COLUMN IF NOT EXISTS ${ident(c.attname)} ${c.type}`;
            if (isIdentity) add += ` GENERATED ${c.attidentity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
            else if (isGenerated && c.def) add += ` GENERATED ALWAYS AS (${c.def}) STORED`;
            else if (c.def) add += ` DEFAULT ${c.def}`;
            tableStmts.push(guarded("tabelas", `${t}.${c.attname}`, add));
            // tipo divergente → tenta converter
            tableStmts.push(`DO $c$ DECLARE cur text; BEGIN SELECT format_type(atttypid, atttypmod) INTO cur FROM pg_attribute WHERE attrelid='public.${ident(t)}'::regclass AND attname=${lit(c.attname)}; IF cur IS NOT NULL AND cur <> ${lit(c.type)} THEN BEGIN EXECUTE ${dq(`ALTER TABLE public.${ident(t)} ALTER COLUMN ${ident(c.attname)} TYPE ${c.type} USING ${ident(c.attname)}::${c.type}`)}; EXCEPTION WHEN others THEN INSERT INTO public._schema_sync_log VALUES ('tabelas', ${lit(`${t}.${c.attname} tipo ${c.type} (era `)} || cur || ')', SQLERRM); END; END IF; END $c$;`);
            if (!isIdentity && !isGenerated) {
                tableStmts.push(guarded("tabelas", `${t}.${c.attname} default`, c.def ? `ALTER TABLE public.${ident(t)} ALTER COLUMN ${ident(c.attname)} SET DEFAULT ${c.def}` : `ALTER TABLE public.${ident(t)} ALTER COLUMN ${ident(c.attname)} DROP DEFAULT`));
            }
            if (c.attnotnull && !isIdentity) tableStmts.push(guarded("tabelas", `${t}.${c.attname} not null`, `ALTER TABLE public.${ident(t)} ALTER COLUMN ${ident(c.attname)} SET NOT NULL`));
        }
        tableStmts.push(`ALTER TABLE public.${ident(t)} ${info.rls ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`);
        tableStmts.push(`ALTER TABLE public.${ident(t)} ${info.force ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`);
    }
    push("tabelas", tableStmts);

    // 5. constraints (PK/unique antes de FK)
    const cons = await q(`select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where connamespace='public'::regnamespace and conrelid<>0 and contype in ('p','u','c','f','x') and conrelid::regclass::text !~ '^_' order by case contype when 'p' then 1 when 'u' then 2 when 'c' then 3 when 'x' then 4 else 5 end, conrelid::regclass::text, conname`);
    push("constraints", cons.map((c) => `DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=${lit(c.conname)} AND conrelid=${lit(c.tbl)}::regclass) THEN BEGIN EXECUTE ${dq(`ALTER TABLE ${c.tbl} ADD CONSTRAINT ${ident(c.conname)} ${c.def}`)}; EXCEPTION WHEN others THEN INSERT INTO public._schema_sync_log VALUES ('constraints', ${lit(`${c.tbl}.${c.conname}`)}, SQLERRM); END; END IF; END $k$;`));

    // 6. índices (fora os que sustentam constraints)
    const idx = await q(`select i.tablename, i.indexname, i.indexdef from pg_indexes i where i.schemaname='public' and not exists (select 1 from pg_constraint c join pg_class ic on ic.oid=c.conindid where ic.relname=i.indexname and ic.relnamespace='public'::regnamespace) order by 1,2`);
    push("indices", idx.map((i) => guarded("indices", i.indexname, i.indexdef.replace(/^CREATE (UNIQUE )?INDEX /, (m) => `${m}IF NOT EXISTS `))));

    // 7. funções (+ ACL)
    const fns = await q(`select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def, (select string_agg(grantee::regrole::text||':'||privilege_type, ',') from aclexplode(p.proacl)) as acl, p.proacl is null as default_acl
        from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') order by 1`);
    const fnStmts = [];
    for (const f of fns) {
        fnStmts.push(guarded("funcoes", f.sig, f.def, `EXECUTE ${dq(`DROP FUNCTION IF EXISTS ${f.sig} CASCADE`)}; EXECUTE ${dq(f.def)};`));
        if (!f.default_acl) {
            const grants = (f.acl ?? "").split(",").filter(Boolean).map((g) => g.split(":")[0]).filter((r) => ["anon", "authenticated", "service_role", "postgres", "supabase_realtime_admin", "PUBLIC", "-"].includes(r));
            fnStmts.push(guarded("funcoes", `${f.sig} acl`, `REVOKE ALL ON FUNCTION ${f.sig} FROM PUBLIC, anon, authenticated`));
            for (const r of new Set(grants)) if (r !== "-" && r !== "postgres") fnStmts.push(guarded("funcoes", `${f.sig} grant ${r}`, `GRANT EXECUTE ON FUNCTION ${f.sig} TO ${r === "PUBLIC" ? "PUBLIC" : ident(r)}`));
        }
    }
    push("funcoes", fnStmts);

    // 8. views
    const views = await q(`select viewname, definition from pg_views where schemaname='public' order by 1`);
    push("views", views.map((v) => guarded("views", v.viewname, `CREATE OR REPLACE VIEW public.${ident(v.viewname)} AS ${v.definition}`, `EXECUTE ${dq(`DROP VIEW IF EXISTS public.${ident(v.viewname)} CASCADE`)}; EXECUTE ${dq(`CREATE VIEW public.${ident(v.viewname)} AS ${v.definition}`)};`)));

    // 9. triggers (public + auth.users)
    const trg = await q(`select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(t.oid) as def from pg_trigger t where not tgisinternal and (tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace) or tgrelid='auth.users'::regclass) order by 1,2`);
    push("triggers", trg.map((t) => guarded("triggers", `${t.tbl}.${t.tgname}`, t.def.replace(/^CREATE (CONSTRAINT )?TRIGGER /, (m) => m.replace("CREATE ", "CREATE OR REPLACE ")))));

    // 10. policies (public + storage)
    const pols = await q(`select schemaname, tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check from pg_policies where schemaname in ('public','storage') order by 1,2,3`);
    const polStmts = [];
    for (const p of pols) {
        const roles = pgArray(p.roles).map((r) => r === "public" ? "public" : ident(r)).join(", ");
        const create = `CREATE POLICY ${ident(p.policyname)} ON ${ident(p.schemaname)}.${ident(p.tablename)} AS ${p.permissive === "PERMISSIVE" ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${p.cmd} TO ${roles}${p.qual ? ` USING (${p.qual})` : ""}${p.with_check ? ` WITH CHECK (${p.with_check})` : ""}`;
        polStmts.push(guarded("policies", `${p.schemaname}.${p.tablename}.${p.policyname}`, `DROP POLICY IF EXISTS ${ident(p.policyname)} ON ${ident(p.schemaname)}.${ident(p.tablename)}`));
        polStmts.push(guarded("policies", `${p.schemaname}.${p.tablename}.${p.policyname}`, create));
    }
    push("policies", polStmts);

    // 11. grants de tabela/view
    const grants = await q(`select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role') group by 1,2 order by 1,2`);
    const grantStmts = [];
    for (const t of [...byTable.keys(), ...views.map((v) => v.viewname)]) {
        grantStmts.push(guarded("grants", `${t} revoke`, `REVOKE ALL ON TABLE public.${ident(t)} FROM anon, authenticated, service_role`));
        for (const g of grants.filter((g) => g.table_name === t)) grantStmts.push(guarded("grants", `${t} ${g.grantee}`, `GRANT ${g.privs} ON TABLE public.${ident(t)} TO ${ident(g.grantee)}`));
    }
    push("grants", grantStmts);

    // 12. realtime publication
    const pub = await q(`select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'`);
    push("realtime", pub.map((p) => `DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=${lit(p.tablename)}) THEN EXECUTE ${dq(`ALTER PUBLICATION supabase_realtime ADD TABLE public.${ident(p.tablename)}`)}; END IF; END $p$;`));

    // 13. storage buckets
    const buckets = await q(`select id, name, public, file_size_limit, allowed_mime_types::text as mimes from storage.buckets order by 1`);
    push("storage", buckets.map((b) => guarded("storage", b.id, `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${lit(b.id)}, ${lit(b.name)}, ${b.public}, ${b.file_size_limit ?? "NULL"}, ${b.mimes ? `${lit(b.mimes)}::text[]` : "NULL"}) ON CONFLICT (id) DO UPDATE SET public=EXCLUDED.public, file_size_limit=EXCLUDED.file_size_limit, allowed_mime_types=EXCLUDED.allowed_mime_types`)));

    // 14. cron (ref da origem → destino; comando com segredo embutido fica só no relatório)
    const crons = await q(`select jobname, schedule, command, active from cron.job order by jobid`);
    const cronStmts = []; const cronSkipped = [];
    for (const c of crons) {
        const cmd = c.command.replaceAll(from, to);
        if (/eyJ[A-Za-z0-9_-]{20,}|sb_secret_|sb_publishable_/.test(cmd)) { cronSkipped.push(c); continue; }
        cronStmts.push(guarded("cron", c.jobname, `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ${lit(c.jobname)}`));
        cronStmts.push(guarded("cron", c.jobname, `SELECT cron.schedule(${lit(c.jobname)}, ${lit(c.schedule)}, ${lit(cmd)})`));
        if (!c.active) cronStmts.push(guarded("cron", c.jobname, `UPDATE cron.job SET active=false WHERE jobname=${lit(c.jobname)}`));
    }
    push("cron", cronStmts);

    // 15. vault: só os nomes (valores são do destino)
    const vault = await q(`select name, description from vault.secrets order by 1`);

    const header = `-- Gerado por scripts/schema-sync.mjs em ${new Date().toISOString()}\n-- origem ${from} → destino ${to}. Aditivo e idempotente.\n` +
        `-- Vault na origem (criar no destino com os valores DO DESTINO): ${vault.map((v) => v.name).join(", ") || "nenhum"}\n` +
        (cronSkipped.length ? `-- Cron NÃO aplicado (segredo embutido): ${cronSkipped.map((c) => c.jobname).join(", ")}\n` : "");
    const footer = `-- @@ limpeza\nSELECT block, count(*) AS falhas FROM public._schema_sync_log GROUP BY block ORDER BY block;\n-- @@ drop log\nDROP TABLE IF EXISTS public._schema_sync_log;\nSELECT 'ok' AS done;`;
    writeFileSync(out, `${header}\n${sections.join("\n\n")}\n\n${footer}\n`);
    console.error(`✓ ${out}: ${byTable.size} tabelas, ${cols.length} colunas, ${cons.length} constraints, ${idx.length} índices, ${fns.length} funções, ${views.length} views, ${trg.length} triggers, ${pols.length} policies, ${crons.length - cronSkipped.length}/${crons.length} crons, ${buckets.length} buckets, ${pub.length} tabelas realtime`);
    if (cronSkipped.length) console.error(`  crons com segredo (revisar à mão): ${cronSkipped.map((c) => c.jobname).join(", ")}`);
}

async function apply(to, file) {
    const sql = readFileSync(file, "utf8");
    const blocks = []; let title = null; let buf = [];
    for (const line of sql.split("\n")) { const m = line.match(/^--\s*@@\s*(.*)$/); if (m) { if (buf.join("").trim()) blocks.push({ title, sql: buf.join("\n") }); title = m[1].trim(); buf = []; } else buf.push(line); }
    if (buf.join("").trim()) blocks.push({ title, sql: buf.join("\n") });
    let failed = 0;
    for (const b of blocks) {
        const started = Date.now();
        try {
            const rows = await query(to, b.sql);
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            if (Array.isArray(rows) && rows.length) { console.log(`\n── ${b.title} (${secs}s) — ${rows.length} aviso(s)`); for (const r of rows) console.log(`   ${Object.values(r).join(" | ")}`); }
            else console.log(`── ${b.title} (${secs}s) ok`);
        } catch (err) {
            failed++;
            console.error(`\n✗ bloco ${b.title}: HTTP ${err.status ?? "?"} ${err.message.slice(0, 600)}`);
        }
    }
    if (failed) { console.error(`\n${failed} bloco(s) falharam inteiros`); process.exit(1); }
}

const [mode, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const USO = "uso: schema-sync.mjs generate --from REF --to REF --out f.sql | apply --to REF f.sql";
const falha = (msg) => { console.error(`${msg}\n${USO}`); process.exit(2); };
if (mode === "generate") {
    const from = opt("--from"); const to = opt("--to");
    if (!from || !to) falha("generate exige --from <ref> e --to <ref>.");
    await generate(from, to, opt("--out") ?? "schema-sync.sql");
} else if (mode === "apply") {
    const to = opt("--to"); const file = rest.find((a) => a.endsWith(".sql"));
    if (!to) falha("apply exige --to <ref>.");
    if (!file) falha("apply exige o arquivo .sql gerado por `generate`.");
    await apply(to, file);
} else falha("modo desconhecido.");
