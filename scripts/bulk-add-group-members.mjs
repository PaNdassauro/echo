#!/usr/bin/env node
/**
 * Adiciona uma LISTA DE TELEFONES a UM grupo, em lotes, com freio e retomada.
 *
 * Uso:
 *   node scripts/bulk-add-group-members.mjs --phone <phoneNumberId> --group <jid@g.us> --list <arquivo>
 *
 * A lista pode ser:
 *   - .txt   → um telefone por linha, em qualquer formatação; linhas vazias e
 *              linhas começando com "#" são ignoradas
 *   - .csv   → coluna telefone | phone | numero | number | whatsapp | celular
 *              (qualquer caixa); colunas de nome ("nome", "name", "contato", "cliente"), se
 *              existirem, aparecem só nos logs
 *   - .xlsx  → mesmo contrato do .csv, primeira aba
 *   Número sem DDI (10 ou 11 dígitos) recebe 55. O nono dígito NÃO é inventado:
 *   o número vai exatamente como você colou — chutar o 9 gera OUTRO telefone.
 *
 * Opções:
 *   --batch <n>       participantes por chamada (default 5, máx 10). Um pedido com
 *                     5 jids é UMA stanza no WhatsApp em vez de cinco.
 *   --limit <n>       máximo de participantes nesta execução (default 40)
 *   --delay <ms>      pausa MÉDIA entre lotes (default 60000 — NÃO reduza sem motivo).
 *                     Cada pausa varia ±40%: intervalo exato e repetido é assinatura
 *                     óbvia de automação.
 *   --invite-text <t> corpo da mensagem de convite (tem default)
 *   --no-invite       não manda convite a quem tem privacidade fechada; só registra
 *                     o code no state para resolver à mão
 *   --state <arq>     JSON de progresso (default <lista>.state.json); retoma de onde parou
 *   --dry-run         mostra o que seria feito, sem escrever nada
 *
 * PERIGO: `add` em grupo é o vetor que o anti-abuso do WhatsApp mais vigia. Já
 * 5 adds em 5 minutos derrubaram uma linha com
 * `<stream:error code="401"><conflict/>` — penalidade do WhatsApp, não queda de
 * infra — e o serviço NÃO reconecta sozinho nesse caso (401 == loggedOut), então a
 * linha fica fora do ar até alguém reconectar à mão. Por isso o script confere a
 * sessão antes de cada lote e aborta ao primeiro sinal de throttle: insistir agrava.
 * Se cair, espere horas, não minutos. Vetor mais seguro para listas grandes:
 * `GET /groups/:phone/:groupJid/invite-code` e a pessoa entra sozinha pelo link.
 *
 * Credenciais: lê VITE_QR_SERVICE_URL, SUPABASE_SERVICE_ROLE_KEY e (opcional, só
 * para conferir se a linha é admin) VITE_SUPABASE_URL do .env do repo.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    fail,
    lerLista,
    loadEnv,
    normalizarTelefone,
    qrFetch,
    resolver,
    statusDaSessao,
} from "./lib/lista-telefones.mjs";

// Reexportado porque o teste exercita a normalização por este módulo.
export { normalizarTelefone };

// Aborta depois desta quantidade de lotes com falha seguida: insistir sob throttle
// do WhatsApp é exatamente o que transforma lentidão em bloqueio.
const MAX_FALHAS_SEGUIDAS = 3;

// Variação aplicada ao --delay, para os intervalos não formarem um padrão fixo.
const JITTER = 0.4;

// Teto do --batch. Acima disso o pedido fica grande e um erro contamina gente
// demais de uma vez — o ganho de juntar stanzas já se esgotou.
const BATCH_MAX = 10;

// Pausa entre convites dentro de um mesmo lote: são mensagens de verdade saindo.
const DELAY_CONVITE = 2000;

const INVITE_TEXT_DEFAULT = "Oi! Segue o convite para o nosso grupo no WhatsApp 😊";

// Buckets que não são retentados numa próxima execução.
const RESOLVIDOS = new Set(["ok", "ja_estava", "convite_enviado", "nao_whatsapp"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage() {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Reaproveita o bloco de comentário do topo como texto de ajuda
    console.log(header.slice(header.indexOf("/**"), header.indexOf("*/") + 2));
    process.exit(1);
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
    const args = {
        phone: null, group: null, list: null,
        batch: 5, limit: 40, delay: 60000,
        inviteText: INVITE_TEXT_DEFAULT, invite: true,
        state: null, dryRun: false,
    };
    const takesValue = new Set([
        "--phone", "--group", "--list", "--batch", "--limit", "--delay", "--invite-text", "--state",
    ]);

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        let value = null;
        if (takesValue.has(flag)) {
            value = argv[++i];
            if (value === undefined) fail(`${flag} exige um valor`);
        }

        switch (flag) {
            case "--phone": args.phone = value; break;
            case "--group": args.group = value; break;
            case "--list": args.list = value; break;
            case "--state": args.state = value; break;
            case "--no-invite": args.invite = false; break;
            case "--dry-run": args.dryRun = true; break;
            case "--invite-text": {
                if (!value.trim()) fail("--invite-text não pode ser vazio");
                args.inviteText = value.trim();
                break;
            }
            case "--batch": {
                const n = Number(value);
                if (!Number.isInteger(n) || n <= 0 || n > BATCH_MAX) {
                    fail(`--batch inválido: "${value}" (inteiro de 1 a ${BATCH_MAX})`);
                }
                args.batch = n;
                break;
            }
            case "--limit": {
                const n = Number(value);
                if (!Number.isInteger(n) || n <= 0) fail(`--limit inválido: "${value}"`);
                args.limit = n;
                break;
            }
            case "--delay": {
                const ms = Number(value);
                if (!Number.isFinite(ms) || ms < 0) fail(`--delay inválido: "${value}"`);
                args.delay = ms;
                break;
            }
            case "--help":
            case "-h": usage(); break;
            default: fail(`Opção desconhecida: ${flag} (use --help)`);
        }
    }

    if (!args.phone || !args.group || !args.list) usage();
    if (!args.group.endsWith("@g.us")) fail(`--group deve terminar em @g.us (recebeu "${args.group}")`);

    if (!args.state) args.state = args.list.replace(/\.(xlsx|csv|txt)$/i, "") + ".state.json";
    return args;
}

