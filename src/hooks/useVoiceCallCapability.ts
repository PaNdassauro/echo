import { useQuery } from "@tanstack/react-query";
import { voiceCallCapability } from "@/lib/voiceCall";

/**
 * A linha sabe ligar? `GET /call/:id/capability` responde `voice_call: true` só
 * quando a sessão roda a zapo COM o plugin @zapo-js/voip carregado (imagem
 * `Dockerfile.voip`, env VOIP_ENABLED) — hoje isso existe só na cópia de teste.
 *
 * Serve para ESCONDER a interface de ligação onde ela não funcionaria, em vez de
 * oferecer um botão que só descobre no clique que o serviço responde 501. A rota
 * existe em qualquer imagem >= 2.5.0 e devolve false quando não há suporte; num
 * serviço antigo o 404 também vira false.
 *
 * Uma consulta por linha, praticamente imutável dentro da sessão do navegador:
 * capability só muda com troca de imagem/provider, que derruba a sessão de qualquer jeito.
 */
export function useVoiceCallCapability(phoneNumberId: string | null | undefined, enabled = true) {
    return useQuery({
        queryKey: ["voice-call-capability", phoneNumberId],
        queryFn: () => voiceCallCapability(phoneNumberId!),
        enabled: Boolean(phoneNumberId) && enabled,
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        refetchOnWindowFocus: false,
    });
}
