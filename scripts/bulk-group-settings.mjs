#!/usr/bin/env node
/**
 * Altera configurações de TODOS os grupos (ou um subconjunto) de um número
 * conectado, via endpoints por-grupo do qr-service (requer imagem >= 1.3.4).
 *
 * Uso:
 *   node scripts/bulk-group-settings.mjs --phone <phoneNumberId> [opções]
 *
 * Configurações (aplica só as que forem passadas):
 *   --announce on|off        só admins enviam mensagens
 *   --restrict on|off        só admins editam dados do grupo
 *   --member-add on|off      só admins adicionam membros
 *   --join-approval on|off   aprovação de entrada por admin
 *   --ephemeral 0|86400|604800|7776000   mensagens temporárias (segundos)
 *
 * Controle:
 *   --groups jid1,jid2   aplica só nestes grupos (default: todos)
 *   --exclude jid1,jid2  pula estes grupos
 *   --dry-run            mostra o que seria feito, sem escrever nada
 *   --delay <ms>         pausa entre grupos (default 600)
 *
 * Credenciais: lê VITE_QR_SERVICE_URL e SUPABASE_SERVICE_ROLE_KEY do .env do repo.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EPHEMERAL_VALUES = ["0", "86400", "604800", "7776000"];

function fail(message) {
    console.error(`Erro: ${message}`);
    process.exit(1);
}

function usage() {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Reaproveita o bloco de comentário do topo como texto de ajuda
    console.log(header.slice(header.indexOf("/**"), header.indexOf("*/") + 2));
    process.exit(1);
}

// ---------------------------------------------------------------- .env
function loadEnv() {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
    let raw;
    try {
        raw = readFileSync(envPath, "utf8");
    } catch {
        fail(`.env não encontrado em ${envPath}`);
    }
    const env = {};
    for (const line of raw.split("\n")) {
        const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2\s*$/);
        if (match) env[match[1]] = match[3];
    }
    if (!env.VITE_QR_SERVICE_URL) fail("VITE_QR_SERVICE_URL ausente no .env");
    if (!env.SUPABASE_SERVICE_ROLE_KEY) fail("SUPABASE_SERVICE_ROLE_KEY ausente no .env");
    return { baseUrl: env.VITE_QR_SERVICE_URL.replace(/\/$/, ""), key: env.SUPABASE_SERVICE_ROLE_KEY };
}

// ---------------------------------------------------------------- CLI
function parseOnOff(flag, value) {
    if (value !== "on" && value !== "off") fail(`${flag} aceita apenas on|off (recebeu "${value}")`);
    return value === "on";
}

function parseArgs(argv) {
    const args = {
        phone: null,
        groups: null,
        exclude: [],
        dryRun: false,
        delay: 600,
        changes: [],
    };
    const takesValue = new Set([
        "--phone", "--groups", "--exclude", "--delay",
        "--announce", "--restrict", "--member-add", "--join-approval", "--ephemeral",
    ]);

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        let value = null;
        if (takesValue.has(flag)) {
            value = argv[++i];
            if (value === undefined) fail(`${flag} exige um valor`);
        }

        switch (flag) {
            case "--phone":
                args.phone = value;
                break;
            case "--groups":
                args.groups = value.split(",").map((s) => s.trim()).filter(Boolean);
                break;
            case "--exclude":
                args.exclude = value.split(",").map((s) => s.trim()).filter(Boolean);
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--delay": {
                const ms = Number(value);
                if (!Number.isFinite(ms) || ms < 0) fail(`--delay inválido: "${value}"`);
                args.delay = ms;
                break;
            }
            case "--announce": {
                const on = parseOnOff(flag, value);
                args.changes.push({
                    label: `só admins enviam: ${value}`,
                    path: "settings",
                    body: { setting: on ? "announcement" : "not_announcement" },
                });
                break;
            }
            case "--restrict": {
                const on = parseOnOff(flag, value);
                args.changes.push({
                    label: `só admins editam: ${value}`,
                    path: "settings",
                    body: { setting: on ? "locked" : "unlocked" },
                });
                break;
            }
            case "--member-add": {
                const on = parseOnOff(flag, value);
                args.changes.push({
                    label: `só admins adicionam: ${value}`,
                    path: "member-add-mode",
                    body: { mode: on ? "admin_add" : "all_member_add" },
                });
                break;
            }
            case "--join-approval": {
                parseOnOff(flag, value);
                args.changes.push({
                    label: `aprovação de entrada: ${value}`,
                    path: "join-approval",
                    body: { mode: value },
                });
                break;
            }
            case "--ephemeral": {
                if (!EPHEMERAL_VALUES.includes(value)) {
                    fail(`--ephemeral aceita apenas ${EPHEMERAL_VALUES.join("|")} (recebeu "${value}")`);
                }
                args.changes.push({
                    label: `mensagens temporárias: ${value}s`,
                    path: "ephemeral",
                    body: { expiration: Number(value) },
                });
                break;
            }
            case "--help":
            case "-h":
                usage();
                break;
            default:
                fail(`Opção desconhecida: ${flag} (use --help)`);
        }
    }

    if (!args.phone) usage();
    if (args.changes.length === 0) fail("passe pelo menos uma configuração (--announce, --restrict, --member-add, --join-approval ou --ephemeral)");
    for (const jid of [...(args.groups ?? []), ...args.exclude]) {
        if (!jid.endsWith("@g.us")) fail(`jid inválido (esperado ...@g.us): ${jid}`);
    }
    return args;
}

