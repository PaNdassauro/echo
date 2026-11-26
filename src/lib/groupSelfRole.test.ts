import { describe, expect, it } from "vitest";
import {
  findSelfByPhone,
  groupAddBlockLabel,
  resolveGroupAddPermission,
  resolveGroupManagePermissions,
  resolveGroupSendPermission,
} from "./groupSelfRole";

// Adicionar sem ser admin derruba a sessão (401 <conflict>): o painel só libera
// "Adicionar" com certeza positiva. Estes casos são o contrato do gate.

const LINE = "5511999990000";
const me = (isAdmin: boolean) => ({ phone: LINE, isAdmin });
const other = (isAdmin = true) => ({ phone: "5511888880000", isAdmin });
const NOW = Date.parse("2026-10-15T12:00:00Z");

describe("resolveGroupAddPermission com `me` do serviço (≥ 2.5.6)", () => {
  it("libera quando o serviço diz que a linha é admin", () => {
    expect(resolveGroupAddPermission({ me: { isAdmin: true }, participants: [] }, null)).toEqual({ allowed: true, reason: null });
  });

  it("bloqueia quando a linha não é admin, mesmo que o telefone casasse", () => {
    expect(resolveGroupAddPermission({ me: { isAdmin: false }, participants: [me(true)] }, LINE)).toEqual({ allowed: false, reason: "not_admin" });
  });

  it("serviço não achou a linha (me: null) = sem certeza = bloqueado", () => {
    expect(resolveGroupAddPermission({ me: null, participants: [me(true)] }, LINE).reason).toBe("unknown");
  });
});

describe("resolveGroupAddPermission em grupo \"todos adicionam\" (memberAddMode)", () => {
  it("libera membro comum", () => {
    expect(resolveGroupAddPermission({ me: { isAdmin: false }, memberAddMode: true, participants: [] }, null).allowed).toBe(true);
    expect(resolveGroupAddPermission({ memberAddMode: true, participants: [other(), me(false)] }, LINE).allowed).toBe(true);
  });

  it("\"só admins adicionam\" segue bloqueando membro comum", () => {
    expect(resolveGroupAddPermission({ me: { isAdmin: false }, memberAddMode: false, participants: [] }, null).reason).toBe("not_admin");
  });

  it("não libera sem certeza de quem é a linha nem em grupo restrito", () => {
    expect(resolveGroupAddPermission({ me: null, memberAddMode: true, participants: [] }, LINE).reason).toBe("unknown");
    expect(
      resolveGroupAddPermission({ me: { isAdmin: false }, memberAddMode: true, suspended: true, participants: [] }, null, NOW).reason
    ).toBe("restricted");
  });
});

describe("resolveGroupAddPermission sem `me` (serviço antigo): acha a linha pelo telefone", () => {
  it("linha admin na lista → libera", () => {
    expect(resolveGroupAddPermission({ participants: [other(), me(true)] }, LINE).allowed).toBe(true);
  });

  it("linha membro comum → not_admin", () => {
    expect(resolveGroupAddPermission({ participants: [other(), me(false)] }, LINE).reason).toBe("not_admin");
  });

  it("tolera o 9º dígito: grupo conhece a linha sem o 9", () => {
    const semNove = { phone: "551199990000", isAdmin: true };
    expect(resolveGroupAddPermission({ participants: [semNove] }, LINE).allowed).toBe(true);
  });

  it("linha fora da lista, LID não resolvido ou telefone da linha ainda não carregado → unknown", () => {
    expect(resolveGroupAddPermission({ participants: [other()] }, LINE).reason).toBe("unknown");
    expect(resolveGroupAddPermission({ participants: [{ phone: "123456789", isAdmin: true, isLid: true }] }, LINE).reason).toBe("unknown");
    expect(resolveGroupAddPermission({ participants: [me(true)] }, null).reason).toBe("unknown");
    expect(resolveGroupAddPermission({ participants: [me(true)] }, "").reason).toBe("unknown");
  });

  it("não casa a linha com um número parecido de outro país", () => {
    expect(findSelfByPhone([{ phone: "1541999990000", isAdmin: true }], LINE)).toBeUndefined();
  });
});

