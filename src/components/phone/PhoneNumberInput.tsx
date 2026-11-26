import { useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import CountryFlag from "@/components/phone/CountryFlag";
import { countryName, isoFromDial } from "@/lib/countryDialCodes";
import {
    BR_DIAL,
    PhoneCheck,
    PhoneInputState,
    composePhoneDigits,
    emptyPhoneInput,
    formatBrNational,
    sanitizeBrNational,
    sanitizeDialCode,
    sanitizeNational,
    splitPhoneDigits,
    validatePhoneInput,
} from "@/lib/phoneInput";
import { cn } from "@/lib/utils";

/**
 * Campo de telefone com país explícito.
 *
 * O valor que entra e sai é sempre o telefone COMPOSTO em dígitos E.164 sem "+"
 * — o mesmo formato que `conversations.contact_phone`, as edge functions e o
 * `validateParticipantPhone` já esperam. Assim o componente é drop-in nos campos
 * que antes pediam "DDI + DDD + número" num input só, sem mexer na validação de
 * quem o usa.
 *
 * O estado interno (país / DDI / nacional) é a fonte da verdade enquanto o
 * usuário digita: o valor composto não é decomponível sem ambiguidade no meio da
 * digitação ("5511" seria Brasil incompleto ou algum outro país?). O prop só
 * volta a mandar quando muda por fora — reset do formulário ou prefill.
 */

interface PhoneNumberInputProps {
    /** Dígitos compostos (E.164 sem "+"). */
    value: string;
    /**
     * Recebe o valor composto e a validação já feita com o modo do campo — quem
     * usa não precisa readivinhar se aquilo é brasileiro para escolher a
     * mensagem de erro certa.
     */
    onChange: (digits: string, check: PhoneCheck) => void;
    /** Enter em qualquer um dos campos. */
    onSubmit?: () => void;
    /** Mensagem de erro do chamador; exibida só quando há algo digitado. */
    error?: string | null;
    disabled?: boolean;
    autoFocus?: boolean;
    /** Id do input do número, para casar com o <Label> de fora. */
    id?: string;
    className?: string;
}

const PhoneNumberInput = ({
    value,
    onChange,
    onSubmit,
    error,
    disabled,
    autoFocus,
    id,
    className,
}: PhoneNumberInputProps) => {
    const [state, setState] = useState<PhoneInputState>(() => splitPhoneDigits(value));
    const lastEmitted = useRef(composePhoneDigits(state));
    const dialInputRef = useRef<HTMLInputElement | null>(null);
    const generatedId = useId();
    const nationalId = id ?? `phone-national-${generatedId}`;
    const errorId = `${nationalId}-error`;

    // Só re-deriva quando o valor mudou por fora (reset/prefill). Sem isso, o
    // arredondamento do nosso próprio onChange sobrescreveria o que está sendo
    // digitado.
    useEffect(() => {
        if (value === lastEmitted.current) return;
        lastEmitted.current = value;
        setState(value ? splitPhoneDigits(value) : emptyPhoneInput());
    }, [value]);

    const emit = (next: PhoneInputState) => {
        setState(next);
        const digits = composePhoneDigits(next);
        lastEmitted.current = digits;
        onChange(digits, validatePhoneInput(next));
    };

    const iso = state.international ? isoFromDial(state.dialCode) : "BR";
    const country = state.international ? countryName(iso) : "";
    const hasInput = Boolean(state.national);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" && onSubmit) {
            event.preventDefault();
            onSubmit();
        }
    };

    const toggleInternational = (checked: boolean) => {
        if (checked) {
            emit({ international: true, dialCode: "", national: sanitizeNational(state.national) });
            // O DDI é o único campo vazio depois do toggle — levar o cursor até ele.
            requestAnimationFrame(() => dialInputRef.current?.focus());
            return;
        }
        emit({ international: false, dialCode: BR_DIAL, national: sanitizeBrNational(state.national) });
    };

    return (
        <div className={cn("space-y-2", className)}>
            <div className="flex items-stretch gap-2">
                {/* Segmento do país: mesma caixa nos dois modos, para o layout não pular no toggle. */}
                <div
                    className={cn(
                        "flex h-10 w-[104px] shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 ring-offset-background transition-[border-color,box-shadow] duration-100 ease-out focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                        disabled && "cursor-not-allowed opacity-50",
                    )}
                >
                    <CountryFlag iso2={iso} />
                    {/* "+" colado no código, como se lê um telefone: +55, +351. */}
                    <div className="flex min-w-0 flex-1 items-center">
                        <span className="text-base text-muted-foreground md:text-sm">+</span>
                        {state.international ? (
                            <input
                                ref={dialInputRef}
                                value={state.dialCode}
                                onChange={(event) =>
                                    emit({ ...state, dialCode: sanitizeDialCode(event.target.value) })
                                }
                                onKeyDown={handleKeyDown}
                                disabled={disabled}
                                type="tel"
                                inputMode="numeric"
                                autoComplete="tel-country-code"
                                aria-label="Código do país (DDI)"
                                placeholder="34"
                                className="w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
                            />
                        ) : (
                            <span className="text-base text-foreground md:text-sm">{BR_DIAL}</span>
                        )}
                    </div>
                </div>

                <Input
                    id={nationalId}
                    value={state.international ? state.national : formatBrNational(state.national)}
                    onChange={(event) =>
                        emit(
                            state.international
                                ? { ...state, national: sanitizeNational(event.target.value) }
                                : { ...state, national: sanitizeBrNational(event.target.value) },
                        )
                    }
                    onKeyDown={handleKeyDown}
                    disabled={disabled}
                    autoFocus={autoFocus}
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    placeholder={state.international ? "612345678" : "(11) 99999-9999"}
                    aria-invalid={Boolean(error) && hasInput}
                    aria-describedby={error && hasInput ? errorId : undefined}
                    className="flex-1"
                />
            </div>

            <label
                className={cn(
                    "flex w-fit items-center gap-2 text-xs text-muted-foreground",
                    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                )}
            >
                <Checkbox
                    checked={state.international}
                    onCheckedChange={(checked) => toggleInternational(checked === true)}
                    disabled={disabled}
                />
                Outro país
                {country && <span className="text-foreground">· {country}</span>}
            </label>

            {error && hasInput && (
                <p id={errorId} className="text-xs text-destructive">
                    {error}
                </p>
            )}
        </div>
    );
};

export default PhoneNumberInput;