// ---------------------------------------------------------------- HTTP
async function request(config, method, path, body) {
    const response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${config.key}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404) {
        fail(`404 em ${path} — o qr-service precisa estar na imagem 1.3.4 ou superior`);
    }
    if (response.status === 401) {
        fail("401 do qr-service — SUPABASE_SERVICE_ROLE_KEY do .env não confere com a do serviço");
    }
    let data;
    try {
        data = await response.json();
    } catch {
        fail(`resposta não-JSON de ${path} (HTTP ${response.status})`);
    }
    return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- main
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = loadEnv();

    const listing = await request(config, "GET", `/groups/${args.phone}`);
    if (!listing.success || !Array.isArray(listing.groups)) {
        fail(`falha ao listar grupos: ${listing.error ?? "resposta inesperada"}`);
    }

    let groups = listing.groups;
    if (args.groups) {
        const wanted = new Set(args.groups);
        groups = groups.filter((g) => wanted.has(g.jid));
        const found = new Set(groups.map((g) => g.jid));
        for (const jid of wanted) {
            if (!found.has(jid)) console.warn(`Aviso: ${jid} não está entre os grupos do número — ignorado`);
        }
    }
    if (args.exclude.length > 0) {
        const excluded = new Set(args.exclude);
        groups = groups.filter((g) => !excluded.has(g.jid));
    }

    if (groups.length === 0) fail("nenhum grupo para processar após os filtros");

    const changesLabel = args.changes.map((c) => c.label).join(" · ");
    console.log(`${groups.length} grupo(s) · mudanças: ${changesLabel}\n`);

    if (args.dryRun) {
        for (const group of groups) {
            console.log(`  [dry-run] ${group.subject}  (${group.jid})`);
        }
        console.log("\nNada foi alterado (--dry-run).");
        return;
    }

    const failures = [];
    let okCount = 0;

    for (const [index, group] of groups.entries()) {
        const prefix = `[${index + 1}/${groups.length}] ${group.subject}`;
        const errors = [];

        for (const change of args.changes) {
            const data = await request(
                config,
                "PATCH",
                `/groups/${args.phone}/${encodeURIComponent(group.jid)}/${change.path}`,
                change.body,
            );
            if (!data.success) errors.push(`${change.label} → ${data.error ?? "erro desconhecido"}`);
        }

        if (errors.length === 0) {
            okCount++;
            console.log(`${prefix}… ok`);
        } else {
            failures.push({ group, errors });
            console.log(`${prefix}… FALHOU (${errors.join("; ")})`);
        }

        if (index < groups.length - 1 && args.delay > 0) await sleep(args.delay);
    }

    console.log(`\nResumo: ${okCount}/${groups.length} ok, ${failures.length} com falha`);
    if (failures.length > 0) {
        for (const { group, errors } of failures) {
            console.log(`  ✗ ${group.subject} (${group.jid})`);
            for (const error of errors) console.log(`      ${error}`);
        }
        process.exit(1);
    }
}

main().catch((error) => fail(error.message));
