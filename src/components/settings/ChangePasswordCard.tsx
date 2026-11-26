import { useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { useToast } from "@/hooks/use-toast";
import { NovaSenhaSchema, SENHA_MINIMA, mensagemDeErroDeSenha } from "@/lib/senha";

/**
 * "Alterar senha" do perfil. Quem entrou com a senha que o administrador gerou
 * (`./echo reset-password`) precisa conseguir trocá-la sem depender de e-mail.
 */
export const ChangePasswordCard = () => {
  const { toast } = useToast();
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const salvandoRef = useRef(false);

  const diverge = senha.length > 0 && confirmacao.length > 0 && senha !== confirmacao;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (salvandoRef.current) return;

    const lido = NovaSenhaSchema.safeParse({ senha, confirmacao });
    if (!lido.success) {
      setErro(lido.error.issues[0]?.message ?? "Confira a senha.");
      return;
    }
    setErro(null);

    salvandoRef.current = true;
    setSalvando(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: lido.data.senha });
      if (error) {
        console.error("[perfil] não foi possível alterar a senha:", error);
        setErro(mensagemDeErroDeSenha(error));
        return;
      }
      setSenha("");
      setConfirmacao("");
      toast({ title: "Senha alterada", description: "Use a nova senha no próximo login." });
    } finally {
      salvandoRef.current = false;
      setSalvando(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-card border rounded-xl p-6 space-y-4" noValidate>
      <div>
        <h3 className="font-medium">Alterar senha</h3>
        <p className="text-sm text-muted-foreground">Mínimo de {SENHA_MINIMA} caracteres</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="profile-new-password">Nova senha</Label>
          <PasswordInput
            id="profile-new-password"
            name="new-password"
            autoComplete="new-password"
            placeholder="••••••••"
            value={senha}
            onChange={(e) => {
              setSenha(e.target.value);
              setErro(null);
            }}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-confirm-password">Confirmar nova senha</Label>
          <PasswordInput
            id="profile-confirm-password"
            name="confirm-password"
            autoComplete="new-password"
            placeholder="••••••••"
            value={confirmacao}
            onChange={(e) => {
              setConfirmacao(e.target.value);
              setErro(null);
            }}
            aria-invalid={diverge ? true : undefined}
            required
          />
        </div>
      </div>

      {(erro || diverge) && (
        <p role="alert" aria-live="polite" className="text-sm text-destructive text-pretty">
          {erro ?? "As senhas não coincidem"}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={salvando || !senha || !confirmacao}>
          {salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Alterar senha
        </Button>
      </div>
    </form>
  );
};
