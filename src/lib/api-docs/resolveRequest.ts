import {
    getAuthProfile,
    QR_SERVICE_BASE,
    type EndpointItem,
    type FieldDoc,
} from "@/data/apiDocsData";
import type { BodyValue, RequestContext, ResolvedHeader, ResolvedRequest } from "./types";

/**
 * Placeholder do QR Service. As duas credenciais que aquele serviço aceita são
 * um JWT de sessão e a service-role key — nenhuma das duas pode ser impressa
 * num exemplo de página pública, então o valor digitado pelo usuário NUNCA é
 * interpolado nas rotas internas, mesmo que ele cole algo no campo.
 */
const QR_TOKEN_PLACEHOLDER = "YOUR_SESSION_TOKEN";
const API_KEY_PLACEHOLDER = "YOUR_API_KEY";

/** Converte o texto digitado no tipo declarado, sem passar por `any`. */
function parseFieldValue(raw: string, type: FieldDoc["type"]): BodyValue {
    const normalized = type.toLowerCase();

    if (normalized.includes("[]") || normalized.includes("array") || normalized.includes("object")) {
        try {
            return JSON.parse(raw) as BodyValue;
        } catch {
            // Usuário ainda está digitando o JSON — manter como texto é melhor
            // que sumir com o campo do exemplo.
            return raw;
        }
    }

    if (normalized.includes("bool")) {
        if (raw === "true") return true;
        if (raw === "false") return false;
        return raw;
    }

    if (normalized.includes("int") || normalized.includes("number")) {
        const n = Number(raw);
        return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
    }

    return raw;
}

const isFileField = (field: FieldDoc): boolean => field.type.toLowerCase() === "file";

/**
 * Resolve URL, headers e corpo de um endpoint UMA vez, para os quatro geradores
 * consumirem prontos.
 *
 * Antes, cada uso remontava isso inline — e era por isso que as rotas do QR
 * Service saíam com `x-api-key`, um header que aquele serviço nem lê. A decisão
 * de autenticação vive aqui e em nenhum outro lugar.
 */
export function resolveRequest(
    endpoint: EndpointItem | null,
    ctx: RequestContext,
): ResolvedRequest {
    if (!endpoint) {
        return {
            method: "GET",
            url: `${ctx.baseUrl}/health`,
            headers: [],
            multipartOnly: false,
            usesQrAuth: false,
        };
    }

    const usesQrAuth = getAuthProfile(endpoint) === "qr-bearer";
    const effectiveBase =
        endpoint.baseUrl === QR_SERVICE_BASE ? ctx.qrServiceUrl : endpoint.baseUrl || ctx.baseUrl;

    let path = endpoint.path;
    for (const param of endpoint.pathParams ?? []) {
        const value =
            ctx.paramValues[`path_${param.name}`] || param.defaultValue || param.name.toUpperCase();
        path = path.replace(`:${param.name}`, value);
    }

    const query: string[] = [];
    for (const param of endpoint.queryParams ?? []) {
        const value = ctx.paramValues[`query_${param.name}`] || param.defaultValue;
        if (value) query.push(`${param.name}=${encodeURIComponent(value)}`);
    }

    const bodyFields = endpoint.bodyFields ?? [];
    const body: Record<string, BodyValue> = {};
    for (const field of bodyFields) {
        if (isFileField(field)) continue;
        const raw = ctx.paramValues[`body_${field.name}`] || field.defaultValue;
        if (raw) body[field.name] = parseFieldValue(raw, field.type);
    }

    const hasBody = Object.keys(body).length > 0;
    const resolvedBody = hasBody ? body : undefined;

    const headers: ResolvedHeader[] = [
        usesQrAuth
            ? { name: "Authorization", value: `Bearer ${QR_TOKEN_PLACEHOLDER}` }
            : { name: "x-api-key", value: ctx.apiKey || API_KEY_PLACEHOLDER },
    ];
    // Content-Type só quando há corpo — um GET não manda Content-Type.
    if (hasBody) headers.push({ name: "Content-Type", value: "application/json" });

    return {
        method: endpoint.method,
        url: effectiveBase + path + (query.length ? `?${query.join("&")}` : ""),
        headers,
        body: resolvedBody,
        multipartOnly: !hasBody && bodyFields.some(isFileField),
        usesQrAuth,
    };
}
