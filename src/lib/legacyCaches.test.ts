import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteLegacyRuntimeCaches, LEGACY_RUNTIME_CACHES } from "./legacyCaches";

afterEach(() => vi.restoreAllMocks());

describe("deleteLegacyRuntimeCaches", () => {
  it("apaga o html-cache e o supabase-cache", async () => {
    const del = vi.fn().mockResolvedValue(true);
    await deleteLegacyRuntimeCaches({ delete: del });
    expect(del.mock.calls.map(([name]) => name).sort()).toEqual(["html-cache", "supabase-cache"]);
    expect([...LEGACY_RUNTIME_CACHES].sort()).toEqual(["html-cache", "supabase-cache"]);
  });

  it("falha num cache não impede o outro e não rejeita", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const del = vi.fn().mockImplementation(async (name: string) => {
      if (name === "html-cache") throw new Error("bloqueado");
      return true;
    });
    await expect(deleteLegacyRuntimeCaches({ delete: del })).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith("supabase-cache");
  });
});
