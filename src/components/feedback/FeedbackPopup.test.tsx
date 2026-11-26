import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./FeedbackForm", () => ({ default: () => null }));

import { FeedbackPopup } from "./FeedbackPopup";

afterEach(() => {
  cleanup();
  window.__ECHO_CONFIG__ = undefined;
});

describe("FeedbackPopup", () => {
  it("aparece por padrão", () => {
    render(<FeedbackPopup />);
    expect(screen.getByRole("button", { name: "Enviar feedback" })).toBeTruthy();
  });

  it("some quando a instalação não tem como receber feedback (features.feedback=false)", () => {
    window.__ECHO_CONFIG__ = { features: { feedback: false } };
    render(<FeedbackPopup />);
    expect(screen.queryByRole("button", { name: "Enviar feedback" })).toBeNull();
  });
});
