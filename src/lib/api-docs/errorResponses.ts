import { getAuthProfile, type AuthProfile, type EndpointItem } from "@/data/apiDocsData";

/**
 * Corpos de erro REAIS, por perfil de autenticação.
 *
 * Antes o painel inventava `{error:true, status, message}`, que não é o formato
 * de nenhum dos dois serviços. Os valores abaixo saem literalmente do código:
 * echo-api devolve `{error, message?}` (e `{success:false, error}` no catch-all
 * de 500 — assimetria real, mantida de propósito); o qr-service tem mensagens
 * próprias porque é outro serviço.
 */
const API_KEY_ERRORS: Record<number, string> = {
    400: format({ error: "Bad request" }),
    401: format({ error: "Invalid API key" }),
    403: format({
        error: "API key not associated with an organization",
        message:
            "This API key needs to be regenerated with an organization scope. Please create a new API key in Settings.",
    }),
    404: format({ error: "Resource not found" }),
    405: format({ error: "Method not allowed" }),
    409: format({ error: "Conflict" }),
    500: format({ success: false, error: "Erro interno. Tente novamente." }),
    502: format({ error: "QR service unreachable" }),
};

const QR_BEARER_ERRORS: Record<number, string> = {
    400: format({ error: "Bad request" }),
    401: format({ error: "Missing bearer token" }),
    403: format({ error: "You do not have access to this phone number" }),
    404: format({ error: "Phone number not found" }),
    500: format({ error: "Internal error" }),
};

const PROFILE_ERRORS: Record<AuthProfile, Record<number, string>> = {
    "api-key": API_KEY_ERRORS,
    "qr-bearer": QR_BEARER_ERRORS,
};

function format(value: Record<string, unknown>): string {
    return JSON.stringify(value, null, 2);
}

/**
 * Corpo a exibir para um status. Precedência: override do endpoint → padrão do
 * perfil de auth → descrição declarada, como último recurso.
 */
export function resolveErrorBody(endpoint: EndpointItem, status: number): string {
    const declared = endpoint.responses?.find((r) => r.status === status);
    if (declared?.body) return declared.body;

    const byProfile = PROFILE_ERRORS[getAuthProfile(endpoint)][status];
    if (byProfile) return byProfile;

    return format({ error: declared?.description ?? "Error" });
}

/** Um status é de sucesso? Usado para escolher entre `response` e corpo de erro. */
export const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;
