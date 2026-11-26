import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const peaksState = vi.hoisted(() => ({ value: null as number[] | null }));

vi.mock("./chat/audio/useAudioPeaks", () => ({
  PEAK_BUCKETS: 44,
  useAudioPeaks: () => peaksState.value,
}));

import AudioPlayer from "./AudioPlayer";

afterEach(() => {
  cleanup();
  peaksState.value = null;
});

describe("AudioPlayer — slot da waveform", () => {
  it("mantém o slot h-6 antes e depois de os picos resolverem", () => {
    const src = "https://x/audio.ogg";
    const { rerender } = render(<AudioPlayer src={src} />);
    expect(screen.getByTestId("audio-wave-slot").className).toContain("h-6");

    peaksState.value = Array.from({ length: 44 }, () => 0.5);
    rerender(<AudioPlayer src={src} />);
    expect(screen.getByTestId("audio-wave-slot").className).toContain("h-6");
  });
});
