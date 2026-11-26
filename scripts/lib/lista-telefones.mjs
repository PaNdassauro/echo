/**
 * Leitura e normalização de listas de telefones, compartilhadas pelos scripts
 * que mexem em grupo (create-group.mjs, bulk-add-group-members.mjs) — mais o
 * acesso ao .env e ao qr-service, que os dois precisam igual.
 *
 * Formatos aceitos:
 *   .xlsx → primeira aba (ou --sheet), primeira linha é o cabeçalho
 *   .csv  → mesmo contrato, via parseCsvRecords
 *   .txt  → um telefone por linha; vazias e começando com "#" são ignoradas
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvRecords } from "./csv.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolve caminho relativo à raiz do repo, não ao cwd de quem chamou. */
export const resolver = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));

export function fail(message) {
    console.error(`Erro: ${message}`);
    process.exit(1);
}

export const COLUNAS_TELEFONE = [
    "telefone", "phone", "numero", "número", "number", "whatsapp", "celular",
];
export const COLUNAS_ROTULO = [
    "nome", "name", "contato", "cliente",
];

// ---------------------------------------------------------------- .env
export function loadEnv() {
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
    return {
        baseUrl: env.VITE_QR_SERVICE_URL.replace(/\/$/, ""),
        key: env.SUPABASE_SERVICE_ROLE_KEY,
        supabaseUrl: env.VITE_SUPABASE_URL?.replace(/\/$/, "") ?? null,
    };
}

// ---------------------------------------------------------------- HTTP
export async function qrFetch(config, path, init = {}) {
    const response = await fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${config.key}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
        },
    });

    if (response.status === 401) {
        fail("401 do qr-service — SUPABASE_SERVICE_ROLE_KEY do .env não confere com a do serviço");
    }
    if (response.status >= 500) {
        // 5xx é problema do serviço, não do grupo: parar e investigar
        fail(`HTTP ${response.status} do qr-service em ${path} — execução interrompida`);
    }

    try {
        return await response.json();
    } catch {
        fail(`resposta não-JSON do qr-service em ${path} (HTTP ${response.status})`);
    }
}

/**
 * Status da sessão no qr-service. Serviço fora do ar conta como sessão
 * indisponível: quem chama tem de parar do mesmo jeito.
 */
export async function statusDaSessao(config, phoneNumberId) {
    const response = await fetch(`${config.baseUrl}/session/status/${phoneNumberId}`, {
        headers: { Authorization: `Bearer ${config.key}` },
    });
    if (response.status === 401) {
        fail("401 do qr-service — SUPABASE_SERVICE_ROLE_KEY do .env não confere com a do serviço");
    }
    try {
        return (await response.json()).status ?? "desconhecido";
    } catch {
        return `sem resposta (HTTP ${response.status})`;
    }
}

// ---------------------------------------------------------------- normalização
/**
 * Normaliza uma entrada da lista em telefone E.164 só com dígitos.
 * Devolve { telefone } ou { erro }.
 */
export function normalizarTelefone(bruto) {
    const texto = String(bruto).trim();

    // Zeros à esquerda saem ANTES de medir: "011999990003" tem 12 dígitos e, sem
    // esta poda, passaria como se já fosse E.164 — virando um telefone que não
    // existe, sem erro nenhum. Vale para o 0 de DDD ("041…") e para o prefixo
    // internacional discado ("00 55…").
    const digitos = texto.replace(/\D/g, "").replace(/^0+/, "");
    if (!digitos) return { erro: "sem dígitos" };

    // "+" (ou o "00" discado) é o país declarado pela própria lista: aí o DDI já
    // veio e a regra brasileira não se aplica. Sem isso, um espanhol de 11
    // dígitos como +34600000005 ganharia um 55 na frente e viraria OUTRA pessoa.
    const ddiExplicito = texto.startsWith("+") || /^00\d/.test(texto.replace(/[\s()-]/g, ""));

    // 10 ou 11 dígitos = nacional brasileiro (DDD + número), falta o DDI.
    // Não tocamos no nono dígito: acrescentar ou remover o 9 por heurística
    // produz um telefone DIFERENTE, e adicionar estranho a grupo é pior que falhar.
    const nacional = !ddiExplicito && (digitos.length === 10 || digitos.length === 11);
    const comDdi = nacional ? `55${digitos}` : digitos;

    // Sem DDI declarado, um número com 12+ dígitos só pode ser E.164 já pronto, e
    // aí o piso de 12 é o que separa "E.164" de "faltou dígito". Com "+" na
    // frente, o piso desce para o mínimo da E.164: um espanhol tem 11 no total.
    const minimo = ddiExplicito ? 8 : 12;
    if (comDdi.length < minimo || comDdi.length > 15) {
        return { erro: `${comDdi.length} dígitos (esperado E.164, ${minimo} a 15)` };
    }
    return { telefone: comDdi };
}

