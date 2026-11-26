import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type Previa = { destino: string; nome: string | null; telefone: string | null; viraWhatsApp: boolean };

/**
 * Conversa só do Direct (sem telefone): liga ao WhatsApp do contato (fase 3).
 * Mostra antes para qual card vai — juntar não tem volta pela tela. Se não há WhatsApp com o telefone na linha, esta conversa vira
 * WhatsApp com esse número.
 */
export function JuntarAoWhatsApp({
  conversationId,
  sugestao,
  onJuntada,
}: {
  conversationId: string;
  /** Número que o contato digitou no Direct, para conferir (nunca junta sozinho). */
  sugestao: string;
  onJuntada: (conversaQueFica: string) => void;
}) {
  const { toast } = useToast();
  const [aberto, setAberto] = useState(false);
  const [telefone, setTelefone] = useState("");
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // A sugestão entra só ao abrir: mensagem nova do contato não troca o que a pessoa digitou.
  const abrir = () => {
    setTelefone(sugestao);
    setPrevia(null);
    setAberto(true);
  };

  const erro = (message: string) =>
    toast({ title: "Não deu para ligar ao WhatsApp", description: message.replace(/^Direct: /, ""), variant: "destructive" });

  const conferir = async () => {
    setOcupado(true);
    const { data, error } = await supabase.rpc("instagram_juntar_conversa", {
      p_conversa: conversationId,
      p_telefone: telefone,
      p_so_ver: true,
    });
    if (error || !data) {
      setOcupado(false);
      erro(error?.message ?? "Tente de novo.");
      return;
    }
    if (data === conversationId) {
      setPrevia({ destino: data, nome: null, telefone: null, viraWhatsApp: true });
    } else {
      const { data: alvo } = await supabase
        .from("conversations")
        .select("contact_name, contact_phone")
        .eq("id", data)
        .maybeSingle();
      setPrevia({ destino: data, nome: alvo?.contact_name ?? null, telefone: alvo?.contact_phone ?? null, viraWhatsApp: false });
    }
    setOcupado(false);
  };

  const juntar = async () => {
    setOcupado(true);
    const { data, error } = await supabase.rpc("instagram_juntar_conversa", {
      p_conversa: conversationId,
      p_telefone: telefone,
    });
    setOcupado(false);
    if (error || !data) {
      erro(error?.message ?? "Tente de novo.");
      return;
    }
    setAberto(false);
    toast({ title: "Direct ligado ao WhatsApp do contato" });
    onJuntada(data);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 pb-2 text-xs text-muted-foreground">
        <span>{sugestao ? `Direct sem telefone. O contato mandou ${sugestao}.` : "Direct sem telefone."}</span>
        <Button type="button" variant="outline" size="sm" onClick={abrir}>
          Ligar ao WhatsApp do contato
        </Button>
      </div>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ligar ao WhatsApp do contato</DialogTitle>
            <DialogDescription>
              O Direct e o WhatsApp do contato ficam num card só. A resposta sai pelo canal onde o contato escreveu por
              último.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            inputMode="tel"
            placeholder="Telefone com DDD, ex.: 11 99999-9999"
            value={telefone}
            onChange={(e) => {
              setTelefone(e.target.value);
              setPrevia(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && telefone.trim() && !ocupado) void (previa ? juntar() : conferir());
            }}
          />
          {previa && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              {previa.viraWhatsApp
                ? "Não há WhatsApp com esse número nesta linha. Esta conversa passa a ter esse telefone."
                : `Vai juntar com: ${previa.nome ?? "conversa sem nome"}${previa.telefone ? ` (${previa.telefone})` : ""}. Não dá para separar depois.`}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
            {previa ? (
              <Button type="button" onClick={() => void juntar()} disabled={ocupado}>
                {ocupado ? "Ligando…" : "Confirmar"}
              </Button>
            ) : (
              <Button type="button" onClick={() => void conferir()} disabled={!telefone.trim() || ocupado}>
                {ocupado ? "Conferindo…" : "Conferir"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
