import { memo } from "react";

interface WaveformProps {
  /** Amplitudes normalizadas 0..1 (useAudioPeaks). */
  peaks: number[];
  /** Progresso da reprodução, 0..100. */
  progress: number;
}

const Bars = ({ peaks, colorClass }: { peaks: number[]; colorClass: string }) => (
  // gap de 1px e barra SEM min-width: com 44 barras, qualquer largura mínima
  // vira um piso (~174px) que não encolhe e estoura a bolha estreita.
  <div className="absolute inset-0 flex items-center gap-px">
    {peaks.map((peak, i) => (
      <div
        key={i}
        className={`flex-1 min-w-0 rounded-full ${colorClass}`}
        style={{ height: `${Math.max(15, peak * 100)}%` }}
      />
    ))}
  </div>
);

/**
 * Waveform de nota de voz (paridade WhatsApp), com preenchimento CONTÍNUO:
 * duas fileiras de barras sobrepostas — a de cima (primary) é revelada por
 * clip-path inset, avançando por pixel em vez de barra a barra. O clip roda na
 * GPU e o progresso vem de rAF no player, então o traço desliza sem degraus.
 * Puramente visual — o seek continua no wrapper clicável do AudioPlayer.
 */
export const Waveform = memo(({ peaks, progress }: WaveformProps) => (
  <div className="relative h-6 overflow-hidden" aria-hidden="true">
    <Bars peaks={peaks} colorClass="bg-muted-foreground/30" />
    <div
      className="absolute inset-0"
      style={{ clipPath: `inset(0 ${Math.max(0, 100 - progress)}% 0 0)` }}
    >
      <Bars peaks={peaks} colorClass="bg-primary" />
    </div>
  </div>
));

Waveform.displayName = "Waveform";