// ---------------------------------------------------------------- leitura
/** Planilha/CSV viram o mesmo { cabecalho, registros } antes da validação. */
function lerTabela(path, raw, sheet) {
    if (/\.csv$/i.test(path)) return parseCsvRecords(raw);

    // xlsx é CommonJS e pesado; só é carregado quando a lista é mesmo .xlsx.
    const { readFile, utils } = createRequire(import.meta.url)("xlsx");
    const wb = readFile(path);
    const nome = sheet ?? wb.SheetNames[0];
    if (!wb.Sheets[nome]) {
        fail(`aba "${nome}" não existe em ${path} (abas: ${wb.SheetNames.join(", ")})`);
    }
    const linhas = utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: "", raw: false });
    const cabecalho = (linhas.shift() ?? []).map((c) => String(c).trim());
    if (cabecalho.length === 0) fail(`aba "${nome}" de ${path} está vazia`);

    const registros = linhas.map((linha) => {
        const registro = {};
        cabecalho.forEach((coluna, i) => { registro[coluna] = String(linha[i] ?? "").trim(); });
        return registro;
    });
    return { cabecalho, registros };
}

/**
 * Lê a lista e devolve entradas já normalizadas e sem repetição:
 *   { entradas: [{ telefone, rotulo, origem }], repetidos, semTelefone: [rotulo] }
 *
 * Valida TUDO antes de devolver: descobrir um telefone inválido no meio de um
 * disparo desperdiça a janela de segurança e deixa a lista pela metade.
 */
export function lerLista(path, { sheet } = {}) {
    const ehTexto = /\.txt$/i.test(path);
    let raw = null;
    if (ehTexto || /\.csv$/i.test(path)) {
        try {
            raw = readFileSync(path, "utf8");
        } catch {
            fail(`lista não encontrada: ${path}`);
        }
    } else if (!/\.xlsx$/i.test(path)) {
        fail(`extensão não suportada em ${path} (use .xlsx, .csv ou .txt)`);
    }

    // Cada bruto vira { valor, rotulo, origem } — origem é a linha, para o erro
    // apontar onde o usuário precisa corrigir.
    const brutos = [];
    const semTelefone = [];

    if (ehTexto) {
        raw.replace(/^﻿/, "").split("\n").forEach((linha, i) => {
            const valor = linha.trim();
            if (!valor || valor.startsWith("#")) return;
            brutos.push({ valor, rotulo: "", origem: `linha ${i + 1}` });
        });
    } else {
        const { cabecalho, registros } = lerTabela(path, raw, sheet);
        const acha = (candidatas) =>
            cabecalho.find((c) => candidatas.includes(c.trim().toLowerCase()));
        const colTelefone = acha(COLUNAS_TELEFONE);
        const colRotulo = acha(COLUNAS_ROTULO);
        if (!colTelefone) {
            fail(`lista sem coluna de telefone (esperado uma de: ${COLUNAS_TELEFONE.join(", ")}). Cabeçalho: ${cabecalho.join(", ")}`);
        }
        registros.forEach((r, i) => {
            const valor = (r[colTelefone] ?? "").trim();
            const rotulo = colRotulo ? (r[colRotulo] ?? "").trim() : "";
            if (!valor) {
                // Linha só com nome não é erro, mas some da operação em silêncio se
                // ninguém contar: quem opera precisa saber quem ficou de fora.
                if (rotulo) semTelefone.push(rotulo);
                return;
            }
            brutos.push({ valor, rotulo, origem: `linha ${i + 2}` });
        });
    }

    if (brutos.length === 0) fail(`nenhum telefone encontrado em ${path}`);

    const invalidos = [];
    const porTelefone = new Map();
    for (const bruto of brutos) {
        const { telefone, erro } = normalizarTelefone(bruto.valor);
        if (erro) {
            invalidos.push(`  ${bruto.origem}: "${bruto.valor}" — ${erro}`);
            continue;
        }
        // Primeira ocorrência ganha; o rótulo de uma repetição só entra se faltava
        const existente = porTelefone.get(telefone);
        if (existente) {
            if (!existente.rotulo && bruto.rotulo) existente.rotulo = bruto.rotulo;
            continue;
        }
        porTelefone.set(telefone, { telefone, rotulo: bruto.rotulo, origem: bruto.origem });
    }

    if (invalidos.length > 0) {
        console.error(`Telefones inválidos em ${path}:\n${invalidos.join("\n")}`);
        fail(`${invalidos.length} telefone(s) inválido(s) — corrija a lista antes de rodar (nada foi enviado)`);
    }

    const repetidos = brutos.length - porTelefone.size;
    return { entradas: [...porTelefone.values()], repetidos, semTelefone };
}
