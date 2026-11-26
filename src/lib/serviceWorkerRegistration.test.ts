import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker, SW_URL, UPDATE_INTERVAL_MS } from "./serviceWorkerRegistration";

function setup(register: ServiceWorkerContainer["register"]) {
  const winTarget = new EventTarget();
  const docTarget = new EventTarget();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: docTarget.addEventListener.bind(docTarget),
  };
  const win = {
    addEventListener: winTarget.addEventListener.bind(winTarget),
    // jsdom: window === globalThis, então o fake timer do Vitest vale aqui.
    setInterval: window.setInterval.bind(window),
  };
  const container = { register } as unknown as ServiceWorkerContainer;
  return { winTarget, docTarget, doc, win, container };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registerServiceWorker", () => {
  it("registra o sw.js e procura versão nova no poll, no foco, na volta da aba e da rede", async () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ update });
    const { winTarget, docTarget, doc, win, container } = setup(register);

    const registration = await registerServiceWorker({ container, win, doc });

    expect(register).toHaveBeenCalledWith(SW_URL, { scope: "/" });
    expect(registration).not.toBeNull();
    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(UPDATE_INTERVAL_MS);
    expect(update).toHaveBeenCalledTimes(1);

    winTarget.dispatchEvent(new Event("focus"));
    winTarget.dispatchEvent(new Event("online"));
    expect(update).toHaveBeenCalledTimes(3);

    doc.visibilityState = "hidden";
    docTarget.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(3);

    doc.visibilityState = "visible";
    docTarget.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(4);
  });

  it("falha no update não estoura", async () => {
    vi.useFakeTimers();
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    const register = vi.fn().mockResolvedValue({ update });
    const { winTarget, doc, win, container } = setup(register);

    await registerServiceWorker({ container, win, doc });
    winTarget.dispatchEvent(new Event("focus"));
    await vi.runOnlyPendingTimersAsync();

    expect(update).toHaveBeenCalled();
  });

  it("falha no registro é logada e devolve null", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const register = vi.fn().mockRejectedValue(new Error("SecurityError"));
    const { doc, win, container } = setup(register);

    await expect(registerServiceWorker({ container, win, doc })).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

// O cliente do vite-plugin-pwa em modo autoUpdate recarrega a página assim que
// o SW novo ativa, com a aba na frente: era o "app fecha e reabre" a cada deploy.
// O reload é só do createDeferredReload (main.tsx).
describe("nenhum import do cliente do vite-plugin-pwa", () => {
  function listSources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return listSources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("src não importa virtual:pwa-register", () => {
    const src = path.resolve(__dirname, "..");
    const offenders = listSources(src).filter((file) =>
      /from\s+["']virtual:pwa-register/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
