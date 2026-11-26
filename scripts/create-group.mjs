#!/usr/bin/env node
/**
 * Cria UM grupo de WhatsApp, vazio, numa linha conectada ao qr-service.
 *
 * Uso:
 *   node scripts/create-group.mjs --phone <phoneNumberId> --name "<assunto>"
 *
 * Opções:
 *   --dry-run   confere a sessão e mostra o que faria, sem criar nada
 *
 * O grupo nasce só com a própria linha dentro, de propósito: adicionar gente é
 * o vetor que o anti-abuso do WhatsApp mais vigia (uma sequência
 * de adds já derrubou uma linha com `401 conflict`, e o serviço NÃO reconecta
 * sozinho nesse caso). Separar os dois passos deixa a lista revisável no meio e
 * o passo perigoso sob o freio do bulk-add-group-members.mjs, que faz lotes com
 * pausa, confere a sessão a cada lote e sabe retomar de onde parou:
 *
 *   node scripts/bulk-add-group-members.mjs --phone <id> --group <jid> --list <arquivo>
 *
 * Credenciais: VITE_QR_SERVICE_URL e SUPABASE_SERVICE_ROLE_KEY do .env do repo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fail, loadEnv, qrFetch, statusDaSessao } from "./lib/lista-telefones.mjs";

// Limite do WhatsApp para o assunto do grupo.
const NAME_MAX = 100;

function usage() {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(header.slice(header.indexOf("/**"), header.indexOf("*/") + 2));
    process.exit(1);
}

function parseArgs(argv) {
    const args = { phone: null, name: null, dryRun: false };
    const takesValue = new Set(["--phone", "--name"]);

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        let value = null;
        if (takesValue.has(flag)) {
            value = argv[++i];
            if (value === undefined) fail(`${flag} exige um valor`);
        }

        switch (flag) {
            case "--phone": args.phone = value; break;
            case "--name": args.name = value.trim(); break;
            case "--dry-run": args.dryRun = true; break;
            case "--help":
            case "-h": usage(); break;
            default: fail(`Opção desconhecida: ${flag} (use --help)`);
        }
    }

    if (!args.phone || !args.name) usage();
    if (args.name.length > NAME_MAX) {
        fail(`--name tem ${args.name.length} caracteres; o WhatsApp aceita até ${NAME_MAX}`);
    }
    return args;
}

/** Grupo homônimo já existente na linha — não impede nada, mas tem de aparecer. */
async function homonimos(config, phone, nome) {
    const data = await qrFetch(config, `/groups/${phone}`);
    if (!data.success || !Array.isArray(data.groups)) return [];
    const alvo = nome.toLowerCase().replace(/\s+/g, " ");
    return data.groups.filter((g) => String(g.subject ?? "").toLowerCase().replace(/\s+/g, " ") === alvo);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = loadEnv();

    const status = await statusDaSessao(config, args.phone);
    if (status !== "connected") {
        fail(`sessão de ${args.phone} está "${status}", não "connected". Reconecte o número antes de rodar.`);
    }

    console.log(`Linha:  ${args.phone} (connected)`);
    console.log(`Grupo:  "${args.name}"`);

    // Criar grupo é barato mas não tem desfazer bonito: sair de um grupo criado
    // por engano deixa rastro para todo mundo que já estiver dentro.
    for (const g of await homonimos(config, args.phone, args.name)) {
        console.log(`Aviso:  já existe um grupo com esse nome nesta linha — ${g.id}`);
    }

    if (args.dryRun) {
        console.log("\nNada foi criado (--dry-run).");
        return;
    }

    const data = await qrFetch(config, `/groups/${args.phone}/create`, {
        method: "POST",
        body: JSON.stringify({ name: args.name, participants: [] }),
    });

    if (!data.success || !data.groupJid) {
        fail(`grupo não criado: ${data.error ?? "resposta inesperada do qr-service"}`);
    }

    console.log(`\nCriado: ${data.groupJid}`);

    const convite = await qrFetch(
        config,
        `/groups/${args.phone}/${encodeURIComponent(data.groupJid)}/invite-code`,
    );
    if (convite.success && convite.inviteUrl) {
        console.log(`Convite: ${convite.inviteUrl}`);
    }

    console.log(
        `\nPara adicionar os participantes:\n` +
        `  node scripts/bulk-add-group-members.mjs \\\n` +
        `    --phone ${args.phone} \\\n` +
        `    --group ${data.groupJid} \\\n` +
        `    --list <arquivo> --dry-run`,
    );
}

main().catch((error) => fail(error.message));
