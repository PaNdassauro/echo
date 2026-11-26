import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { useToast } from "@/hooks/use-toast";
import {
  SetupSchema,
  consultarPrecisaSetup,
  enviarSetup,
  lembrarInstalacaoConfigurada,
  mensagemDeErroSetup,
  type ErroSetup,
} from "@/lib/primeiroAcesso";
import { SENHA_MINIMA } from "@/lib/senha";

type Campo = "codigo" | "nome" | "email" | "senha" | "confirmacao" | "organizacao";
type ErrosDeCampo = Partial<Record<Campo, string>>;

/** Primeiro acesso: cria o administrador e a organização da instalação. */
const Setup = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const codigoDaUrl = searchParams.get("codigo")?.trim() ?? "";

  // null = consultando; false = já configurada (vai para /auth); true = mostra o formulário.
  const [precisaSetup, setPrecisaSetup] = useState<boolean | null>(null);
  const [codigo, setCodigo] = useState(codigoDaUrl);
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [organizacao, setOrganizacao] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errosDeCampo, setErrosDeCampo] = useState<ErrosDeCampo>({});
  const [erroGeral, setErroGeral] = useState<ErroSetup | "sem_resposta" | null>(null);

  // Trava síncrona: Enter repetido não pode disparar dois POST antes do re-render.
  const enviandoRef = useRef(false);
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  useEffect(() => {
    const controle = new AbortController();
    void consultarPrecisaSetup(controle.signal).then((precisa) => {
      if (!controle.signal.aborted) setPrecisaSetup(precisa);
    });
    return () => controle.abort();
  }, []);

  if (precisaSetup === null) {
    return (
      <div className="min-h-dvh bg-background flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-4" role="status">
          <Loader2 className="w-8 h-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-muted-foreground">Verificando a instalação…</p>
        </div>
      </div>
    );
  }

  if (!precisaSetup) return <Navigate to="/auth" replace />;

  const jaConfigurada = erroGeral === "ja_configurado";
  // Sem o código na URL (ou com o código recusado) o campo aparece para digitar.
  const mostrarCodigo = codigoDaUrl === "" || erroGeral === "codigo_invalido";
  const confirmacaoDiverge = senha.length > 0 && confirmacao.length > 0 && senha !== confirmacao;

  const limparCampo = (campo: Campo) =>
    setErrosDeCampo((atual) => (atual[campo] ? { ...atual, [campo]: undefined } : atual));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (enviandoRef.current) return;

    setErroGeral(null);
    const lido = SetupSchema.safeParse({ codigo, nome, email, senha, organizacao });
    const erros: ErrosDeCampo = {};
    if (!lido.success) {
      for (const issue of lido.error.issues) {
        const campo = issue.path[0];
        if (typeof campo === "string" && !(campo in erros)) erros[campo as Campo] = issue.message;
      }
    }
    if (senha !== confirmacao) erros.confirmacao = "As senhas não coincidem.";
    if (!lido.success || erros.confirmacao) {
      setErrosDeCampo(erros);
      return;
    }
    setErrosDeCampo({});

    enviandoRef.current = true;
    setEnviando(true);
    try {
      const resultado = await enviarSetup(lido.data);
      if (!montado.current) return;

      if (!resultado.ok) {
        setErroGeral(resultado.erro);
        if (resultado.erro === "ja_configurado") lembrarInstalacaoConfigurada();
        return;
      }

      lembrarInstalacaoConfigurada();
      const { error } = await supabase.auth.signInWithPassword({ email: lido.data.email, password: senha });
      if (!montado.current) return;
      if (error) {
        console.error("[setup] login depois da criação falhou:", error);
        toast({
          title: "Administrador criado",
          description: "Não foi possível entrar sozinho. Entre com o e-mail e a senha que você definiu.",
        });
        navigate("/auth", { replace: true });
        return;
      }
      navigate("/dashboard", { replace: true });
    } finally {
      enviandoRef.current = false;
      if (montado.current) setEnviando(false);
    }
  };

  return (
    <div className="min-h-dvh bg-gradient-to-br from-primary/5 via-background to-accent/5 flex items-center justify-center p-4 safe-area-inset">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1 text-center pt-8 sm:pt-6">
          <div className="flex justify-center mb-4">
            <img src="/echo-logo.png" alt="Echo" className="h-10 sm:h-14" />
          </div>
          <CardTitle>Bem-vindo ao Echo</CardTitle>
          <CardDescription className="text-pretty">
            Crie o administrador da sua instalação. Você poderá convidar o resto da equipe depois.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {jaConfigurada ? (
            <div className="space-y-4 text-center">
              <p role="alert" className="text-sm font-medium text-pretty">
                {mensagemDeErroSetup("ja_configurado")}
              </p>
              <Button asChild className="w-full">
                <Link to="/auth">Entrar</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              {mostrarCodigo && (
                <div className="space-y-2">
                  <Label htmlFor="setup-codigo">Código de instalação</Label>
                  <Input
                    id="setup-codigo"
                    name="codigo"
                    autoComplete="off"
                    autoFocus
                    spellCheck={false}
                    placeholder="Cole o código aqui"
                    value={codigo}
                    onChange={(e) => {
                      setCodigo(e.target.value);
                      limparCampo("codigo");
                      if (erroGeral === "codigo_invalido") setErroGeral(null);
                    }}
                    aria-invalid={errosDeCampo.codigo ? true : undefined}
                    aria-describedby="setup-codigo-ajuda"
                    required
                  />
                  <p id="setup-codigo-ajuda" className="text-xs text-muted-foreground text-pretty">
                    Está no terminal onde você rodou ./install.sh, ou rode ./echo setup-link.
                  </p>
                  {errosDeCampo.codigo && (
                    <p role="alert" className="text-sm text-destructive">
                      {errosDeCampo.codigo}
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="setup-nome">Seu nome</Label>
                <Input
                  id="setup-nome"
                  name="name"
                  autoComplete="name"
                  autoFocus={!mostrarCodigo}
                  placeholder="Ana Souza"
                  value={nome}
                  onChange={(e) => {
                    setNome(e.target.value);
                    limparCampo("nome");
                  }}
                  aria-invalid={errosDeCampo.nome ? true : undefined}
                  required
                />
                {errosDeCampo.nome && (
                  <p role="alert" className="text-sm text-destructive">
                    {errosDeCampo.nome}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-email">E-mail</Label>
                <Input
                  id="setup-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="voce@exemplo.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    limparCampo("email");
                  }}
                  aria-invalid={errosDeCampo.email ? true : undefined}
                  required
                />
                {errosDeCampo.email && (
                  <p role="alert" className="text-sm text-destructive">
                    {errosDeCampo.email}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-senha">Senha</Label>
                <PasswordInput
                  id="setup-senha"
                  name="new-password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={senha}
                  onChange={(e) => {
                    setSenha(e.target.value);
                    limparCampo("senha");
                  }}
                  aria-invalid={errosDeCampo.senha ? true : undefined}
                  aria-describedby="setup-senha-ajuda"
                  required
                />
                <p id="setup-senha-ajuda" className="text-xs text-muted-foreground">
                  Mínimo de {SENHA_MINIMA} caracteres
                </p>
                {errosDeCampo.senha && (
                  <p role="alert" className="text-sm text-destructive">
                    {errosDeCampo.senha}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-confirmacao">Confirmar senha</Label>
                <PasswordInput
                  id="setup-confirmacao"
                  name="confirm-password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirmacao}
                  onChange={(e) => {
                    setConfirmacao(e.target.value);
                    limparCampo("confirmacao");
                  }}
                  aria-invalid={confirmacaoDiverge || errosDeCampo.confirmacao ? true : undefined}
                  required
                />
                {(confirmacaoDiverge || errosDeCampo.confirmacao) && (
                  <p role="alert" aria-live="polite" className="text-sm text-destructive">
                    As senhas não coincidem
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-organizacao">Nome da organização</Label>
                <Input
                  id="setup-organizacao"
                  name="organization"
                  autoComplete="organization"
                  placeholder="Acme"
                  value={organizacao}
                  onChange={(e) => {
                    setOrganizacao(e.target.value);
                    limparCampo("organizacao");
                  }}
                  aria-invalid={errosDeCampo.organizacao ? true : undefined}
                  required
                />
                {errosDeCampo.organizacao && (
                  <p role="alert" className="text-sm text-destructive">
                    {errosDeCampo.organizacao}
                  </p>
                )}
              </div>

              {erroGeral && (
                <p role="alert" aria-live="polite" className="text-sm text-destructive text-pretty">
                  {mensagemDeErroSetup(erroGeral)}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={enviando}>
                {enviando ? "Criando…" : "Criar administrador"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Setup;
