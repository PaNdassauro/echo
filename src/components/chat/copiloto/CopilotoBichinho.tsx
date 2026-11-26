import { useEffect, useMemo, useRef } from "react";
import { motion, useReducedMotionConfig } from "framer-motion";
import { renderAvatarSvg, type AvatarMotion } from "open-bot-avatar";
import {
  mountAvatar,
  type AvatarOptions,
  type MountedAvatar,
} from "open-bot-avatar/dom";
import { cn } from "@/lib/utils";
import { useForcedReducedMotion } from "@/hooks/useAccessibilityPrefs";
import { COPILOTO_AVATAR } from "@/lib/copilotoAvatar";

export type CopilotoHumor = "ocioso" | "lendo" | "pronto" | "erro";

interface CopilotoBichinhoProps {
  /** O avatar É o indicador de estado: o humor diz o que o copiloto está fazendo. */
  humor?: CopilotoHumor;
  /** false = um SVG parado (ex.: ícone em Configurações). */
  animado?: boolean;
  className?: string;
}

/** Cores do tema, lidas ao vivo pelo renderizador: troca de tema não remonta nada. */
const COR_CORPO = "hsl(var(--foreground))";
const COR_OLHO = "hsl(var(--background))";

/**
 * O SVG parado só aceita cor hex: desenha com estas duas cores-marca e troca
 * pelas do tema no texto, para o ícone seguir o tema sem redesenhar.
 */
const MARCA_CORPO = "#010203";
const MARCA_OLHO = "#040506";

/**
 * Olhando para a conversa: a faixa fica à esquerda, embaixo das mensagens, então
 * ele olha para a direita e um pouco para cima. O `lookAt` vira o corpo junto
 * (sem `view` extra: a bola é um disco com volume e, virada demais, achata).
 */
const OLHAR_CONVERSA = { x: 0.75, y: -0.35 } as const;
/** Erro: olhos apertados olhando para baixo ("não deu"). */
const OLHAR_ERRO = { x: 0.5, y: 1 } as const;

/**
 * Os 3 pontinhos do "lendo" (o "digitando…" do bichinho), na caixa 0 0 100 100
 * do avatar. Centrados no CORPO, não na caixa: no humor "thinking" a biblioteca
 * vira a bola um pouco (vista de 3/4), e o centro dela na tela fica em
 * (45,8; 49), medido no canvas do build de produção.
 */
const CENTRO_LENDO = { x: 45.8, y: 49 } as const;
const PONTINHOS = [
  { cx: CENTRO_LENDO.x - 13, atraso: 0 },
  { cx: CENTRO_LENDO.x, atraso: 0.15 },
  { cx: CENTRO_LENDO.x + 13, atraso: 0.3 },
] as const;

interface Pose {
  mood: AvatarMotion;
  lookAt: { x: number; y: number } | null;
  /** Lendo: olho da cor do corpo = olhos somem e os pontinhos assumem. */
  olhosEscondidos: boolean;
}

function poseDoHumor(humor: CopilotoHumor): Pose {
  switch (humor) {
    case "lendo":
      return {
        mood: "thinking",
        lookAt: OLHAR_CONVERSA,
        olhosEscondidos: true,
      };
    case "pronto":
      return { mood: "happy", lookAt: OLHAR_CONVERSA, olhosEscondidos: false };
    case "erro":
      return { mood: "thinking", lookAt: OLHAR_ERRO, olhosEscondidos: false };
    default:
      return { mood: "idle", lookAt: OLHAR_CONVERSA, olhosEscondidos: false };
  }
}

/**
 * O bichinho do copiloto: uma bola com olhos, desenhada pelo `open-bot-avatar`
 * (volume inferido do contorno, respiração, piscadas, olhar e troca de humor
 * com transição). Cores do tema: corpo em `foreground`, olhos em `background`.
 *
 * Humores: ocioso = respira, pisca e olha em volta; lendo = pensativo, com 3
 * pontinhos pulando no lugar dos olhos; pronto = olhos felizes, pulinhos;
 * erro = olhos apertados olhando para baixo.
 *
 * Movimento: a amplitude é sub-pixel no tamanho da faixa, e o bichinho é
 * indicador de estado (como um spinner), então ele só congela com o "Reduzir
 * animações" do Echo. O pedido do sistema só troca o pulo dos pontinhos por
 * uma piscada de opacidade.
 */
