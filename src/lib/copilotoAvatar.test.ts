import { describe, expect, it } from "vitest";
import { validateAvatar } from "open-bot-avatar";
import { COPILOTO_AVATAR } from "./copilotoAvatar";

describe("COPILOTO_AVATAR", () => {
  it("passa no validador do open-bot-avatar sem ser alterado", () => {
    const r = validateAvatar(COPILOTO_AVATAR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(COPILOTO_AVATAR);
  });
});
