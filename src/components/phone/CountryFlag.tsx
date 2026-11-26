import { useEffect, useMemo, useState } from "react";
import { Globe } from "lucide-react";
import brazilFlagSvg from "country-flag-icons/string/3x2/BR";
import { cn } from "@/lib/utils";

/**
 * Bandeira SVG do país.
 *
 * O Brasil entra por import estático porque é o padrão do campo e não pode
 * piscar um placeholder a cada abertura do modal. Os outros ~264 países vêm num
 * único chunk carregado sob demanda, só quando o usuário marca "Outro país" e
 * digita um DDI que resolve.
 *
 * O import é do subpath `string/3x2/BR` (markup avulso) e não do componente
 * React `react/3x2/BR`: este reexporta do índice do pacote, então importar um
 * país só arrastava as 265 bandeiras para dentro do bundle principal.
 *
 * Emoji de bandeira foi descartado de propósito: o Chrome no Windows não tem
 * glifo colorido e renderiza as duas letras do país ("BR") em vez do desenho.
 */

type FlagMarkupByIso = Record<string, string>;

let flagsPromise: Promise<FlagMarkupByIso> | null = null;

const loadFlags = (): Promise<FlagMarkupByIso> => {
    flagsPromise ??= import("country-flag-icons/string/3x2").then(
        (mod) => mod as unknown as FlagMarkupByIso,
    );
    return flagsPromise;
};

const toDataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;

interface CountryFlagProps {
    /** ISO 3166-1 alpha-2. null enquanto o DDI digitado não resolve um país. */
    iso2: string | null;
    className?: string;
}

const CountryFlag = ({ iso2, className }: CountryFlagProps) => {
    const [flags, setFlags] = useState<FlagMarkupByIso | null>(null);
    const needsLazyFlags = Boolean(iso2) && iso2 !== "BR";

    useEffect(() => {
        if (!needsLazyFlags || flags) return;
        let active = true;
        loadFlags()
            .then((loaded) => {
                if (active) setFlags(loaded);
            })
            .catch((error) => {
                // Sem bandeira o campo continua utilizável — cai no globo.
                console.error("[CountryFlag] Falha ao carregar as bandeiras:", error);
            });
        return () => {
            active = false;
        };
    }, [needsLazyFlags, flags]);

    const markup = iso2 === "BR" ? brazilFlagSvg : iso2 ? flags?.[iso2] : undefined;
    const src = useMemo(() => (markup ? toDataUri(markup) : null), [markup]);

    if (!src) {
        // Mesma caixa da bandeira (24×16) para nada deslocar quando ela chega.
        return (
            <span className={cn("flex h-4 w-6 shrink-0 items-center justify-center", className)}>
                <Globe className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
        );
    }

    // h-4 w-6 é exatamente o 3:2 do viewBox, então a bandeira não distorce.
    return (
        <img
            src={src}
            alt=""
            aria-hidden="true"
            className={cn("h-4 w-6 shrink-0 rounded-[2px]", className)}
        />
    );
};

export default CountryFlag;
