import { pairingPhoneSchema } from "@/lib/pairingPhone";
import { findDialPrefix } from "@/lib/countryDialCodes";

/**
 * Composição do telefone a partir do país escolhido no campo, em vez de
 * adivinhado a partir do texto.
 *
 * A convenção antiga do app era: um "+" no começo do que o usuário digitou
 * significa "este número já tem DDI"; sem "+", 10–11 dígitos viram Brasil e
 * ganham o 55 na frente. A convenção está certa (o `normalize_phone()` do banco
 * hoje só tira não-dígitos, justamente porque a decisão de país subiu para a
 * aplicação) — o que faltava era a UI perguntar o país. Com o país explícito,
 * a heurística morre: o DDI vem do campo, nunca do formato do texto.
 *
 * A regra de comprimento do E.164 NÃO é reescrita aqui: `pairingPhoneSchema` já
 * a define (10–15 dígitos, mensagens em português) e uma segunda cópia
 * divergiria — a mesma decisão registrada em `groupParticipantPhone.ts`.
 */

export const BR_DIAL = "55";

/** Teto do E.164. */
const MAX_DIGITS = 15;
/** Nenhum DDI passa de 3 dígitos. */
const MAX_DIAL_DIGITS = 3;
/** DDD + celular com o 9. */
const MAX_BR_NATIONAL_DIGITS = 11;
const MIN_BR_NATIONAL_DIGITS = 10;

export interface PhoneInputState {
    /** false = Brasil (DDI travado em 55); true = o usuário informa o DDI. */
    international: boolean;
    /** Dígitos do DDI. Em modo Brasil é sempre "55". */
    dialCode: string;
    /** Número sem DDI: no Brasil, DDD + número. */
    national: string;
}

export interface PhoneCheck {
    ok: boolean;
    /** Telefone composto (dígitos E.164 sem "+"); vazio quando inválido. */
    phone: string;
    /** Mensagem pronta para exibição; null quando válido. */
    error: string | null;
}

const onlyDigits = (raw: unknown): string => String(raw ?? "").replace(/\D/g, "");

export const emptyPhoneInput = (): PhoneInputState => ({
    international: false,
    dialCode: BR_DIAL,
    national: "",
});

export const sanitizeDialCode = (raw: string): string => onlyDigits(raw).slice(0, MAX_DIAL_DIGITS);

export const sanitizeNational = (raw: string): string => onlyDigits(raw).slice(0, MAX_DIGITS);

/**
 * Número nacional brasileiro a partir do que foi digitado ou colado.
 *
 * O campo antigo ensinava a colar o número completo ("5511999999999"), então
 * colar com o 55 é caso garantido, não hipótese: 12–13 dígitos começando com 55
 * são o número inteiro e o prefixo é removido — senão viraria "5555119...".
 * Um número de 11 dígitos que comece com 55 é o DDD 55 (Santa Maria/RS) e passa
 * intacto, porque nenhum número nacional brasileiro chega a 12 dígitos.
 */
export const sanitizeBrNational = (raw: string): string => {
    const digits = onlyDigits(raw).slice(0, MAX_DIGITS);
    if (digits.startsWith(BR_DIAL) && (digits.length === 12 || digits.length === 13)) {
        return digits.slice(BR_DIAL.length);
    }
    return digits.slice(0, MAX_BR_NATIONAL_DIGITS);
};

/** Dígitos E.164 (sem "+") do estado do campo. Vazio quando falta parte. */
export function composePhoneDigits(state: PhoneInputState): string {
    if (state.international) {
        const dial = sanitizeDialCode(state.dialCode);
        const national = sanitizeNational(state.national);
        if (!dial || !national) return "";
        return (dial + national).slice(0, MAX_DIGITS);
    }

    const national = sanitizeBrNational(state.national);
    if (!national) return "";
    return BR_DIAL + national;
}

/**
 * Caminho inverso: dígitos compostos → estado do campo. Usado quando o valor
 * chega de fora (reset do formulário, prefill de um contato existente).
 */
export function splitPhoneDigits(raw: string): PhoneInputState {
    const digits = onlyDigits(raw).slice(0, MAX_DIGITS);
    if (!digits) return emptyPhoneInput();

    // 55 é o Brasil e nada mais, então nunca cai no modo "outro país" — nem um
    // valor parcial, que senão apareceria como "Outro país · Brasil".
    if (digits.startsWith(BR_DIAL)) {
        return {
            international: false,
            dialCode: BR_DIAL,
            national: sanitizeBrNational(digits.slice(BR_DIAL.length)),
        };
    }

    const dial = findDialPrefix(digits);
    if (dial) return { international: true, dialCode: dial, national: digits.slice(dial.length) };
    return { international: true, dialCode: "", national: digits };
}

/**
 * Valida o campo — nunca lança. `error` é sempre um campo presente (e não um
 * braço de união discriminada) porque o resultado é lido direto dentro do JSX.
 */
export function validatePhoneInput(state: PhoneInputState): PhoneCheck {
    const national = state.international
        ? sanitizeNational(state.national)
        : sanitizeBrNational(state.national);

    if (!national) return { ok: false, phone: "", error: "Informe o número" };

    if (state.international) {
        if (!sanitizeDialCode(state.dialCode)) {
            return { ok: false, phone: "", error: "Informe o código do país (DDI)" };
        }
    } else if (national.length < MIN_BR_NATIONAL_DIGITS || national.length > MAX_BR_NATIONAL_DIGITS) {
        return { ok: false, phone: "", error: "Informe DDD + número (10 ou 11 dígitos)" };
    }

    const result = pairingPhoneSchema.safeParse(composePhoneDigits(state));
    if (result.success) return { ok: true, phone: result.data, error: null };
    return { ok: false, phone: "", error: result.error.issues[0]?.message ?? "Número inválido" };
}

/**
 * Validação a partir dos dígitos compostos, para quem só tem o valor (estado
 * inicial, prefill). Menos preciso que `validatePhoneInput` no meio da
 * digitação, porque o modo do campo é reconstruído por heurística.
 */
export const phoneCheckForDigits = (digits: string): PhoneCheck =>
    validatePhoneInput(splitPhoneDigits(digits));

/** Máscara de exibição do número nacional brasileiro: (11) 99999-9999. */
export function formatBrNational(national: string): string {
    const digits = sanitizeBrNational(national);
    if (digits.length <= 2) return digits;

    const ddd = digits.slice(0, 2);
    const rest = digits.slice(2);
    // O hífen só entra quando o número já cabe inteiro, e sempre a 4 dígitos do
    // fim: assim ele aparece uma vez e não pula de lugar no meio da digitação.
    if (rest.length < 8) return `(${ddd}) ${rest}`;
    return `(${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
}