export function CopilotoBichinho({
  humor = "ocioso",
  animado = true,
  className,
}: CopilotoBichinhoProps) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const congelado = useForcedReducedMotion();
  const suave = useReducedMotionConfig() === true;

  const pose = poseDoHumor(humor);
  const opcoes: AvatarOptions = {
    definition: COPILOTO_AVATAR,
    color: COR_CORPO,
    eyeColor: pose.olhosEscondidos ? COR_CORPO : COR_OLHO,
    mood: pose.mood,
    lookAt: pose.lookAt,
    reducedMotion: congelado,
    label: "",
  };

  // Animado: monta uma vez; as mudanças seguintes vão por update(), que só redesenha o que mudou.
  const opcoesRef = useRef(opcoes);
  opcoesRef.current = opcoes;
  useEffect(() => {
    if (!animado || !host.current) return;
    const montado = mountAvatar(host.current, opcoesRef.current);
    avatar.current = montado;
    return () => {
      montado.destroy();
      avatar.current = null;
    };
  }, [animado]);
  useEffect(() => {
    avatar.current?.update(opcoes);
  });
  // Com movimento reduzido o loop dorme e só repinta no próximo update():
  // troca de tema (ou da cor da linha) pede um quadro novo com as cores novas.
  useEffect(() => {
    if (!animado) return;
    const repintar = () => avatar.current?.update({});
    window.addEventListener("echo-theme-change", repintar);
    return () => window.removeEventListener("echo-theme-change", repintar);
  }, [animado]);

  // Parado: um SVG com as cores-marca trocadas pelas do tema.
  const svgParado = useMemo(() => {
    if (animado) return null;
    return (
      renderAvatarSvg(COPILOTO_AVATAR, {
        color: MARCA_CORPO,
        eyeColor: pose.olhosEscondidos ? MARCA_CORPO : MARCA_OLHO,
        motion: pose.mood,
        gaze: pose.lookAt ?? undefined,
        reducedMotion: true,
      })
        .split(MARCA_CORPO)
        .join("currentColor")
        .split(MARCA_OLHO)
        .join(COR_OLHO)
        // O <title> viraria dica de mouse; o span de fora já é aria-hidden.
        .replace(/<title>[\s\S]*?<\/title>/, "")
    );
  }, [animado, pose.mood, pose.lookAt, pose.olhosEscondidos]);

  const lendo = humor === "lendo";
  const pula = animado && lendo && !congelado;

  return (
    <span
      aria-hidden="true"
      data-humor={humor}
      className={cn("relative inline-block size-6 text-foreground", className)}
    >
      {svgParado === null ? (
        <span key="vivo" ref={host} className="absolute inset-0" />
      ) : (
        <span
          key="parado"
          className="absolute inset-0 [&>svg]:size-full"
          // SVG gerado pela biblioteca a partir da definição fixa do código (nada vem do usuário).
          dangerouslySetInnerHTML={{ __html: svgParado }}
        />
      )}
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        <motion.g
          fill={COR_OLHO}
          initial={false}
          animate={{ opacity: lendo ? 1 : 0 }}
          transition={{ duration: 0.18, delay: lendo && animado ? 0.08 : 0 }}
        >
          {PONTINHOS.map(({ cx, atraso }) => (
            <motion.circle
              key={cx}
              cx={cx}
              cy={CENTRO_LENDO.y}
              r={5.5}
              animate={
                pula
                  ? suave
                    ? { y: 0, opacity: [0.35, 1, 0.35] }
                    : { y: [0, -7, 0], opacity: 1 }
                  : { y: 0, opacity: 1 }
              }
              transition={
                pula
                  ? {
                      duration: suave ? 0.9 : 0.6,
                      ease: "easeInOut",
                      delay: atraso,
                      repeat: Infinity,
                      repeatDelay: suave ? 0 : 0.3,
                      ...(suave ? {} : { opacity: { duration: 0.15 } }),
                    }
                  : { duration: 0.15 }
              }
            />
          ))}
        </motion.g>
      </svg>
    </span>
  );
}
