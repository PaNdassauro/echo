import { describe, expect, it } from "vitest";
import { SendInviteResponseSchema, estadoDoEmail, textoDoEnvio, type ConviteCriado } from "./inviteResult";

const convite = (email: ConviteCriado["email"], n = 1): ConviteCriado => ({
  phoneNumberId: `00000000-0000-4000-8000-00000000000${n}`,
  phoneNumberName: `Vendas ${n}`,
  url: `https://echo.exemplo.com/auth?invite=token-${n}`,
  email,
});

describe("estadoDoEmail", () => {
  it("usa o campo email quando a edge manda", () => {
    expect(estadoDoEmail(SendInviteResponseSchema.parse({ email: "nao_configurado", emailSent: false }))).toBe(
      "nao_configurado",
    );
    expect(estadoDoEmail(SendInviteResponseSchema.parse({ email: "enviado" }))).toBe("enviado");
  });

  it("edge sem o campo: emailSent decide", () => {
    expect(estadoDoEmail(SendInviteResponseSchema.parse({ emailSent: true }))).toBe("enviado");
    expect(estadoDoEmail(SendInviteResponseSchema.parse({ emailSent: false }))).toBe("falhou");
    expect(estadoDoEmail(SendInviteResponseSchema.parse({}))).toBe("falhou");
  });

  it("recusa valor de email fora do contrato", () => {
    expect(SendInviteResponseSchema.safeParse({ email: "talvez" }).success).toBe(false);
  });
});

describe("textoDoEnvio", () => {
  it("e-mail enviado", () => {
    expect(textoDoEnvio("ana@exemplo.com", [convite("enviado")])).toContain("Enviamos o convite para ana@exemplo.com");
  });

  it("instalação sem e-mail manda copiar o link", () => {
    const texto = textoDoEnvio("ana@exemplo.com", [convite("nao_configurado")]);
    expect(texto).toContain("Esta instalação não envia e-mail");
    expect(texto).toContain("o link");
  });

  it("vários links usam o plural; falha de envio não diz 'não envia'", () => {
    const texto = textoDoEnvio("ana@exemplo.com", [convite("falhou", 1), convite("falhou", 2)]);
    expect(texto).toContain("os links");
    expect(texto).toContain("Não foi possível enviar o e-mail");
  });

  it("mistura de enviado e falhou avisa da falha", () => {
    expect(textoDoEnvio("ana@exemplo.com", [convite("enviado", 1), convite("falhou", 2)])).toContain(
      "Não foi possível enviar o e-mail",
    );
  });
});
