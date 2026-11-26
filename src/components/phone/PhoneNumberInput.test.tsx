// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import PhoneNumberInput from "@/components/phone/PhoneNumberInput";
import { type PhoneCheck, phoneCheckForDigits } from "@/lib/phoneInput";

afterEach(cleanup);

/** Espelha como o modal usa o campo: guarda o valor composto e a validação. */
function Harness({ initial = "" }: { initial?: string }) {
    const [digits, setDigits] = useState(initial);
    const [check, setCheck] = useState<PhoneCheck>(() => phoneCheckForDigits(initial));
    return (
        <>
            <PhoneNumberInput
                value={digits}
                onChange={(next, nextCheck) => {
                    setDigits(next);
                    setCheck(nextCheck);
                }}
                error={check.error}
            />
            <output data-testid="composed">{digits}</output>
            <output data-testid="valid">{String(check.ok)}</output>
        </>
    );
}

const numberField = () => screen.getByPlaceholderText("(11) 99999-9999");
const dialField = () => screen.getByLabelText("Código do país (DDI)");

describe("PhoneNumberInput", () => {
    it("começa no Brasil e compõe o 55 sem o usuário digitar", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        expect(screen.getByText("55")).toBeInTheDocument();
        await user.type(numberField(), "11999999999");

        expect(screen.getByTestId("composed")).toHaveTextContent("5511999999999");
        expect(screen.getByTestId("valid")).toHaveTextContent("true");
        expect(numberField()).toHaveValue("(11) 99999-9999");
    });

    it("não duplica o 55 quando o número completo é colado", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(numberField());
        await user.paste("5511999999999");

        expect(screen.getByTestId("composed")).toHaveTextContent("5511999999999");
        expect(numberField()).toHaveValue("(11) 99999-9999");
    });

    it("no modo internacional usa o DDI informado e nunca prefixa 55", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.type(numberField(), "612345678");
        await user.click(screen.getByRole("checkbox", { name: /outro país/i }));
        await user.type(dialField(), "34");

        const composed = screen.getByTestId("composed");
        expect(composed).toHaveTextContent("34612345678");
        expect(composed.textContent?.startsWith("55")).toBe(false);
        expect(screen.getByTestId("valid")).toHaveTextContent("true");
    });

    it("mostra o país do DDI digitado", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByRole("checkbox", { name: /outro país/i }));
        await user.type(dialField(), "351");

        expect(screen.getByText(/Portugal/)).toBeInTheDocument();
    });

    it("preserva o número ao alternar o país", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.type(numberField(), "11999999999");
        await user.click(screen.getByRole("checkbox", { name: /outro país/i }));

        expect(screen.getByPlaceholderText("612345678")).toHaveValue("11999999999");
    });

    it("só reclama depois que algo foi digitado", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        expect(screen.queryByText(/Informe DDD/)).not.toBeInTheDocument();
        await user.type(numberField(), "119");

        expect(screen.getByText("Informe DDD + número (10 ou 11 dígitos)")).toBeInTheDocument();
        expect(screen.getByTestId("valid")).toHaveTextContent("false");
    });

    it("decompõe um valor internacional recebido de fora", () => {
        render(<Harness initial="351912345678" />);

        expect(dialField()).toHaveValue("351");
        expect(screen.getByPlaceholderText("612345678")).toHaveValue("912345678");
    });
});
