#!/usr/bin/env node
/**
 * Exporta todos os grupos de um número conectado para CSV, com uma coluna
 * "incluir" em branco para curadoria manual (marque x nas linhas desejadas).
 *
 * Uso:
 *   node scripts/export-groups.mjs --phone <phoneNumberId> [--out arquivo.csv]
 *
 * Opções:
 *   --out <arquivo>   caminho do CSV (default: grupos-<phoneNumberId>.csv na raiz)
 *
 * Credenciais: lê VITE_QR_SERVICE_URL e SUPABASE_SERVICE_ROLE_KEY do .env do repo.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    const envPath = join(REPO_ROOT, ".env");
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
function parseArgs(argv) {
    const args = { phone: null, out: null };
    const takesValue = new Set(["--phone", "--out"]);

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
            case "--out":
                args.out = value;
                break;
            case "--help":
            case "-h":
                usage();
                break;
            default:
                fail(`Opção desconhecida: ${flag} (use --help)`);
        }
    }

    if (!args.phone) usage();
    return args;
}

// ---------------------------------------------------------------- CSV
// Aspas duplas sempre: os nomes têm vírgula, aspas, emoji e quebras de linha.
function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

// ---------------------------------------------------------------- main
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = loadEnv();

    const response = await fetch(`${config.baseUrl}/groups/${args.phone}`, {
        headers: { Authorization: `Bearer ${config.key}` },
    });
    if (response.status === 401) {
        fail("401 do qr-service — SUPABASE_SERVICE_ROLE_KEY do .env não confere com a do serviço");
    }
    let data;
    try {
        data = await response.json();
    } catch {
        fail(`resposta não-JSON do qr-service (HTTP ${response.status})`);
    }
    if (!data.success || !Array.isArray(data.groups)) {
        fail(`falha ao listar grupos: ${data.error ?? "resposta inesperada"}`);
    }

    const groups = [...data.groups].sort((a, b) =>
        String(a.subject).localeCompare(String(b.subject), "pt-BR"),
    );

    const lines = ["incluir,subject,jid,participants"];
    for (const group of groups) {
        lines.push(["", group.subject, group.jid, group.participants].map(csvCell).join(","));
    }

    const outPath = args.out
        ? (args.out.startsWith("/") ? args.out : join(REPO_ROOT, args.out))
        : join(REPO_ROOT, `grupos-${args.phone}.csv`);

    // BOM UTF-8: sem ele o Excel abre os acentos como mojibake
    writeFileSync(outPath, "﻿" + lines.join("\n") + "\n", "utf8");

    console.log(`${groups.length} grupo(s) exportado(s) para ${outPath}`);
    console.log('Marque "x" na coluna "incluir" nas linhas desejadas e salve o arquivo.');
}

main().catch((error) => fail(error.message));
