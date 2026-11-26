/**
 * Utilitários de CSV compartilhados pelos scripts de operação.
 *
 * Parser mínimo, suficiente para o formato que export-groups.mjs escreve
 * (células entre aspas duplas, aspas internas duplicadas) e tolerante a
 * arquivos reeditados no Excel/LibreOffice, onde células simples saem sem aspas.
 */

function parseCsv(raw) {
    const linhas = [];
    let campo = "";
    let linha = [];
    let dentroDeAspas = false;

    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (dentroDeAspas) {
            if (c === '"') {
                if (raw[i + 1] === '"') { campo += '"'; i++; }
                else dentroDeAspas = false;
            } else campo += c;
            continue;
        }
        if (c === '"') dentroDeAspas = true;
        else if (c === ",") { linha.push(campo); campo = ""; }
        else if (c === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = ""; }
        else if (c !== "\r") campo += c;
    }
    if (campo || linha.length > 0) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

/** Lê o CSV como array de objetos, usando a primeira linha como cabeçalho. */
export function parseCsvRecords(raw) {
    // Remove o BOM que nós mesmos escrevemos (e que o Excel preserva ao salvar)
    const linhas = parseCsv(raw.replace(/^﻿/, ""));
    const cabecalho = linhas.shift();
    if (!cabecalho) return { cabecalho: [], registros: [] };

    const registros = [];
    for (const linha of linhas) {
        if (linha.length === 1 && linha[0].trim() === "") continue; // linha em branco no fim
        const registro = {};
        cabecalho.forEach((coluna, i) => { registro[coluna.trim()] = linha[i] ?? ""; });
        registros.push(registro);
    }
    return { cabecalho, registros };
}
