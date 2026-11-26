import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeftRight, Instagram, MoreHorizontal, Pencil, Plus, RefreshCw, Unplug } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import {
  useConfigurarInstagram,
  useDesconectarInstagram,
  useIniciarConexaoInstagram,
  useInstagramConexoes,
} from "@/hooks/useInstagramConexoes";
import {
  linhaPodeHospedar,
  resultadoDaConexao,
  rotuloDoTipoDeLinha,
  situacaoDoToken,
  textoDoErroDaConexao,
  type InstagramConexao,
} from "@/lib/instagramConexoes";
import { toUserMessage } from "@/lib/userFacingError";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type LinhaDaOrg = { id: string; display_name: string; connection_type: string | null };

type Dialogo =
  | { tipo: "conectar" }
  | { tipo: "trocar"; conexao: InstagramConexao }
  | { tipo: "renomear"; conexao: InstagramConexao }
  | { tipo: "desconectar"; conexao: InstagramConexao }
  | null;

// Ícones ao lado de texto 400 de 12–14px: traço de 1,5px, par do peso do texto.
const TRACO = 1.5;

const SEM_LINHA = "none";

/** Linhas QR/API da organização; null enquanto carrega (sem isso o diálogo diria "todas ocupadas"). */
function useLinhasDaOrg(orgId: string | undefined): LinhaDaOrg[] | null {
  const [linhas, setLinhas] = useState<LinhaDaOrg[] | null>(null);
  useEffect(() => {
    if (!orgId) return;
    let vivo = true;
    supabase
      .from("phone_numbers")
      .select("id, display_name, connection_type")
      .eq("organization_id", orgId)
      .order("display_name")
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) {
          console.error("[Instagram] leitura das linhas:", error);
          setLinhas([]);
          return;
        }
        setLinhas((data ?? []).filter((l) => linhaPodeHospedar(l.connection_type)));
      });
    return () => {
      vivo = false;
    };
  }, [orgId]);
  return linhas;
}

/** Volta do login do Instagram: ?instagram=<código>&conta=<@> vira aviso e sai da URL. */
function useResultadoDaVolta() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const codigo = searchParams.get("instagram");
  const conta = searchParams.get("conta");
  useEffect(() => {
    if (!codigo) return;
    const resultado = resultadoDaConexao(codigo, conta);
    if (resultado) {
      toast({ title: resultado.titulo, description: resultado.descricao, variant: resultado.erro ? "destructive" : "default" });
    }
    const resto = new URLSearchParams(searchParams);
    resto.delete("instagram");
    resto.delete("conta");
    setSearchParams(resto, { replace: true });
  }, [codigo, conta, searchParams, setSearchParams, toast]);
}

function SeloDoStatus({ conexao }: { conexao: InstagramConexao }) {
  const [texto, cor] =
    conexao.status !== "connected"
      ? conexao.status === "error"
        ? ["Com erro", "bg-destructive/10 text-destructive"]
        : ["Desconectada", "bg-muted text-muted-foreground"]
      : conexao.ligada
        ? ["Ligada", "bg-success/15 text-success"]
        : ["Desligada", "bg-muted text-muted-foreground"];
  return <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded whitespace-nowrap", cor)}>{texto}</span>;
}

function TextoDoToken({ expiraEm }: { expiraEm: string | null }) {
  const situacao = situacaoDoToken(expiraEm);
  if (situacao.tipo === "sem-data") return null;
  if (situacao.tipo === "vencido") return <p className="text-destructive">Acesso vencido: reconecte a conta.</p>;
  if (situacao.tipo === "perto") {
    return <p className="text-warning">Acesso vence em {situacao.dias} {situacao.dias === 1 ? "dia" : "dias"}; o Echo tenta renovar sozinho.</p>;
  }
  return <p>Acesso válido por {situacao.dias} dias</p>;
}

