import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import TypingBubble from "./TypingBubble";

afterEach(cleanup);

describe("TypingBubble", () => {
  it("não rola nada ao montar: o fim é do useStickToBottom", () => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<TypingBubble state="typing" />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
