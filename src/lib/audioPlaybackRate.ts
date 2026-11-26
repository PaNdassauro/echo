/**
 * Velocidade de reprodução dos áudios da conversa.
 *
 * Preferência de ferramenta, não credencial — localStorage é apropriado aqui
 * (mesmo raciocínio de useSnippetLanguage): quem escolheu 2x não quer reescolher
 * em cada áudio, nem depois de recarregar a página.
 *
 * Enum fechado de 3 valores: o parse por `find` com fallback dá a mesma garantia
 * de um schema para um escalar como este, sem tipo `any` em nenhum ponto.
 */

export const PLAYBACK_RATES = [1, 1.5, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

const STORAGE_KEY = "echo_audio_playback_rate";
const DEFAULT_RATE: PlaybackRate = 1;

export const parsePlaybackRate = (value: string | null): PlaybackRate =>
  PLAYBACK_RATES.find((rate) => String(rate) === value) ?? DEFAULT_RATE;

export const readStoredPlaybackRate = (): PlaybackRate => {
  try {
    return parsePlaybackRate(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_RATE;
  }
};

export const persistPlaybackRate = (rate: PlaybackRate): void => {
  try {
    localStorage.setItem(STORAGE_KEY, String(rate));
  } catch {
    /* modo privado / storage cheio — a escolha só não persiste */
  }
};

/** Ciclo circular: 1x → 1,5x → 2x → 1x. */
export const nextPlaybackRate = (rate: PlaybackRate): PlaybackRate =>
  PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length];

/** Rótulo pt-BR, com vírgula decimal: "1x" | "1,5x" | "2x". */
export const formatPlaybackRate = (rate: PlaybackRate): string =>
  `${String(rate).replace(".", ",")}x`;