describe("restrição do WhatsApp vence o papel", () => {
  it("grupo suspenso bloqueia mesmo admin", () => {
    expect(resolveGroupAddPermission({ me: { isAdmin: true }, participants: [], suspended: true }, null).reason).toBe("restricted");
  });

  it("trava de crescimento vigente bloqueia; vencida não", () => {
    const base = { me: { isAdmin: true }, participants: [] };
    expect(resolveGroupAddPermission({ ...base, growthLockedUntil: "2026-10-16T00:00:00Z" }, null, NOW).reason).toBe("restricted");
    expect(resolveGroupAddPermission({ ...base, growthLockedUntil: "2026-10-01T00:00:00Z" }, null, NOW).allowed).toBe(true);
    expect(resolveGroupAddPermission({ ...base, growthLockedUntil: "lixo" }, null, NOW).allowed).toBe(true);
  });
});

it("cada motivo tem uma frase curta", () => {
  expect(groupAddBlockLabel("not_admin")).toMatch(/admins/);
  expect(groupAddBlockLabel("restricted")).toMatch(/WhatsApp/);
  expect(groupAddBlockLabel("unknown")).toMatch(/admin/);
});

// Enviar em grupo "só admins" sendo membro comum: o WhatsApp descarta em silêncio.
// Ao contrário do gate de adicionar, a dúvida LIBERA (fail-open).
describe("resolveGroupSendPermission", () => {
  const ALLOWED = { allowed: true, reason: null };

  it("grupo aberto (announce false/ausente) libera mesmo com a linha não admin", () => {
    expect(resolveGroupSendPermission({ announce: false, me: { isAdmin: false }, participants: [] }, null)).toEqual(ALLOWED);
    expect(resolveGroupSendPermission({ me: { isAdmin: false }, participants: [] }, null)).toEqual(ALLOWED);
  });

  it("só admins enviam + linha admin → libera", () => {
    expect(resolveGroupSendPermission({ announce: true, me: { isAdmin: true }, participants: [] }, null)).toEqual(ALLOWED);
  });

  it("só admins enviam + linha não admin → bloqueia", () => {
    expect(resolveGroupSendPermission({ announce: true, me: { isAdmin: false }, participants: [] }, null)).toEqual({ allowed: false, reason: "not_admin" });
  });

  it("serviço não achou a linha (me: null) = sem certeza = libera", () => {
    expect(resolveGroupSendPermission({ announce: true, me: null, participants: [me(false)] }, LINE)).toEqual(ALLOWED);
  });

  it("sem `me`, telefone casa participante não admin → bloqueia", () => {
    expect(resolveGroupSendPermission({ announce: true, participants: [other(), me(false)] }, LINE)).toEqual({ allowed: false, reason: "not_admin" });
  });

  it("sem `me`, telefone casa participante admin → libera", () => {
    expect(resolveGroupSendPermission({ announce: true, participants: [other(), me(true)] }, LINE)).toEqual(ALLOWED);
  });

  it("sem `me` e sem telefone da linha (ou linha fora da lista) → libera", () => {
    expect(resolveGroupSendPermission({ announce: true, participants: [me(false)] }, null)).toEqual(ALLOWED);
    expect(resolveGroupSendPermission({ announce: true, participants: [me(false)] })).toEqual(ALLOWED);
    expect(resolveGroupSendPermission({ announce: true, participants: [other(false)] }, LINE)).toEqual(ALLOWED);
  });
});

describe("resolveGroupManagePermissions", () => {
  const ALL = { manageSettings: true, manageMembers: true, editInfo: true, shareInvite: true };

  it("admin pode tudo", () => {
    expect(resolveGroupManagePermissions({ me: { isAdmin: true }, restrict: true, participants: [] }, null)).toEqual(ALL);
  });

  it("membro comum: sem configurações nem gestão de membros; edita dados só com restrict desligado", () => {
    const base = { me: { isAdmin: false }, participants: [] };
    expect(resolveGroupManagePermissions({ ...base, restrict: false }, null)).toEqual({
      manageSettings: false,
      manageMembers: false,
      editInfo: true,
      shareInvite: false,
    });
    expect(resolveGroupManagePermissions({ ...base, restrict: true }, null).editInfo).toBe(false);
  });

  it("membro comum compartilha o link só no grupo \"todos adicionam\"", () => {
    expect(resolveGroupManagePermissions({ me: { isAdmin: false }, memberAddMode: true, participants: [] }, null).shareInvite).toBe(true);
  });

  it("sem certeza do papel libera (o WhatsApp só devolve erro)", () => {
    expect(resolveGroupManagePermissions({ me: null, restrict: true, participants: [] }, null)).toEqual(ALL);
    expect(resolveGroupManagePermissions({ restrict: true, participants: [other()] }, LINE)).toEqual(ALL);
  });

  it("sem `me`, acha a linha membro pelo telefone", () => {
    expect(resolveGroupManagePermissions({ participants: [other(), me(false)] }, LINE).manageMembers).toBe(false);
  });
});
