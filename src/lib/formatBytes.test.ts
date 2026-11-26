import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
    it("devolve null quando não há tamanho conhecido", () => {
        // null faz o chamador OMITIR a linha, em vez de escrever "0 B".
        expect(formatBytes(null)).toBeNull();
        expect(formatBytes(undefined)).toBeNull();
        expect(formatBytes(0)).toBeNull();
        expect(formatBytes(-1)).toBeNull();
    });

    it("usa bytes abaixo de 1 KB", () => {
        expect(formatBytes(1)).toBe("1 B");
        expect(formatBytes(1023)).toBe("1023 B");
    });

    it("usa KB até 1 MB, com vírgula decimal", () => {
        expect(formatBytes(1024)).toBe("1,0 KB");
        expect(formatBytes(2048)).toBe("2,0 KB");
        expect(formatBytes(1536)).toBe("1,5 KB");
    });

    it("usa MB a partir de 1 MB", () => {
        expect(formatBytes(1024 * 1024)).toBe("1,0 MB");
        expect(formatBytes(5 * 1024 * 1024)).toBe("5,0 MB");
    });
});
