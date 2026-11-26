// Falha se qualquer arquivo fora de src/adapter/baileys/ importar o Baileys.
// Durante a migração a allowlist abaixo encolhe até ficar vazia.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// provider -> pasta que pode importar a lib em runtime
const RULES = [
    { lib: /^(@whiskeysockets\/baileys|baileys)$/, dir: 'src/adapter/baileys/' },
    { lib: /^(zapo-js|@zapo-js\/.*)$/, dir: 'src/adapter/zapo/' },
];
// `import type` do proto (schema do WhatsApp, apagado na compilação) é permitido aqui.
const TYPE_IMPORT_DIR = 'src/adapter/proto/';
// Arquivos legados que ainda importam a lib. Remover conforme as fases avançam.
const ALLOWLIST = new Set([]);
const IMPORT_RE = /^\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\)/gm;

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (/\.(ts|mts|js|mjs)$/.test(name)) yield p;
    }
}

const offenders = [];
for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
        const isTypeOnly = !!match[1];
        const spec = match[2] ?? match[3] ?? '';
        for (const rule of RULES) {
            if (!rule.lib.test(spec)) continue;
            if (rel.startsWith(rule.dir)) continue;
            if (isTypeOnly && rel.startsWith(TYPE_IMPORT_DIR)) continue;
            offenders.push(`${rel} importa ${spec} (permitido só em ${rule.dir})`);
        }
    }
}

if (offenders.length) {
    console.error('Lib de WhatsApp importada fora do adapter dela:\n  ' + offenders.join('\n  '));
    process.exit(1);
}
console.log(`check:adapter ok (allowlist legado: ${ALLOWLIST.size} arquivo(s))`);