// ---------------------------------------------------------------- state
function carregarEstado(path) {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        fail(`state file corrompido: ${path} (apague-o para recomeçar do zero)`);
    }
}

// Grava a cada lote, não no fim: a sessão Baileys cai com frequência e o progresso
// precisa sobreviver a uma queda no meio da execução.
function gravarEstado(path, estado) {
    writeFileSync(path, JSON.stringify(estado, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------- HTTP
// A sessão é conferida antes de CADA lote: numa execução de horas a sessão
// Baileys pode cair no meio, e insistir com ela fora do ar só produz erro em
// série — que o WhatsApp lê como comportamento de bot.
async function metadataDoGrupo(config, phone, groupJid) {
    // ?picture=0: a foto não interessa aqui e custa uma consulta a mais
    const data = await qrFetch(config, `/groups/${phone}/${encodeURIComponent(groupJid)}?picture=0`);
    if (!data.success || !data.group) {
        fail(`não foi possível ler o grupo ${groupJid}: ${data.error ?? "resposta inesperada"}`);
    }
    return data.group;
}

/**
 * Telefone da própria linha, para saber se ela é admin do grupo. O qr-service não
 * expõe o número da sessão, então vem do banco — e é opcional: sem ele, o script
 * só perde a checagem prévia de admin, e o primeiro 403 conta a mesma história.
 */
async function telefoneDaLinha(config, phoneNumberId) {
    if (!config.supabaseUrl) return null;
    const filtro = UUID_RE.test(phoneNumberId)
        ? `id=eq.${phoneNumberId}`
        : `phone_number_id=eq.${encodeURIComponent(phoneNumberId)}`;
    try {
        const response = await fetch(
            `${config.supabaseUrl}/rest/v1/phone_numbers?${filtro}&select=phone_number,display_name`,
            { headers: { Authorization: `Bearer ${config.key}`, apikey: config.key } },
        );
        if (!response.ok) return null;
        const [linha] = await response.json();
        if (!linha?.phone_number) return null;
        return { telefone: linha.phone_number.replace(/\D/g, ""), nome: linha.display_name };
    } catch {
        return null;
    }
}

async function adicionar(config, phone, groupJid, telefones) {
    return qrFetch(config, `/groups/${phone}/${encodeURIComponent(groupJid)}/participants`, {
        method: "POST",
        body: JSON.stringify({ participants: telefones }),
    });
}

async function mandarConvite(config, phone, groupJid, convite, texto) {
    return qrFetch(config, `/groups/${phone}/${encodeURIComponent(groupJid)}/invite-message`, {
        method: "POST",
        body: JSON.stringify({
            jid: convite.jid,
            code: convite.code,
            expiration: convite.expiration,
            text: texto,
        }),
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pausa em torno da média, nunca o mesmo valor duas vezes seguidas
const pausaComJitter = (media) =>
    Math.round(media * (1 - JITTER + Math.random() * JITTER * 2));

// ---------------------------------------------------------------- classificação
/**
 * O serviço devolve `details` e `inviteRequired` chaveados pelo telefone que ele
 * extraiu da resposta do WhatsApp — que pode vir por @lid e não bater dígito a
 * dígito com o que mandamos. Casa pelo fim do número antes de desistir.
 */
function casarComLote(chave, lote) {
    if (lote.includes(chave)) return chave;
    const cauda = chave.slice(-8);
    if (cauda.length === 8) {
        const candidatos = lote.filter((t) => t.endsWith(cauda));
        if (candidatos.length === 1) return candidatos[0];
    }
    return null;
}

/**
 * Traduz a resposta de um lote num desfecho por telefone.
 * `abortavel` distingue o que pode ser throttle/penalidade do WhatsApp (e deve
 * interromper a execução se repetir) do que é definitivo daquele telefone.
 */
export function classificarLote(data, lote) {
    const porTelefone = new Map();
    const convites = new Map();
    const orfaos = [];

    for (const convite of data.inviteRequired ?? []) {
        const telefone = casarComLote(convite.phone, lote);
        if (!telefone) {
            orfaos.push(`convite para ${convite.phone}, que não está neste lote`);
            continue;
        }
        porTelefone.set(telefone, { bucket: "convite_pendente", detalhe: `privacidade fechada (code ${convite.code})` });
        convites.set(telefone, convite);
    }

    for (const [chave, mensagem] of Object.entries(data.details ?? {})) {
        const telefone = casarComLote(chave, lote);
        if (!telefone) {
            orfaos.push(`"${mensagem}" para ${chave}, que não está neste lote`);
            continue;
        }
        porTelefone.set(telefone, classificarMensagem(mensagem));
    }

    // Quem o serviço não mencionou: entrou (success) ou herdou o erro geral do lote
    for (const telefone of lote) {
        if (porTelefone.has(telefone)) continue;
        porTelefone.set(
            telefone,
            data.success
                ? { bucket: "ok", detalhe: "adicionado" }
                : classificarMensagem(data.error ?? "erro desconhecido"),
        );
    }

    return { porTelefone, convites, orfaos };
}

function classificarMensagem(mensagem) {
    const texto = String(mensagem).toLowerCase();

    if (texto.includes("409") || texto.includes("já é participante") || texto.includes("already")) {
        return { bucket: "ja_estava", detalhe: "já estava no grupo" };
    }
    if (texto.includes("408") || texto.includes("não existe no whatsapp")) {
        return { bucket: "nao_whatsapp", detalhe: "número não existe no WhatsApp" };
    }
    if (texto.includes("not connected") || texto.includes("session not found")) {
        return { bucket: "sessao", detalhe: mensagem };
    }
    // 403 aqui NÃO é "não sou admin": isso foi conferido antes de começar. Num grupo
    // em que a linha é admin, 403/not-authorized é a cara da penalidade de anti-abuso
    // (o groupParticipantsUpdate passa a responder not-authorized) — tem de abortar.
    if (texto.includes("403") || texto.includes("not-authorized") || texto.includes("sem permissão")) {
        return {
            bucket: "falhou",
            detalhe: `${mensagem} — possível penalidade do WhatsApp na linha`,
            abortavel: true,
        };
    }
    return { bucket: "falhou", detalhe: String(mensagem), abortavel: true };
}

// ---------------------------------------------------------------- main
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = loadEnv();

    const listPath = resolver(args.list);
    const statePath = resolver(args.state);

    const { entradas, repetidos, semTelefone } = lerLista(listPath);
    const estado = carregarEstado(statePath);

    // ---------- pré-checagem: uma vez, antes de qualquer add
    // Em --dry-run tudo aqui é aviso, não erro: validar o arquivo de telefones não
    // pode depender de ter uma sessão viva na mão.
    const impedir = args.dryRun
        ? (mensagem) => { console.log(`Aviso: ${mensagem}`); return false; }
        : (mensagem) => fail(mensagem);

    const status = await statusDaSessao(config, args.phone);
    if (status !== "connected") {
        impedir(`sessão de ${args.phone} está "${status}", não "connected". Reconecte o número antes de rodar.`);
    }

    const grupo = status === "connected"
        ? await metadataDoGrupo(config, args.phone, args.group)
        : { subject: "(grupo não consultado)", participants: [] };
    const linha = await telefoneDaLinha(config, args.phone);

    // Quem já está no grupo não gasta tentativa nem um --delay inteiro
    const jaDentro = new Set();
    for (const p of grupo.participants ?? []) {
        if (p.phone) jaDentro.add(String(p.phone).replace(/\D/g, ""));
    }

    let marcados = 0;
    for (const entrada of entradas) {
        if (jaDentro.has(entrada.telefone) && !estado[entrada.telefone]) {
            estado[entrada.telefone] = {
                bucket: "ja_estava",
                detalhe: "já estava no grupo (conferido no metadata)",
                rotulo: entrada.rotulo || entrada.telefone,
            };
            marcados++;
        }
    }
    if (marcados > 0 && !args.dryRun) gravarEstado(statePath, estado);

    // Admin: se a linha não pode adicionar, TODO add vai voltar 403 e três seguidos
    // abortariam a execução como se fosse penalidade. Melhor falhar aqui, claro.
    if (linha && status === "connected") {
        const eu = (grupo.participants ?? []).find((p) => String(p.phone ?? "").replace(/\D/g, "") === linha.telefone);
        if (!eu) {
            impedir(`a linha ${linha.nome} (${linha.telefone}) não aparece entre os participantes de "${grupo.subject}"`);
        } else if (!(eu.isAdmin || eu.isSuperAdmin || grupo.memberAddMode === true)) {
            impedir(
                `a linha ${linha.nome} (${linha.telefone}) não é admin de "${grupo.subject}" e o grupo só deixa admin adicionar. ` +
                `Promova a linha, ou use o link de convite (GET /groups/${args.phone}/<jid>/invite-code).`,
            );
        }
    } else if (!linha) {
        console.log("Aviso: não deu para confirmar se a linha é admin (sem VITE_SUPABASE_URL ou linha não encontrada).");
    }

    // ---------- fila desta execução
    const pendentes = entradas.filter((e) => !RESOLVIDOS.has(estado[e.telefone]?.bucket));
    const fila = pendentes.slice(0, args.limit);
    const lotes = [];
    for (let i = 0; i < fila.length; i += args.batch) lotes.push(fila.slice(i, i + args.batch));

    const rotulo = (e) => (e.rotulo ? `${e.rotulo} (${e.telefone})` : e.telefone);

    console.log(`Lista: ${listPath}`);
    console.log(`Grupo: "${grupo.subject}" · ${grupo.participants?.length ?? 0} participante(s)`);
    if (linha) console.log(`Linha: ${linha.nome} (${linha.telefone})`);
    console.log(
        `Telefones: ${entradas.length}${repetidos > 0 ? ` (${repetidos} repetido(s) descartado(s))` : ""} · ` +
        `já resolvidos: ${entradas.length - pendentes.length} · pendentes: ${pendentes.length}`,
    );
    if (semTelefone.length > 0) {
        console.log(`Sem telefone na lista (${semTelefone.length}, ficam de fora): ${semTelefone.join(", ")}`);
    }
    console.log(
        `Nesta execução: ${fila.length} em ${lotes.length} lote(s) de até ${args.batch} ` +
        `(limite ${args.limit}, ~${args.delay}ms entre lotes)\n`,
    );

    if (fila.length === 0) {
        console.log("Nada a fazer — todos os telefones da lista já foram resolvidos.");
        return;
    }

    if (args.dryRun) {
        lotes.forEach((lote, i) => {
            console.log(`  [dry-run] lote ${i + 1}: ${lote.map(rotulo).join(", ")}`);
        });
        const minutos = Math.round(((lotes.length - 1) * args.delay) / 60000);
        console.log(`\nNada foi alterado (--dry-run). A execução real levaria ~${minutos} min.`);
        return;
    }

    // ---------- disparo
    const contagem = { ok: 0, ja_estava: 0, convite_enviado: 0, convite_pendente: 0, nao_whatsapp: 0, falhou: 0 };
    const problemas = [];
    let falhasSeguidas = 0;

    for (const [i, lote] of lotes.entries()) {
        const prefixo = `[lote ${i + 1}/${lotes.length}]`;
        const telefones = lote.map((e) => e.telefone);

        const statusAgora = await statusDaSessao(config, args.phone);
        if (statusAgora !== "connected") {
            gravarEstado(statePath, estado);
            console.error(`\n${prefixo} NÃO executado.`);
            fail(
                `sessão de ${args.phone} está "${statusAgora}", não "connected". ` +
                `Execução interrompida com ${contagem.ok} adição(ões) feita(s); progresso em ${statePath}. ` +
                `Se o motivo foi conflict/401, é penalidade do WhatsApp: espere horas antes de reconectar e insistir.`,
            );
        }

        const data = await adicionar(config, args.phone, args.group, telefones);
        const { porTelefone, convites, orfaos } = classificarLote(data, telefones);

        for (const aviso of orfaos) console.log(`${prefixo} aviso: ${aviso}`);

        // Sessão caiu no meio do lote: parar agora, o resto da fila falharia igual
        const caiu = [...porTelefone.values()].find((r) => r.bucket === "sessao");
        if (caiu) {
            gravarEstado(statePath, estado);
            fail(`${prefixo} ${caiu.detalhe}. Reconecte o número e rode de novo (o progresso está em ${statePath}).`);
        }

        // Convite: manda o card a quem tem privacidade fechada, um a um
        if (args.invite) {
            for (const [telefone, convite] of convites) {
                await sleep(DELAY_CONVITE);
                const resposta = await mandarConvite(config, args.phone, args.group, convite, args.inviteText);
                porTelefone.set(
                    telefone,
                    resposta.success
                        ? { bucket: "convite_enviado", detalhe: "convite enviado (privacidade fechada)" }
                        : { bucket: "convite_pendente", detalhe: `convite NÃO enviado: ${resposta.error ?? "erro desconhecido"} (code ${convite.code})` },
                );
            }
        }

        let abortavelNoLote = false;
        for (const entrada of lote) {
            const { bucket, detalhe, abortavel } = porTelefone.get(entrada.telefone);
            estado[entrada.telefone] = { bucket, detalhe, rotulo: entrada.rotulo || entrada.telefone };
            contagem[bucket]++;
            if (abortavel) abortavelNoLote = true;
            if (bucket !== "ok" && bucket !== "ja_estava") problemas.push({ entrada, detalhe });
            console.log(`${prefixo} ${rotulo(entrada)}… ${detalhe}`);
        }
        gravarEstado(statePath, estado);

        if (abortavelNoLote) {
            falhasSeguidas++;
            if (falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
                console.error(`\nAbortado: ${MAX_FALHAS_SEGUIDAS} lotes seguidos com falha — provável throttle/penalidade do WhatsApp.`);
                console.error(`Progresso salvo em ${statePath}. Espere algumas horas antes de tentar de novo.`);
                process.exit(1);
            }
        } else {
            falhasSeguidas = 0;
        }

        if (i < lotes.length - 1 && args.delay > 0) await sleep(pausaComJitter(args.delay));
    }

    console.log(
        `\nResumo: ${contagem.ok} ok · ${contagem.ja_estava} já estava · ` +
        `${contagem.convite_enviado} convite enviado · ${contagem.convite_pendente} convite pendente · ` +
        `${contagem.nao_whatsapp} sem WhatsApp · ${contagem.falhou} falhou`,
    );
    for (const { entrada, detalhe } of problemas) {
        console.log(`  ✗ ${rotulo(entrada)} — ${detalhe}`);
    }

    const restantes = pendentes.length - fila.length;
    if (restantes > 0) console.log(`\nFaltam ${restantes} telefone(s) — rode de novo mais tarde.`);
    if (contagem.falhou > 0) process.exit(1);
}

// Só dispara quando chamado direto: `normalizarTelefone` e `classificarLote` são
// a lógica que vale testar isoladamente, e importar o módulo não pode adicionar
// ninguém a grupo nenhum.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => fail(error.message));
}
