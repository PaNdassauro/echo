import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { toUserMessage } from "@/lib/userFacingError";
import { isRecoveryLinkRejected, readRecoveryLink } from "@/lib/passwordRecovery";
import { consultarPrecisaSetup } from "@/lib/primeiroAcesso";
import { SENHA_MINIMA } from "@/lib/senha";
import { getRuntimeFeatures } from "@/lib/runtimeConfig";

// Supabase devolve erros de auth em inglês cru ("Invalid login credentials").
// Mapeia os conhecidos pra pt-BR; mensagens já em português passam intactas.
const AUTH_ERROR_PT: Array<[RegExp, string]> = [
  [/invalid login credentials/i, "E-mail ou senha incorretos."],
  [/email not confirmed/i, "Confirme seu e-mail antes de entrar — verifique sua caixa de entrada."],
  [/user already registered|already been registered/i, "Este e-mail já tem uma conta. Faça login."],
  [/password should be at least/i, `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`],
  [/should be different from the old password/i, "A nova senha precisa ser diferente da atual."],
  [/rate limit|too many requests|for security purposes/i, "Muitas tentativas. Aguarde um instante e tente novamente."],
  [/failed to fetch|network/i, "Falha de conexão. Verifique sua internet e tente novamente."],
];

const translateAuthError = (message: string | undefined): string => {
  if (!message) return "Algo deu errado. Tente novamente.";
  for (const [pattern, translated] of AUTH_ERROR_PT) {
    if (pattern.test(message)) return translated;
  }
  return message;
};

// Recuperação de senha: erro conhecido em pt-BR; o resto nunca sai cru na tela.
const recoveryErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : undefined;
  const known = AUTH_ERROR_PT.find(([pattern]) => message !== undefined && pattern.test(message));
  return known ? known[1] : toUserMessage(error, fallback);
};

type AuthView = "default" | "forgot_password" | "recovery_sent" | "update_password" | "recovery_invalid";

// Sem e-mail (SMTP) o Auth não consegue mandar o link: a pessoa pede ao administrador.
const EsqueciSenha = ({ disponivel, onClick }: { disponivel: boolean; onClick: () => void }) =>
  disponivel ? (
    <div className="text-center">
      <Button variant="link" className="text-xs text-muted-foreground" onClick={onClick} type="button">
        Esqueci minha senha
      </Button>
    </div>
  ) : (
    <p className="text-center text-xs text-muted-foreground text-pretty">
      Esqueceu a senha? Peça ao administrador da instalação um link de nova senha.
    </p>
  );

interface InvitationData {
  id: string;
  email: string;
  phone_number_id: string;
  organization_id: string;
  expires_at: string;
  phone_numbers: {
    display_name: string;
  };
}