const InstagramConnections = () => {
  const { toast } = useToast();
  const { currentOrganization, isSuperAdmin, userRole } = useOrganization();
  const { data, isLoading, error, refetch, isFetching } = useInstagramConexoes();
  const linhasCarregadas = useLinhasDaOrg(currentOrganization?.id);
  const linhas = linhasCarregadas ?? [];
  const configurar = useConfigurarInstagram();
  const desconectar = useDesconectarInstagram();
  const iniciar = useIniciarConexaoInstagram();
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [linhaEscolhida, setLinhaEscolhida] = useState<string>(SEM_LINHA);
  const [nome, setNome] = useState("");
  useResultadoDaVolta();

  const conexoes = useMemo(
    () => (data ?? []).filter((c) => c.organization_id === currentOrganization?.id),
    [data, currentOrganization?.id],
  );
  const linhasOcupadas = useMemo(() => new Set(conexoes.map((c) => c.linha_id)), [conexoes]);
  // Só admin conecta; o servidor confere de novo (instagram-conexao e as RPCs).
  const podeConectar = isSuperAdmin || userRole === "admin";

  const falhou = (e: unknown) =>
    toast({ title: "Não deu para salvar", description: toUserMessage(e, "Tente de novo."), variant: "destructive" });

  const abrir = (d: Exclude<Dialogo, null>) => {
    setLinhaEscolhida(SEM_LINHA);
    setNome(d.tipo === "renomear" ? d.conexao.display_name : "");
    setDialogo(d);
  };

  const alternar = (conexao: InstagramConexao, ligada: boolean) =>
    configurar.mutate(
      { id: conexao.id, ligada },
      {
        onSuccess: () =>
          toast({
            title: ligada ? "Linha Instagram ligada" : "Linha Instagram desligada",
            description: ligada
              ? `O Direct de ${conexao.display_name} entra na caixa de ${conexao.linha_nome}.`
              : "Mensagens novas do Direct não viram conversa. As que já existem ficam.",
          }),
        onError: falhou,
      },
    );

  const trocar = (conexao: InstagramConexao) =>
    configurar.mutate(
      { id: conexao.id, linha: linhaEscolhida },
      {
        onSuccess: () => {
          setDialogo(null);
          toast({ title: "Caixa trocada", description: "As conversas só do Direct foram junto para a linha nova." });
        },
        onError: falhou,
      },
    );

  const renomear = (conexao: InstagramConexao) =>
    configurar.mutate(
      { id: conexao.id, nome },
      { onSuccess: () => setDialogo(null), onError: falhou },
    );

  const abrindoInstagram = (linhaId: string) => iniciar.isPending && iniciar.variables === linhaId;

  const conectar = (linhaId: string) =>
    iniciar.mutate(linhaId, {
      onError: (e) =>
        toast({ title: "Não deu para abrir o Instagram", description: toUserMessage(e, "Tente de novo."), variant: "destructive" }),
    });

  const linhasLivres = linhas.filter((l) => !linhasOcupadas.has(l.id));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Linhas Instagram</h3>
          <p className="text-xs text-muted-foreground max-w-prose text-pretty">
            Cada conta do Instagram é uma linha própria que divide a caixa com uma linha QR Code ou Business API: o
            Direct aparece nas conversas dessa linha, com o ícone do Instagram.
          </p>
        </div>
        {podeConectar && (
          <Button size="sm" variant="outline" onClick={() => abrir({ tipo: "conectar" })}>
            <Plus />
            Conectar conta
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <p className="text-sm text-destructive">
            {toUserMessage(error, "Não deu para carregar as linhas Instagram.")} Confira a conexão e tente de novo.
          </p>
          <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? "Carregando…" : "Tentar de novo"}
          </Button>
        </div>
      ) : conexoes.length === 0 ? (
        <div className="py-4 text-center space-y-1">
          <p className="text-sm font-medium">Nenhuma conta do Instagram conectada</p>
          <p className="text-xs text-muted-foreground text-pretty">
            {podeConectar
              ? "Conecte uma conta para o Direct aparecer na caixa de uma linha QR Code ou Business API."
              : "Peça a um administrador para conectar a conta do Instagram."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {conexoes.map((conexao, index) => (
            <div
              key={conexao.id}
              className="border rounded-lg p-4 flex flex-col gap-3 bg-card animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards"
              style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, animationDuration: "260ms" }}
            >
              <div className="flex items-start gap-3">
                <span className="grid place-items-center size-8 shrink-0 rounded-full bg-pink-500/15 text-pink-700 dark:text-pink-400">
                  <Instagram className="size-4" strokeWidth={TRACO} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="font-medium text-sm truncate" title={conexao.display_name}>{conexao.display_name}</p>
                    <SeloDoStatus conexao={conexao} />
                  </div>
                  {conexao.ig_username && conexao.display_name !== `@${conexao.ig_username}` && (
                    <p className="text-xs text-muted-foreground break-words">@{conexao.ig_username}</p>
                  )}
                </div>
                {conexao.pode_gerenciar && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Ações de ${conexao.display_name}`}>
                        <MoreHorizontal strokeWidth={TRACO} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => abrir({ tipo: "renomear", conexao })}>
                        <Pencil className="size-4 mr-2" strokeWidth={TRACO} /> Renomear
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => abrir({ tipo: "trocar", conexao })}>
                        <ArrowLeftRight className="size-4 mr-2" strokeWidth={TRACO} /> Trocar a caixa
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => conectar(conexao.linha_id)} disabled={iniciar.isPending}>
                        <RefreshCw className="size-4 mr-2" strokeWidth={TRACO} /> Reconectar
                      </DropdownMenuItem>
                      {conexao.status !== "disconnected" && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => abrir({ tipo: "desconectar", conexao })}
                          >
                            <Unplug className="size-4 mr-2" strokeWidth={TRACO} /> Desconectar
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>

              <div className="text-xs text-muted-foreground space-y-1 min-w-0">
                <p className="break-words">
                  Divide a caixa com{" "}
                  <span className="text-foreground font-medium">{conexao.linha_nome}</span> ({rotuloDoTipoDeLinha(conexao.linha_tipo)})
                </p>
                <p className="tabular-nums">
                  {conexao.conversas_so_direct} só no Direct · {conexao.cards_juntados} juntadas ao WhatsApp
                </p>
                {conexao.status === "connected" && <TextoDoToken expiraEm={conexao.token_expires_at} />}
                {conexao.last_error && (
                  <div className="space-y-1">
                    <p className="text-destructive text-pretty">{textoDoErroDaConexao(conexao.last_error)}</p>
                    <details className="group">
                      <summary className="cursor-pointer select-none hover:text-foreground">Ver detalhe técnico</summary>
                      <p className="mt-1 break-words font-mono text-2xs">{conexao.last_error}</p>
                    </details>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-3 border-t mt-auto">
                <div className="flex items-center gap-2">
                  <Label htmlFor={`ig-ligada-${conexao.id}`} className="text-xs">Ligada</Label>
                  <Switch
                    id={`ig-ligada-${conexao.id}`}
                    checked={conexao.ligada}
                    disabled={
                      !conexao.pode_gerenciar ||
                      conexao.status !== "connected" ||
                      (configurar.isPending && configurar.variables?.id === conexao.id)
                    }
                    onCheckedChange={(ligada) => alternar(conexao, ligada)}
                  />
                </div>
                {(conexao.status !== "connected" || conexao.last_error || abrindoInstagram(conexao.linha_id)) &&
                  conexao.pode_gerenciar && (
                    <Button size="sm" variant="outline" onClick={() => conectar(conexao.linha_id)} disabled={iniciar.isPending}>
                      {abrindoInstagram(conexao.linha_id) ? "Abrindo o Instagram…" : "Reconectar"}
                    </Button>
                  )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogo?.tipo === "conectar"} onOpenChange={(open) => !open && setDialogo(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Conectar conta do Instagram</DialogTitle>
            <DialogDescription>
              Escolha a linha com que a conta vai dividir a caixa. Depois você entra no Instagram com a conta profissional
              e autoriza o Echo. A linha nasce desligada.
            </DialogDescription>
          </DialogHeader>
          {linhasCarregadas !== null && linhasLivres.length === 0 ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              Todas as linhas QR Code e Business API já dividem a caixa com uma conta do Instagram. Desconecte uma conta ou
              adicione uma linha para conectar outra.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="ig-linha-nova">Divide a caixa com</Label>
              <Select value={linhaEscolhida} onValueChange={setLinhaEscolhida}>
                <SelectTrigger id="ig-linha-nova">
                  <SelectValue placeholder="Escolha uma linha" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_LINHA} disabled>Escolha uma linha</SelectItem>
                  {linhas.map((l) => (
                    <SelectItem key={l.id} value={l.id} disabled={linhasOcupadas.has(l.id)}>
                      {l.display_name} ({rotuloDoTipoDeLinha(l.connection_type)})
                      {linhasOcupadas.has(l.id) ? " · já tem Instagram" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogo(null)}>Cancelar</Button>
            <Button onClick={() => conectar(linhaEscolhida)} disabled={linhaEscolhida === SEM_LINHA || iniciar.isPending}>
              {iniciar.isPending ? "Abrindo o Instagram…" : "Continuar no Instagram"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogo?.tipo === "trocar"} onOpenChange={(open) => !open && setDialogo(null)}>
        <DialogContent className="sm:max-w-md">
          {dialogo?.tipo === "trocar" && (
            <>
              <DialogHeader>
                <DialogTitle>Trocar a caixa de {dialogo.conexao.display_name}</DialogTitle>
                <DialogDescription>
                  Hoje divide a caixa com {dialogo.conexao.linha_nome}. As conversas só do Direct vão junto para a linha nova.
                </DialogDescription>
              </DialogHeader>
              {dialogo.conexao.cards_juntados > 0 ? (
                <p className="rounded-md bg-muted px-3 py-2 text-sm">
                  Não dá para trocar: {dialogo.conexao.cards_juntados}{" "}
                  {dialogo.conexao.cards_juntados === 1 ? "conversa já juntou" : "conversas já juntaram"} Direct e WhatsApp
                  em {dialogo.conexao.linha_nome} e ficariam sem resposta pelo Direct.
                </p>
              ) : linhasCarregadas !== null && linhasLivres.length === 0 ? (
                <p className="rounded-md bg-muted px-3 py-2 text-sm">
                  Não há outra linha QR Code ou Business API livre. Cada linha divide a caixa com uma conta só.
                </p>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="ig-linha-troca">Linha nova</Label>
                  <Select value={linhaEscolhida} onValueChange={setLinhaEscolhida}>
                    <SelectTrigger id="ig-linha-troca">
                      <SelectValue placeholder="Escolha uma linha" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_LINHA} disabled>Escolha uma linha</SelectItem>
                      {linhasLivres.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.display_name} ({rotuloDoTipoDeLinha(l.connection_type)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogo(null)}>Cancelar</Button>
                {dialogo.conexao.cards_juntados === 0 && linhasLivres.length > 0 && (
                  <Button
                    onClick={() => trocar(dialogo.conexao)}
                    disabled={linhaEscolhida === SEM_LINHA || configurar.isPending}
                  >
                    {configurar.isPending ? "Trocando…" : "Trocar"}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialogo?.tipo === "renomear"} onOpenChange={(open) => !open && setDialogo(null)}>
        <DialogContent className="sm:max-w-md">
          {dialogo?.tipo === "renomear" && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                renomear(dialogo.conexao);
              }}
            >
              <DialogHeader>
                <DialogTitle>Renomear linha Instagram</DialogTitle>
                <DialogDescription>Em branco, a linha usa o @ da conta.</DialogDescription>
              </DialogHeader>
              <Input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} aria-label="Nome da linha" />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogo(null)}>Cancelar</Button>
                <Button type="submit" disabled={configurar.isPending}>Salvar</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDestructiveDialog
        open={dialogo?.tipo === "desconectar"}
        onOpenChange={(open) => !open && setDialogo(null)}
        title="Desconectar Instagram?"
        description={
          <>
            <strong>{dialogo?.tipo === "desconectar" ? dialogo.conexao.display_name : ""}</strong> para de receber o
            Direct e o acesso ao Instagram é apagado. As conversas e o histórico ficam. Para voltar, use Reconectar.
          </>
        }
        confirmLabel="Desconectar"
        pending={desconectar.isPending}
        onConfirm={() => {
          if (dialogo?.tipo !== "desconectar") return;
          desconectar.mutate(dialogo.conexao.id, {
            onSuccess: () => {
              setDialogo(null);
              toast({ title: "Instagram desconectado" });
            },
            onError: falhou,
          });
        }}
      />
    </div>
  );
};

export default InstagramConnections;
