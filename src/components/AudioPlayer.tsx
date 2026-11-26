import { memo, useRef, useState, useEffect, useCallback } from "react";
import { Play, Pause, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  formatPlaybackRate,
  nextPlaybackRate,
  persistPlaybackRate,
  readStoredPlaybackRate,
  type PlaybackRate,
} from "@/lib/audioPlaybackRate";
import { markAudioPlayed, wasAudioPlayed } from "@/lib/audioPlayed";
import { mediaFilenameFromUrl, toDownloadUrl } from "@/lib/mediaDownload";
import { Waveform } from "./chat/audio/Waveform";
import { useAudioPeaks } from "./chat/audio/useAudioPeaks";

interface AudioPlayerProps {
  src: string;
  onLoadedMetadata?: () => void;
  className?: string;
  /** Nota de voz recebida ainda não ouvida — dot verde (paridade WhatsApp). */
  showUnplayedDot?: boolean;
  /** Nome sugerido no download; nota de voz geralmente não tem, aí sai da URL. */
  filename?: string;
}

// Global audio state - persists across React re-renders and remounts
const globalAudioState = {
  currentSrc: null as string | null,
  audio: null as HTMLAudioElement | null,
  listeners: new Map<string, Set<(state: { isPlaying: boolean; currentTime: number; duration: number }) => void>>(),

  // Velocidade é global por construção: existe UM elemento de áudio para todas as
  // bolhas. Canal de listeners separado do de progresso — notifyListeners() só
  // fala com os listeners de currentSrc e carrega currentTime/duration DESSE
  // áudio; reusá-lo para a taxa contaminaria as bolhas paradas com o tempo de
  // outro áudio.
  playbackRate: readStoredPlaybackRate(),
  rateListeners: new Set<(rate: PlaybackRate) => void>(),
  // Fim de reprodução (src que terminou) — gancho do autoplay da próxima nota
  endedListeners: new Set<(src: string) => void>(),

  getAudio() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "metadata";
      // Sem isso a voz sobe de tom em 1,5x/2x. Padrão já é true nos navegadores
      // atuais; explícito porque aqui o conteúdo é fala, não música.
      this.audio.preservesPitch = true;
      this.applyRate();

      // Set up global event handlers
      this.audio.addEventListener("timeupdate", () => this.notifyListeners());
      this.audio.addEventListener("play", () => this.notifyListeners());
      this.audio.addEventListener("pause", () => this.notifyListeners());
      this.audio.addEventListener("ended", () => {
        this.notifyListeners();
        const endedSrc = this.currentSrc;
        if (endedSrc) this.endedListeners.forEach((cb) => cb(endedSrc));
      });
      this.audio.addEventListener("loadedmetadata", () => {
        // O algoritmo de load() do HTML reseta playbackRate para
        // defaultPlaybackRate — reaplicar aqui cobre a troca de src.
        this.applyRate();
        this.notifyListeners();
      });
    }
    return this.audio;
  },

  applyRate() {
    if (!this.audio) return;
    // defaultPlaybackRate também: é o valor que sobrevive ao load().
    this.audio.defaultPlaybackRate = this.playbackRate;
    this.audio.playbackRate = this.playbackRate;
  },

  setPlaybackRate(rate: PlaybackRate) {
    this.playbackRate = rate;
    persistPlaybackRate(rate);
    this.applyRate();
    this.rateListeners.forEach(cb => cb(rate));
  },

  subscribeRate(callback: (rate: PlaybackRate) => void) {
    this.rateListeners.add(callback);
    return () => {
      this.rateListeners.delete(callback);
    };
  },

  notifyListeners() {
    if (!this.currentSrc) return;
    const listeners = this.listeners.get(this.currentSrc);
    if (listeners) {
      const state = {
        isPlaying: !this.audio?.paused,
        currentTime: this.audio?.currentTime || 0,
        duration: this.audio?.duration || 0,
      };
      listeners.forEach(cb => cb(state));
    }
  },

  subscribe(src: string, callback: (state: { isPlaying: boolean; currentTime: number; duration: number }) => void) {
    if (!this.listeners.has(src)) {
      this.listeners.set(src, new Set());
    }
    this.listeners.get(src)!.add(callback);

    // Immediately notify with current state if this src is playing
    if (this.currentSrc === src && this.audio) {
      callback({
        isPlaying: !this.audio.paused,
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    }

    return () => {
      this.listeners.get(src)?.delete(callback);
    };
  },

  play(src: string) {
    const audio = this.getAudio();

    // If different source, load it
    if (this.currentSrc !== src) {
      this.currentSrc = src;
      audio.src = src;
      audio.load();
      // load() zera playbackRate: sem reaplicar, o 2º áudio volta para 1x.
      this.applyRate();
    }

    markAudioPlayed(src);
    audio.play().catch(console.error);
  },

  pause() {
    this.audio?.pause();
  },

  seek(time: number) {
    if (this.audio) {
      this.audio.currentTime = time;
    }
  },

  isPlayingSrc(src: string) {
    return this.currentSrc === src && this.audio && !this.audio.paused;
  },

  getCurrentTimeForSrc(src: string) {
    if (this.currentSrc === src && this.audio) {
      return this.audio.currentTime;
    }
    return 0;
  },

  getDurationForSrc(src: string) {
    if (this.currentSrc === src && this.audio) {
      return this.audio.duration || 0;
    }
    return 0;
  }
};

/** Fachada do autoplay: toca a próxima nota de voz quando uma termina. */
export const audioPlayback = {
  play: (src: string) => globalAudioState.play(src),
  subscribeEnded: (cb: (src: string) => void): (() => void) => {
    globalAudioState.endedListeners.add(cb);
    return () => {
      globalAudioState.endedListeners.delete(cb);
    };
  },
};

/**
 * Custom audio player using a global audio element.
 * This ensures playback continues even when React components remount.
 */
const AudioPlayer = memo(({ src, onLoadedMetadata, className, showUnplayedDot = false, filename }: AudioPlayerProps) => {
  const [isPlaying, setIsPlaying] = useState(() => globalAudioState.isPlayingSrc(src));
  const [currentTime, setCurrentTime] = useState(() => globalAudioState.getCurrentTimeForSrc(src));
  const [duration, setDuration] = useState(() => globalAudioState.getDurationForSrc(src));
  const [isLoaded, setIsLoaded] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(() => globalAudioState.playbackRate);
  const [unplayed, setUnplayed] = useState(() => showUnplayedDot && !wasAudioPlayed(src));
  const metadataCalledRef = useRef(false);
  // Waveform real (WhatsApp); decode falho (ex.: opus no Safari) → barra chata
  const peaks = useAudioPeaks(src);

  // Format time as mm:ss
  const formatTime = (time: number) => {
    if (!isFinite(time) || isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // Subscribe to global audio state
  useEffect(() => {
    const unsubscribe = globalAudioState.subscribe(src, (state) => {
      setIsPlaying(state.isPlaying);
      setCurrentTime(state.currentTime);
      if (state.duration > 0) {
        setDuration(state.duration);
        setIsLoaded(true);
        if (!metadataCalledRef.current) {
          metadataCalledRef.current = true;
          onLoadedMetadata?.();
        }
      }
    });

    return unsubscribe;
  }, [src, onLoadedMetadata]);

  // Velocidade é global: toda bolha montada acompanha a troca feita em qualquer
  // outra, senão o rótulo das demais fica mentindo.
  useEffect(() => globalAudioState.subscribeRate(setPlaybackRate), []);

  // Progresso contínuo: o timeupdate nativo dispara ~4x/s e o traço andava em
  // degraus de 250ms. Enquanto ESTA bolha toca (só uma toca por vez — o rAF
  // nunca roda em mais de um player), lê currentTime a cada frame. Movimento
  // constante e informacional: segue valendo com prefers-reduced-motion.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      setCurrentTime(globalAudioState.getCurrentTimeForSrc(src));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, src]);

  // Load metadata on mount (for duration display)
  useEffect(() => {
    // Create a temporary audio element just to get duration
    const tempAudio = new Audio(src);
    tempAudio.preload = "metadata";
    tempAudio.addEventListener("loadedmetadata", () => {
      setDuration(tempAudio.duration);
      setIsLoaded(true);
      if (!metadataCalledRef.current) {
        metadataCalledRef.current = true;
        onLoadedMetadata?.();
      }
    });

    return () => {
      tempAudio.src = "";
    };
  }, [src, onLoadedMetadata]);

  // Handle play/pause toggle
  const togglePlay = useCallback(() => {
    if (isPlaying && globalAudioState.currentSrc === src) {
      globalAudioState.pause();
    } else {
      setUnplayed(false);
      globalAudioState.play(src);
    }
  }, [src, isPlaying]);

  // Cicla 1x → 1,5x → 2x. Lê do singleton, não do state: dois cliques no mesmo
  // frame veriam o mesmo valor de state e o ciclo pularia um passo.
  const cyclePlaybackRate = useCallback(() => {
    globalAudioState.setPlaybackRate(nextPlaybackRate(globalAudioState.playbackRate));
  }, []);

  // Handle seeking via progress bar click
  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const newTime = percentage * duration;

    // If this audio is currently loaded, seek directly
    if (globalAudioState.currentSrc === src) {
      globalAudioState.seek(newTime);
    } else {
      // Load and seek
      globalAudioState.play(src);
      setTimeout(() => globalAudioState.seek(newTime), 100);
    }
  }, [src, duration]);

  // Seek relativo (teclado): ←/→ ±5s, Home/End. Reusa o mesmo caminho do clique.
  const seekTo = useCallback((newTime: number) => {
    if (!duration) return;
    const clamped = Math.min(Math.max(newTime, 0), duration);
    if (globalAudioState.currentSrc === src) {
      globalAudioState.seek(clamped);
    } else {
      globalAudioState.play(src);
      setTimeout(() => globalAudioState.seek(clamped), 100);
    }
  }, [src, duration]);

  const handleSeekKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      seekTo(currentTime + 5);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      seekTo(currentTime - 5);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(duration - 0.25);
    }
  }, [duration, currentTime, seekTo]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const downloadName = filename || mediaFilenameFromUrl(src, "ogg");

  return (
    // Superfície sem borda nem sombra: a bolha já É um cartão, e um segundo anel
    // dentro dela vira caixa-dentro-de-caixa. O fundo fica porque a waveform tocada
    // é bg-primary — na bolha outbound (primary) ela sumiria sem esta base neutra.
    // w-full/min-w-0 em vez de min-w fixo: 240px estourava a bolha de 70% no mobile.
    <div className={cn("flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-background/80 w-full min-w-0 sm:min-w-[240px]", className)}>
      {/* Play/Pause button */}
      <button
        onClick={togglePlay}
        className="w-10 h-10 rounded-full bg-primary hover:bg-primary/90 flex items-center justify-center transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] shrink-0"
        aria-label={isPlaying ? "Pausar" : "Reproduzir"}
      >
        <IconSwap
          active={isPlaying ? "pause" : "play"}
          durationMs={150}
          icons={{
            // ml-0.5: o triângulo tem massa à esquerda — nudge óptico para o centro
            play: <Play className="w-[18px] h-[18px] text-primary-foreground ml-0.5" />,
            pause: <Pause className="w-[18px] h-[18px] text-primary-foreground" />,
          }}
        />
      </button>

      <div className="flex-1 min-w-0">
        {/* Linha 1: waveform + baixar. O download mora AQUI, e não numa 3ª coluna
            do card: como irmão do play ele ficava centrado na altura toda, órfão
            e longe de tudo. Encostado na waveform ele empilha com a velocidade
            logo abaixo — uma única coluna de ações à direita. */}
        <div className="flex items-center gap-2">
          {/* py-2 -my-2: alvo de toque/clique maior sem engordar o trilho */}
          <div
            className="flex-1 min-w-0 py-2 -my-2 cursor-pointer"
            onClick={handleSeek}
            role="slider"
            tabIndex={0}
            aria-label="Posição do áudio"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration) || 0}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${formatTime(currentTime)} de ${isLoaded ? formatTime(duration) : "áudio"}`}
            onKeyDown={handleSeekKeyDown}
          >
            {/* Slot fixo: decodificar os picos não muda a altura da linha (eram ~4 px por áudio). */}
            <div className="flex h-6 items-center" data-testid="audio-wave-slot">
              {peaks ? (
                <div className="w-full">
                  <Waveform peaks={peaks} progress={progress} />
                </div>
              ) : (
                <div className="h-2 w-full bg-muted rounded-full relative overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 bg-primary rounded-full"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </div>
          </div>

          <a
            href={toDownloadUrl(src, downloadName)}
            download={downloadName}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 -my-1 -mr-1 rounded-md text-muted-foreground shrink-0 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Baixar áudio"
            aria-label="Baixar áudio"
          >
            <Download className="w-4 h-4" />
          </a>
        </div>

        {/* Linha 2: tempos + velocidade. Decorrido e duração andam juntos como UM
            par (não em pontas opostas com o 1x boiando no meio): três âncoras numa
            linha de 12px é uma a mais, e o olho perdia qual número é qual. */}
        <div className="flex items-center justify-between gap-2 mt-1 text-xs font-medium">
          <span className="tabular-nums text-foreground/70 inline-flex items-center gap-1 min-w-0">
            {formatTime(currentTime)}
            <span className="text-foreground/30" aria-hidden="true">/</span>
            <span className="text-foreground/45">{isLoaded ? formatTime(duration) : "--:--"}</span>
            {unplayed && (
              <span
                className="w-1.5 h-1.5 ml-0.5 rounded-full bg-status-active shrink-0"
                title="Nota de voz não ouvida"
                aria-label="Não ouvida"
              />
            )}
          </span>

          {/* min-w fixo: sem ele a troca 1x → 1,5x muda a largura e a borda
              esquerda do pill pula. py-1 -my-1: alvo de toque sem engordar a linha. */}
          <button
            type="button"
            onClick={cyclePlaybackRate}
            className="px-1.5 py-1 -my-1 -mr-1 rounded-md min-w-[2.25rem] text-center text-2xs font-semibold tabular-nums text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`Velocidade ${formatPlaybackRate(playbackRate)} — clique para ${formatPlaybackRate(nextPlaybackRate(playbackRate))}`}
            aria-label={`Velocidade de reprodução: ${formatPlaybackRate(playbackRate)}. Alterar para ${formatPlaybackRate(nextPlaybackRate(playbackRate))}`}
          >
            {formatPlaybackRate(playbackRate)}
          </button>
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return prevProps.src === nextProps.src && prevProps.filename === nextProps.filename;
});

AudioPlayer.displayName = "AudioPlayer";

export default AudioPlayer;