const Auth = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const recuperacaoSenha = getRuntimeFeatures().recuperacaoSenha;
  const [isLoading, setIsLoading] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signUpError, setSignUpError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InvitationData | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(false);
  const [defaultTab, setDefaultTab] = useState("signin");
  // Lido uma vez, na montagem: o Supabase limpa o hash depois de processar.
  const [recoveryLink] = useState(() => readRecoveryLink(window.location.search, window.location.hash));
  const [view, setView] = useState<AuthView>(() =>
    recoveryLink === null ? "default" : recoveryLink.kind === "invalid" ? "recovery_invalid" : "update_password",
  );

  // Reset password state
  const [resetEmail, setResetEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    const token = searchParams.get("invite");
    if (token) {
      setInviteToken(token);
      setDefaultTab("signup");
      fetchInvitation(token);
    }
  }, [searchParams]);

  // Instalação nova: quem abre /auth direto vai para o primeiro acesso.
  useEffect(() => {
    const controle = new AbortController();
    void consultarPrecisaSetup(controle.signal).then((precisa) => {
      if (precisa && !controle.signal.aborted) navigate("/setup", { replace: true });
    });
    return () => controle.abort();
  }, [navigate]);

  // Enquanto a recuperação está em curso (inclusive na tela de link vencido),
  // sessão existente não redireciona para o dashboard.
  const recoveryDetected = useRef(recoveryLink !== null);
  // O token do link é de uso único: depois de trocado por sessão, uma nova
  // tentativa de gravar a senha não pode chamar o verifyOtp de novo.
  const recoveryTokenUsed = useRef(false);

  useEffect(() => {
    const checkUser = async () => {
      // Use getUser() to validate the session with the server prevents redirect loops 
      // when local storage might still contain a stale token after logout
      const { data: { user } = { user: null } } = await supabase.auth.getUser(); // Added default value for data
      if (user) {
        // If user is already logged in and has an invite, process it
        if (inviteToken && invitation) {
          await processInvitation(user.id);
        }

        // Don't redirect if we're in the middle of a password recovery
        if (!recoveryDetected.current) {
          navigate("/dashboard");
        }
      }
    };
    checkUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        // Process invitation after signup/login
        if (inviteToken && invitation && event === "SIGNED_IN") {
          await processInvitation(session.user.id);
        }

        if (event === "PASSWORD_RECOVERY") {
          setView("update_password");
          recoveryDetected.current = true; // Ensure ref is set
          return; // Don't redirect to dashboard yet
        }

        if (!recoveryDetected.current) {
          navigate("/dashboard");
        }
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate, inviteToken, invitation]);

  const fetchInvitation = async (token: string) => {
    setLoadingInvite(true);

    // Use RPC function to bypass RLS and get phone details safely
    const { data, error } = await supabase
      .rpc('get_invitation_by_token', { token_input: token })
      .single();

    setLoadingInvite(false);

    if (error || !data) {
      toast({
        title: "Convite inválido",
        description: "Este convite não existe ou já foi utilizado",
        variant: "destructive",
      });
      setInviteToken(null);
      return;
    }

    // Check if expired
    if (new Date(data.expires_at) < new Date()) {
      toast({
        title: "Convite expirado",
        description: "Este convite já expirou",
        variant: "destructive",
      });
      setInviteToken(null);
      return;
    }

    // Map RPC result to component state structure
    const invitationData: InvitationData = {
      id: data.id,
      email: data.email,
      phone_number_id: data.phone_number_id,
      organization_id: data.organization_id,
      expires_at: data.expires_at,
      phone_numbers: {
        display_name: data.phone_display_name
      }
    };

    setInvitation(invitationData);
    setEmail(data.email);

    // If user is already logged in (returning from email confirmation), process invitation immediately
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      try {
        const { data: rpcData, error: rpcError } = await supabase
          .rpc('accept_invitation', {
            token_input: token,
            user_id_input: session.user.id
          });

        if (rpcError) throw rpcError;

        const result = rpcData as any;
        if (result && !result.success) {
          throw new Error(result.error || "Falha ao processar convite");
        }

        toast({
          title: "Bem-vindo",
          description: `Você agora tem acesso ao número ${data.phone_display_name}`,
        });
      } catch (err: any) {
        console.error("Error processing invitation:", err);
        toast({
          title: "Não foi possível aceitar convite",
          description: toUserMessage(err),
          variant: "destructive"
        });
      }
      navigate("/dashboard");
    }
  };

  const processInvitation = async (userId: string) => {
    if (!invitation) return;

    try {
      // Use secure RPC to accept invitation and set up access
      const { data, error } = await supabase
        .rpc('accept_invitation', {
          token_input: inviteToken || '', // Use the token from state or params
          user_id_input: userId
        });

      if (error) throw error;

      // Check for custom logic error from RPC
      const result = data as any;
      if (result && !result.success) {
        throw new Error(result.error || "Falha ao processar convite");
      }

      toast({
        title: "Bem-vindo",
        description: `Você agora tem acesso ao número ${invitation.phone_numbers.display_name}`,
      });
    } catch (error: any) {
      console.error("Error processing invitation:", error);
      toast({
        title: "Não foi possível aceitar convite",
        description: toUserMessage(error),
        variant: "destructive"
      });
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setSignInError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      toast({
        title: "Login bem-sucedido",
        description: "Redirecionando para as conversas…",
      });
    } catch (error: any) {
      setSignInError(translateAuthError(error.message));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setSignUpError(null);

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: inviteToken
            ? `${window.location.origin}/auth?invite=${inviteToken}`
            : `${window.location.origin}/dashboard`,
          data: {
            full_name: fullName,
          },
        },
      });

      if (error) throw error;

      // Com a confirmação de e-mail desligada (instalação sem SMTP) a sessão já volta.
      if (data.session) {
        toast({ title: "Conta criada", description: "Você já pode usar o Echo." });
      } else {
        toast({
          title: "Confirme seu e-mail",
          description: "Enviamos um link de confirmação. Confirme e faça login para continuar.",
        });
      }
    } catch (error: any) {
      setSignUpError(translateAuthError(error.message));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // O Auth responde igual para e-mail com e sem conta, e limita a
      // frequência por e-mail. O link volta para o domínio em que a pessoa está.
      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
        redirectTo: `${window.location.origin}/auth`,
      });

      if (error) throw error;

      setView("recovery_sent");
    } catch (error: unknown) {
      console.error("Erro ao pedir recuperação de senha:", error);
      toast({
        title: "Não foi possível enviar o e-mail",
        description: recoveryErrorMessage(error, "Verifique a conexão e tente novamente."),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast({
        title: "Senhas não coincidem",
        description: "A senha e a confirmação devem ser iguais.",
        variant: "destructive",
      });
      return;
    }

    if (newPassword.length < SENHA_MINIMA) {
      toast({
        title: "Senha curta demais",
        description: `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`,
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);

    try {
      if (recoveryLink?.kind === "token" && !recoveryTokenUsed.current) {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: recoveryLink.tokenHash,
          type: "recovery",
        });

        if (verifyError) {
          if (isRecoveryLinkRejected(verifyError)) {
            setNewPassword("");
            setConfirmPassword("");
            setView("recovery_invalid");
            return;
          }
          throw verifyError;
        }
        recoveryTokenUsed.current = true;
        // O token já foi gasto: sai da URL. O `#type=recovery` faz a página
        // recarregada voltar para esta tela (a sessão já existe) em vez de
        // tentar o token de novo e dizer que o link venceu.
        window.history.replaceState(window.history.state, "", "/auth#type=recovery");
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) throw error;

      // Clean up recovery state
      recoveryDetected.current = false;
      setNewPassword("");
      setConfirmPassword("");
      setView("default");

      toast({
        title: "Senha atualizada",
        description: "Sua senha foi redefinida.",
      });

      navigate("/dashboard");
    } catch (error: unknown) {
      console.error("Erro ao gravar a nova senha:", error);
      toast({
        title: "Não foi possível atualizar a senha",
        description: recoveryErrorMessage(error, "Verifique a conexão e tente novamente."),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Sai da recuperação e tira o token ou o erro da URL.
  const leaveRecovery = async (next: AuthView) => {
    recoveryDetected.current = false;
    navigate("/auth", { replace: true });
    setView(next);
    // Quem já está logado e só quer voltar não precisa do formulário de login.
    if (next === "default") {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) navigate("/dashboard");
    }
  };

  if (loadingInvite) {
    return (
      <div className="min-h-dvh bg-gradient-to-br from-primary/5 via-background to-accent/5 flex items-center justify-center p-4 safe-area-inset">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Verificando convite…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-gradient-to-br from-primary/5 via-background to-accent/5 flex items-center justify-center p-4 safe-area-inset">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1 text-center pt-8 sm:pt-6">
          <div className="flex justify-center mb-4">
            <img src="/echo-logo.png" alt="Echo" className="h-10 sm:h-14" />
          </div>
          {invitation ? (
            <CardDescription>
              Você foi convidado para acessar{" "}
              <span className="font-semibold text-primary">
                {invitation.phone_numbers.display_name}
              </span>
            </CardDescription>
          ) : (
            <CardDescription>Gestão profissional de mensagens WhatsApp</CardDescription>
          )}
        </CardHeader>

        <CardContent>
          {view === 'forgot_password' ? (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-email">E-mail da sua conta</Label>
                <Input
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="seu@email.com"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Enviando…" : "Enviar link de nova senha"}
              </Button>
              <Button
                variant="link"
                className="w-full"
                onClick={() => setView('default')}
                type="button"
              >
                Voltar para entrar
              </Button>
            </form>
          ) : view === 'recovery_sent' ? (
            <div className="space-y-4 text-center">
              <p className="text-sm font-medium">Confira seu e-mail</p>
              <p className="text-sm text-muted-foreground text-pretty">
                Se existir uma conta com <span className="font-medium text-foreground break-all">{resetEmail.trim()}</span>,
                o link para criar uma nova senha chega em instantes. Ele vale por 1 hora, e só o link mais recente funciona.
              </p>
              <p className="text-xs text-muted-foreground">Não chegou? Olhe a caixa de spam.</p>
              <Button variant="outline" className="w-full" onClick={() => setView('default')} type="button">
                Voltar para entrar
              </Button>
            </div>
          ) : view === 'recovery_invalid' ? (
            <div className="space-y-4 text-center">
              <p role="alert" className="text-sm font-medium">Este link venceu ou já foi usado</p>
              <p className="text-sm text-muted-foreground text-pretty">
                O link de nova senha vale por 1 hora e funciona uma vez só. Peça outro e use o e-mail mais recente.
              </p>
              <Button className="w-full" onClick={() => leaveRecovery('forgot_password')} type="button">
                Pedir novo link
              </Button>
              <Button variant="link" className="w-full" onClick={() => leaveRecovery('default')} type="button">
                Voltar para entrar
              </Button>
            </div>
          ) : view === 'update_password' ? (
            <form onSubmit={handleUpdatePassword} className="space-y-4">
              <p className="text-sm text-muted-foreground text-center mb-2">
                Digite sua nova senha abaixo.
              </p>
              <div className="space-y-2">
                <Label htmlFor="new-password">Nova senha</Label>
                <PasswordInput
                  id="new-password"
                  name="new-password"
                  autoComplete="new-password"
                  autoFocus
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={SENHA_MINIMA}
                />
                <p className="text-xs text-muted-foreground">Mínimo de {SENHA_MINIMA} caracteres</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirmar nova senha</Label>
                <PasswordInput
                  id="confirm-password"
                  name="confirm-password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  aria-invalid={
                    newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword
                      ? true
                      : undefined
                  }
                  required
                  minLength={SENHA_MINIMA}
                />
              </div>
              {/* Antes ficava DEPOIS do submit — fora do caminho de leitura */}
              {newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword && (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  As senhas não coincidem
                </p>
              )}
              <Button type="submit" className="w-full" disabled={isLoading || (newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword)}>
                {isLoading ? "Atualizando…" : "Atualizar senha"}
              </Button>
            </form>
          ) : invitation ? (
            // Show tabs only when there's an invitation
            <Tabs defaultValue={defaultTab} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Entrar</TabsTrigger>
                <TabsTrigger value="signup">Criar conta (convite)</TabsTrigger>
              </TabsList>
              <TabsContent value="signin">
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="p-3 rounded-lg bg-primary/10 text-sm text-center mb-4">
                    Se você já tem uma conta, faça login para aceitar o convite
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signin-email">Email</Label>
                    <Input
                      id="signin-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="seu@email.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setSignInError(null);
                      }}
                      aria-invalid={signInError ? true : undefined}
                      className={signInError ? "border-destructive" : undefined}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signin-password">Senha</Label>
                    <PasswordInput
                      id="signin-password"
                      name="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setSignInError(null);
                      }}
                      aria-invalid={signInError ? true : undefined}
                      className={signInError ? "border-destructive" : undefined}
                      required
                    />
                  </div>
                  {signInError && (
                    <p role="alert" aria-live="polite" className="text-sm text-destructive">
                      {signInError}
                    </p>
                  )}
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? "Entrando…" : "Entrar"}
                  </Button>
                  <EsqueciSenha
                    disponivel={recuperacaoSenha}
                    onClick={() => {
                      setView('forgot_password');
                      setResetEmail(email);
                    }}
                  />
                </form>
              </TabsContent>
              <TabsContent value="signup">
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="p-3 rounded-lg bg-green-500/10 text-sm text-center mb-4 text-green-700 dark:text-green-300">
                    Crie sua conta para acessar{" "}
                    <span className="font-semibold">
                      {invitation.phone_numbers.display_name}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-name">Nome completo</Label>
                    <Input
                      id="signup-name"
                      name="name"
                      type="text"
                      autoComplete="name"
                      placeholder="Seu nome"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="seu@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      readOnly
                      className="bg-muted"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Senha</Label>
                    <PasswordInput
                      id="signup-password"
                      name="new-password"
                      autoComplete="new-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setSignUpError(null);
                      }}
                      aria-invalid={signUpError ? true : undefined}
                      className={signUpError ? "border-destructive" : undefined}
                      required
                      minLength={SENHA_MINIMA}
                    />
                  </div>
                  {signUpError && (
                    <p role="alert" aria-live="polite" className="text-sm text-destructive">
                      {signUpError}
                    </p>
                  )}
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? "Criando conta…" : "Criar conta"}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          ) : (
            // Only show sign-in form when there's no invitation
            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setSignInError(null);
                  }}
                  aria-invalid={signInError ? true : undefined}
                  className={signInError ? "border-destructive" : undefined}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signin-password">Senha</Label>
                <PasswordInput
                  id="signin-password"
                  name="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setSignInError(null);
                  }}
                  aria-invalid={signInError ? true : undefined}
                  className={signInError ? "border-destructive" : undefined}
                  required
                />
              </div>
              {signInError && (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  {signInError}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Entrando…" : "Entrar"}
              </Button>
              <EsqueciSenha
                disponivel={recuperacaoSenha}
                onClick={() => {
                  setView('forgot_password');
                  setResetEmail(email);
                }}
              />
            </form>
          )}
        </CardContent>
      </Card>
    </div >
  );
};

export default Auth;