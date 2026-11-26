import { useCallback, useState } from "react";
import { SNIPPET_LANGUAGES, type SnippetLanguage } from "@/lib/api-docs/types";

// Preferência de ferramenta, não credencial — localStorage é apropriado aqui
// (ao contrário da API key, que fica em sessionStorage). Quem escolheu Python
// não quer reescolher a cada endpoint.
const STORAGE_KEY = "echo_api_docs_snippet_lang";

const parseLanguage = (value: string | null): SnippetLanguage =>
    SNIPPET_LANGUAGES.find((lang) => lang === value) ?? "curl";

export function useSnippetLanguage() {
    const [language, setLanguageState] = useState<SnippetLanguage>(() => {
        try {
            return parseLanguage(localStorage.getItem(STORAGE_KEY));
        } catch {
            return "curl";
        }
    });

    const setLanguage = useCallback((next: SnippetLanguage) => {
        setLanguageState(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            /* modo privado / storage cheio — a escolha só não persiste */
        }
    }, []);

    return { language, setLanguage };
}
