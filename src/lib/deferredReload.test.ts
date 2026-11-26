import { describe, expect, it, vi } from "vitest";
import { createDeferredReload } from "./deferredReload";

function setup(initial: { hidden: boolean; blocked: boolean }) {
  const state = { ...initial };
  const reload = vi.fn();
  const r = createDeferredReload({
    isHidden: () => state.hidden,
    isBlocked: () => state.blocked,
    reload,
  });
  return { state, reload, r };
}

describe("createDeferredReload", () => {
  it("sem versão nova não recarrega", () => {
    const { reload, r } = setup({ hidden: true, blocked: false });
    r.evaluate();
    expect(reload).not.toHaveBeenCalled();
  });

  it("aba escondida e livre: recarrega na hora", () => {
    const { reload, r } = setup({ hidden: true, blocked: false });
    r.request();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("aba visível: espera ela sumir", () => {
    const { state, reload, r } = setup({ hidden: false, blocked: false });
    r.request();
    expect(reload).not.toHaveBeenCalled();
    state.hidden = true;
    r.evaluate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("upload subindo com a aba escondida: espera a fila terminar", () => {
    const { state, reload, r } = setup({ hidden: true, blocked: true });
    r.request();
    r.evaluate(); // tick de progresso
    expect(reload).not.toHaveBeenCalled();
    state.blocked = false;
    r.evaluate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fila terminou com a aba visível: só recarrega no próximo esconder", () => {
    const { state, reload, r } = setup({ hidden: true, blocked: true });
    r.request();
    state.hidden = false;
    state.blocked = false;
    r.evaluate();
    expect(reload).not.toHaveBeenCalled();
    state.hidden = true;
    r.evaluate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recarrega uma vez só", () => {
    const { reload, r } = setup({ hidden: true, blocked: false });
    r.request();
    r.request();
    r.evaluate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
