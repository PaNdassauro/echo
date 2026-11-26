import { useLayoutEffect, useRef, useState } from "react";
import { Captions, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { IconSwap } from "@/components/ui/icon-swap";
import { checkEdgeFunctionResponseAsync, cn } from "@/lib/utils";
import { toUserMessage } from "@/lib/userFacingError";
import { useOrganization } from "@/contexts/OrganizationContext";
import {
  FALLBACK_ERRO,
  lembrarTranscricao,
  marcarSemChave,
  mensagemDaTranscricao,
  mensagemDoErroDaEdge,
  podeTranscrever,
  transcricaoCortada,
  transcricaoGravada,
  transcricaoImpossivel,
  transcricaoLembrada,
  transcricaoRespostaSchema,
  transcricaoSemChave,
} from "@/lib/transcricaoAudio";

/**
 * O texto passa das 4 linhas do recolhido? Mede o elemento com o clamp aplicado:
 * contar caracteres errava na bolha larga, onde 240 caracteres cabem em 3 linhas.
 */
function transbordaRecolhido(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

interface AudioTranscricaoProps {
  /** UUID da linha em messages. */
  messageId: string;
  metadata: unknown;
  isOutbound: boolean;
}

type Estado =
  | { fase: "parado" }
  | { fase: "transcrevendo" }
  | { fase: "erro"; mensagem: string; podeTentar: boolean };

/**
 * Embaixo do player: o texto já transcrito (de quem clicou em Transcrever)
 * ou o botão "Transcrever". O texto fica em `messages.metadata.leitura` e chega a
 * todos pelo realtime; a resposta da edge só adianta a bolha de quem clicou.
 */
export function AudioTranscricao({ messageId, metadata, isOutbound }: AudioTranscricaoProps) {
  const [estado, setEstado] = useState<Estado>({ fase: "parado" });
  const [aberto, setAberto] = useState(false);
  // Só anima o texto que acabou de chegar por clique: a lista virtualizada remonta a bolha.
  const [recemChegado, setRecemChegado] = useState(false);
  const emVoo = useRef(false);
  const { currentOrganization } = useOrganization();
  const organizacaoId = currentOrganization?.id ?? null;

  const texto = transcricaoGravada(metadata) ?? transcricaoLembrada(messageId);
  const textoRef = useRef<HTMLParagraphElement>(null);
  const [transborda, setTransborda] = useState(false);

  // Só mede recolhido (aberto, o clamp sai e tudo cabe). A largura da bolha muda com a
  // janela e com o painel lateral: o ResizeObserver mede de novo.
  useLayoutEffect(() => {
    const el = textoRef.current;
    if (!el || aberto) return;
    const medir = () => setTransborda(transbordaRecolhido(el));
    medir();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [texto, aberto]);

  if (!podeTranscrever(messageId)) return null;

  const transcrever = async () => {
    if (emVoo.current) return;
    emVoo.current = true;
    setEstado({ fase: "transcrevendo" });
    try {
      const resultado = await supabase.functions.invoke("transcrever-audio", { body: { messageId } });
      const dados = await checkEdgeFunctionResponseAsync(resultado);
      const resposta = transcricaoRespostaSchema.safeParse(dados);
      if (!resposta.success) {
        console.error("[transcricao] resposta fora do contrato:", resposta.error.issues);
        setEstado({ fase: "erro", mensagem: "A transcrição voltou num formato inesperado. Tente de novo.", podeTentar: true });
        return;
      }
      const r = resposta.data;
      if (r.status === "ok") {
        lembrarTranscricao(messageId, r.texto);
        setRecemChegado(true);
        setEstado({ fase: "parado" });
        return;
      }
      if (r.status === "indisponivel") marcarSemChave(organizacaoId, Date.now());
      setEstado({
        fase: "erro",
        mensagem: mensagemDaTranscricao(r),
        podeTentar: r.status === "em_andamento" || (r.status === "falhou" && !r.definitivo),
      });
    } catch (erro) {
      console.error("[transcricao] falhou:", erro);
      setEstado({
        fase: "erro",
        mensagem: mensagemDoErroDaEdge(erro) ?? toUserMessage(erro, FALLBACK_ERRO),
        podeTentar: true,
      });
    } finally {
      emVoo.current = false;
    }
  };

  if (texto !== null) {
    // Aberto, o botão fica para recolher; recolhido, só quando o texto não cabe.
    const mostrarAlternar = aberto || transborda;
    return (
      <div className={cn("mt-1.5 px-0.5", recemChegado && "animate-in fade-in-0 duration-200")}>
        <p className="text-xs font-medium opacity-70">Transcrição</p>
        <p
          ref={textoRef}
          className={cn(
            "text-message whitespace-pre-wrap break-words",
            !aberto && "line-clamp-4",
            texto === "" && "italic opacity-70",
          )}
        >
          {texto === "" ? "Sem fala no áudio." : texto}
        </p>
        {transcricaoCortada(texto) && (
          <p className="mt-0.5 text-xs opacity-70">Transcrição cortada: ouça o fim do áudio.</p>
        )}
        {mostrarAlternar && (
          <button
            type="button"
            onClick={() => setAberto((v) => !v)}
            aria-expanded={aberto}
            className="mt-0.5 text-xs font-medium underline-offset-2 hover:underline"
          >
            {aberto ? "Ver menos" : "Ver mais"}
          </button>
        )}
      </div>
    );
  }

  const erro = estado.fase === "erro" ? estado : null;
  // Desistência gravada ou definitiva: só a mensagem, sem botão. Org sem chave: some o botão.
  if (!erro && (transcricaoImpossivel(metadata) || transcricaoSemChave(organizacaoId, Date.now()))) return null;
  const mostrarBotao = !erro || erro.podeTentar;
  const transcrevendo = estado.fase === "transcrevendo";

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
      {mostrarBotao && (
        <button
          type="button"
          onClick={transcrever}
          disabled={transcrevendo}
          aria-busy={transcrevendo}
          // Ação secundária: link discreto na cor da bolha, sem fundo. O fundo só aparece no
          // hover; -ml-1.5 alinha o ícone com a borda do player sem perder a área de clique de 28 px.
          className={cn(
            "-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium",
            "transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] disabled:pointer-events-none",
            isOutbound
              ? "text-chat-bubble-user-foreground/70 hover:bg-chat-bubble-user-foreground/10 hover:text-chat-bubble-user-foreground"
              : "text-chat-bubble-contact-foreground/70 hover:bg-chat-bubble-contact-foreground/10 hover:text-chat-bubble-contact-foreground",
          )}
        >
          <IconSwap
            active={transcrevendo ? "carregando" : "legenda"}
            durationMs={150}
            icons={{
              legenda: <Captions className="h-3.5 w-3.5" aria-hidden />,
              carregando: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />,
            }}
          />
          {transcrevendo ? "Transcrevendo…" : erro ? "Tentar de novo" : "Transcrever"}
        </button>
      )}
      {erro && <p className="text-xs opacity-80">{erro.mensagem}</p>}
    </div>
  );
}
