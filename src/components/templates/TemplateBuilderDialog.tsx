import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bold,
  Braces,
  ExternalLink,
  FileText,
  ImageIcon,
  Italic,
  Loader2,
  Phone,
  Plus,
  Reply,
  Send,
  Strikethrough,
  Trash2,
  Type,
  Video,
} from "lucide-react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import PhoneNumberInput from "@/components/phone/PhoneNumberInput";
import TemplateMediaHeaderInput from "@/components/templates/TemplateMediaHeaderInput";
import TemplatePreview from "@/components/templates/TemplatePreview";
import { insertAtSelection } from "@/lib/insertAtCursor";
import { cn } from "@/lib/utils";
import {
  LIMITS,
  TEMPLATE_LANGUAGES,
  canAddButton,
  draftFromTemplate,
  emptyDraft,
  extractVariables,
  hasGluedFormatting,
  isDynamicUrl,
  newButton,
  nextVariableNumber,
  orderedButtons,
  renumberVariables,
  separateGluedFormatting,
  templateSignature,
  slugifyTemplateName,
  validateDraft,
  variablesOutOfOrder,
  type ButtonKind,
  type DraftButton,
  type HeaderKind,
  type TemplateCategory,
  type TemplateDraft,
} from "@/lib/templateBuilder";
import {
  CATEGORY_REJECTIONS,
  saveTemplate,
  templateErrorMessage,
  type MetaTemplate,
  type SavedTemplate,
} from "@/lib/templatesApi";
import { useIsMobile } from "@/hooks/use-mobile";

interface TemplateBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Template a editar. Sem ele, cria um novo. */
  editing?: MetaTemplate | null;
  /** Nova versão em outro idioma: copia o conteúdo e trava o nome. */
  copyFrom?: MetaTemplate | null;
  /** Idiomas que já existem com o nome de `copyFrom` (somem da lista). */
  usedLanguages?: string[];
  onSaved?: (saved: SavedTemplate) => void;
}

// Template aprovado já tem envio agendado, disparo e integração usando os parâmetros dele.
const STRUCTURE_LOCKED_STATUS = new Set(["APPROVED", "PAUSED"]);

const CATEGORY_OPTIONS: Array<{ value: TemplateCategory; title: string; hint: string }> = [
  {
    value: "UTILITY",
    title: "Utilidade",
    hint: "Aviso sobre algo que o cliente já contratou: confirmação, lembrete, atualização. Mais barato.",
  },
  {
    value: "MARKETING",
    title: "Marketing",
    hint: "Promoção, novidade, convite ou retomar contato com quem sumiu.",
  },
];

const HEADER_OPTIONS: Array<{ value: HeaderKind; label: string; icon: typeof Type | null }> = [
  { value: "NONE", label: "Nenhum", icon: null },
  { value: "TEXT", label: "Texto", icon: Type },
  { value: "IMAGE", label: "Imagem", icon: ImageIcon },
  { value: "VIDEO", label: "Vídeo", icon: Video },
  { value: "DOCUMENT", label: "PDF", icon: FileText },
];

const BUTTON_OPTIONS: Array<{ type: ButtonKind; label: string; hint: string; icon: typeof Reply }> = [
  { type: "QUICK_REPLY", label: "Resposta rápida", hint: "O cliente toca e a resposta chega no chat", icon: Reply },
  { type: "URL", label: "Abrir link", hint: "Site, formulário, pagamento", icon: ExternalLink },
  { type: "PHONE_NUMBER", label: "Ligar", hint: "Liga para um telefone", icon: Phone },
];

const MARKETING_HINT = /\b(promo|promoç|desconto|oferta|cupom|black ?friday|liquida|imperdível|aproveite|% ?off)\b/i;

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className={cn("text-xs tabular-nums", value > max * 0.95 ? "text-warning" : "text-muted-foreground")}>
      {value}/{max}
    </span>
  );
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

export default function TemplateBuilderDialog({
  open,
  onOpenChange,
  editing,
  copyFrom,
  usedLanguages,
  onSaved,
}: TemplateBuilderDialogProps) {
  const { toast } = useToast();
  const { currentOrganization } = useOrganization();
  const isMobile = useIsMobile();
  const mode = editing ? "edit" : "create";
  const copying = !editing && !!copyFrom;
  const categoryEditable = mode === "create" || editing?.status === "REJECTED";
  const languages = TEMPLATE_LANGUAGES.filter((l) => !copying || !usedLanguages?.includes(l.value));

  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
  const [nameInput, setNameInput] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);

  // O rascunho sobrevive a fechar sem querer: só recomeça ao trocar de template
  // (editar outro) ou depois de salvar.
  const seededFor = useRef<string | null>(null);
  const originalSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const key = editing ? `edit:${editing.id}` : copyFrom ? `copy:${copyFrom.id}` : "create";
    if (seededFor.current === key) return;
    seededFor.current = key;
    if (editing) {
      const seeded = draftFromTemplate(editing);
      originalSignature.current = templateSignature(seeded);
      setDraft(seeded);
      setNameInput(editing.name);
    } else if (copyFrom) {
      const free = TEMPLATE_LANGUAGES.find((l) => !usedLanguages?.includes(l.value));
      setDraft({ ...draftFromTemplate(copyFrom), language: free?.value ?? copyFrom.language });
      setNameInput(copyFrom.name);
    } else {
      setDraft(emptyDraft());
      setNameInput("");
    }
    setShowErrors(false);
  }, [open, editing, copyFrom, usedLanguages]);

  // Rascunho de criação sobrevive a fechar; edição cancelada é descartada (reabrir não
  // pode reenviar sem querer uma mudança num template aprovado).
  const close = (next: boolean) => {
    if (!next && mode === "edit") seededFor.current = null;
    onOpenChange(next);
  };

  const update = (patch: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateButton = (key: string, patch: Partial<DraftButton>) =>
    setDraft((d) => ({ ...d, buttons: d.buttons.map((b) => (b.key === key ? { ...b, ...patch } : b)) }));

  const structureChanged =
    !!editing && STRUCTURE_LOCKED_STATUS.has(editing.status) && templateSignature(draft) !== originalSignature.current;
  const errors = useMemo(() => {
    const e = validateDraft(draft, mode);
    if (structureChanged) e.structure = "structure";
    return e;
  }, [draft, mode, structureChanged]);
  const shown = showErrors ? errors : {};
  const variables = extractVariables(draft.body);
  const outOfOrder = variablesOutOfOrder(draft.body);
  const looksLikeMarketing = draft.category === "UTILITY" && MARKETING_HINT.test(draft.body);

  // Botões de formato e variável inserem no cursor, como no composer.
  const insertInBody = (before: string, after = "") => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? start;
    const selected = draft.body.slice(start, end);
    // Formatação colada numa palavra ("teste*a*") o WhatsApp não aplica: separa com espaço.
    const glued = (ch: string | undefined) => !!after && !!ch && /[\p{L}\p{N}]/u.test(ch);
    const lead = glued(draft.body[start - 1]) ? " " : "";
    const trail = glued(draft.body[end]) ? " " : "";
    const { value, caret: endCaret } = insertAtSelection(draft.body, lead + before + selected + after + trail, start, end);
    const caret = endCaret - trail.length;
    update({ body: value });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = selected || !after ? caret : caret - after.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const addVariable = () => insertInBody(`{{${nextVariableNumber(draft.body)}}}`);

  const handleSubmit = async () => {
    if (savingRef.current) return;
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      requestAnimationFrame(() => {
        const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]');
        first?.scrollIntoView({ block: "center", behavior: "smooth" });
        if (first && "focus" in first) first.focus({ preventScroll: true });
      });
      return;
    }
    if (!currentOrganization?.id) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await saveTemplate({
        organizationId: currentOrganization.id,
        draft,
        editing: editing ? { id: editing.id, category: editing.category } : null,
      });
      toast({
        title: saved.status === "APPROVED" ? "Template aprovado" : mode === "edit" ? "Alteração enviada" : "Template enviado para aprovação",
        description:
          saved.status === "APPROVED"
            ? "Já dá para usar."
            : "A Meta costuma responder em poucos minutos. O status aparece na lista de templates.",
      });
      seededFor.current = null;
      setDraft(emptyDraft());
      setNameInput("");
      setShowErrors(false);
      onOpenChange(false);
      onSaved?.(saved);
    } catch (error) {
      console.error("[templates] erro ao salvar", error);
      toast({
        title: mode === "edit" ? "Não foi possível salvar a alteração" : "Não foi possível criar o template",
        description: templateErrorMessage(
          error,
          "Revise os campos e tente de novo. Se a conexão caiu no meio, confira na lista de templates se ele já foi criado.",
        ),
        variant: "destructive",
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !saving && close(o)}>
      <ResponsiveDialogContent className="max-w-4xl max-h-[92vh] flex flex-col gap-0 p-0">
        {/* No celular o drawer já tem padding lateral e rolagem própria: px e rolagem só no desktop. */}
        <ResponsiveDialogHeader className="flex-none pb-4 border-b md:px-6 md:pt-6">
          <ResponsiveDialogTitle>
            {mode === "edit" ? `Editar ${editing?.name}` : copying ? `Nova versão de ${copyFrom?.name}` : "Novo template"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {mode === "edit"
              ? "A alteração volta para a aprovação da Meta. Nome e idioma não mudam."
              : copying
                ? "Mesmo nome em outro idioma. Traduza o texto e os botões."
                : "Mensagem pronta, aprovada pela Meta, para iniciar conversa ou falar fora da janela de 24h."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="flex-1 min-h-0 grid md:grid-cols-[minmax(0,1fr)_320px]">
          <div ref={formRef} className="min-h-0 md:overflow-y-auto md:px-6 py-5 space-y-7">
            <details className="md:hidden rounded-lg border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Ver prévia no WhatsApp</summary>
              <div className="px-3 pb-3">
                <TemplatePreview draft={draft} />
              </div>
            </details>

            {structureChanged && (
              <div role="alert" data-invalid="true" tabIndex={-1} className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <p className="font-medium text-destructive">Essa mudança quebra envios que já usam este template.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Template aprovado não pode mudar a quantidade de variáveis, o link com parte variável nem o tipo do
                  cabeçalho: agendamentos, disparos e integrações mandam os dados no formato antigo. Para isso, crie um
                  template novo.
                </p>
              </div>
            )}

            {/* 1. Identificação */}
            {categoryEditable && (
              <section className="space-y-4" aria-labelledby="tb-sec-sobre">
                <h3 id="tb-sec-sobre" className="text-sm font-semibold">{mode === "edit" ? "Categoria" : "Sobre o template"}</h3>
                {mode === "create" && (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                  <div className="space-y-1.5">
                    <Label htmlFor="tb-name">Nome</Label>
                    <Input
                      id="tb-name"
                      value={nameInput}
                      readOnly={copying}
                      // No celular o foco abre o teclado por cima do drawer.
                      autoFocus={!isMobile && !copying}
                      aria-invalid={shown.name ? true : undefined}
                      aria-describedby="tb-name-hint"
                      placeholder="Ex.: Confirmação de reserva"
                      onChange={(e) => {
                        setNameInput(e.target.value);
                        update({ name: slugifyTemplateName(e.target.value) });
                      }}
                    />
                    {shown.name ? (
                      <FieldError id="tb-name-hint" message={shown.name} />
                    ) : (
                      <p id="tb-name-hint" className="text-xs text-muted-foreground">
                        {copying ? (
                          "O nome é o mesmo em todos os idiomas."
                        ) : draft.name ? (
                          <>Aparece assim na lista: <code className="font-mono text-foreground">{draft.name}</code>. O cliente não vê.</>
                        ) : (
                          "Para a equipe achar o template depois. O cliente não vê."
                        )}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tb-lang">Idioma</Label>
                    <Select value={draft.language} onValueChange={(v) => update({ language: v })}>
                      <SelectTrigger id="tb-lang">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {languages.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                )}

                <div className="space-y-1.5">
                  <Label id="tb-cat-label">Tipo de mensagem</Label>
                  {editing && CATEGORY_REJECTIONS.has(editing.rejected_reason ?? "") && (
                    <p className="text-xs text-warning">A Meta recusou pela categoria. Troque aqui e reenvie.</p>
                  )}
                  <div role="radiogroup" aria-labelledby="tb-cat-label" className="grid gap-2 sm:grid-cols-2">
                    {CATEGORY_OPTIONS.map((c) => {
                      const selected = draft.category === c.value;
                      return (
                        <button
                          key={c.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          // A Meta usa a mesma categoria em todos os idiomas do nome.
                          disabled={copying}
                          onClick={() => update({ category: c.value })}
                          className={cn(
                            "text-left rounded-lg border p-3 transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                            "disabled:pointer-events-none disabled:opacity-60",
                          )}
                        >
                          <span className="flex items-center gap-2 text-sm font-medium">
                            <span
                              aria-hidden
                              className={cn(
                                "h-3.5 w-3.5 rounded-full border",
                                selected ? "border-[4px] border-primary" : "border-muted-foreground/50",
                              )}
                            />
                            {c.title}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">{c.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                  {looksLikeMarketing && (
                    <p className="text-xs text-warning">
                      O texto parece promocional. A Meta pode aprovar como Marketing, que custa mais.
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* 2. Mensagem */}
            <section className="space-y-4" aria-labelledby="tb-sec-msg">
              <h3 id="tb-sec-msg" className="text-sm font-semibold">Mensagem</h3>

              <div className="space-y-1.5">
                <Label id="tb-header-label">Cabeçalho <span className="font-normal text-muted-foreground">(opcional)</span></Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={draft.headerType}
                  onValueChange={(v) => v && update({ headerType: v as HeaderKind })}
                  aria-labelledby="tb-header-label"
                  className="flex-wrap justify-start"
                >
                  {HEADER_OPTIONS.map((h) => (
                    <ToggleGroupItem key={h.value} value={h.value} className="gap-1.5">
                      {h.icon && <h.icon className="h-3.5 w-3.5" aria-hidden />}
                      {h.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {draft.headerType === "TEXT" && (
                  <div className="space-y-1">
                    <div className="relative">
                      <Input
                        value={draft.headerText}
                        aria-label="Texto do cabeçalho"
                        aria-invalid={shown.header ? true : undefined}
                        maxLength={LIMITS.headerText}
                        placeholder="Ex.: Sua reserva está confirmada"
                        onChange={(e) => update({ headerText: e.target.value })}
                        className="pr-14"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2">
                        <Counter value={draft.headerText.length} max={LIMITS.headerText} />
                      </span>
                    </div>
                    <FieldError message={shown.header} />
                  </div>
                )}
                {(draft.headerType === "IMAGE" || draft.headerType === "VIDEO" || draft.headerType === "DOCUMENT") && (
                  <div className="space-y-1" data-invalid={shown.header ? "true" : undefined} tabIndex={-1}>
                    <TemplateMediaHeaderInput
                      key={draft.headerType}
                      format={draft.headerType}
                      value={draft.headerMedia?.format === draft.headerType ? draft.headerMedia : null}
                      onChange={(m) => update({ headerMedia: m })}
                      organizationId={currentOrganization?.id}
                      storagePrefix="template-samples"
                    />
                    <FieldError message={shown.header} />
                    <p className="text-xs text-muted-foreground">
                      É só um exemplo para a Meta aprovar. Em cada envio você escolhe o arquivo de verdade.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-end justify-between gap-2">
                  <Label htmlFor="tb-body">Texto</Label>
                  <Counter value={draft.body.length} max={LIMITS.body} />
                </div>
                <div
                  className={cn(
                    "rounded-md border border-input focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background",
                    shown.body && "border-destructive",
                  )}
                >
                  <div className="flex items-center gap-0.5 border-b px-1.5 py-1">
                    <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={addVariable}>
                      <Braces className="h-3.5 w-3.5" aria-hidden />
                      Variável
                    </Button>
                    <span className="mx-1 h-4 w-px bg-border" aria-hidden />
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Negrito" onClick={() => insertInBody("*", "*")}>
                      <Bold className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Itálico" onClick={() => insertInBody("_", "_")}>
                      <Italic className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Riscado" onClick={() => insertInBody("~", "~")}>
                      <Strikethrough className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Textarea
                    id="tb-body"
                    ref={bodyRef}
                    value={draft.body}
                    maxLength={LIMITS.body}
                    rows={5}
                    aria-invalid={shown.body ? true : undefined}
                    aria-describedby="tb-body-hint"
                    placeholder={"Ex.: Olá {{1}}, sua reserva para {{2}} está confirmada. Qualquer dúvida, é só responder aqui."}
                    onChange={(e) => update({ body: e.target.value })}
                    className="min-h-[120px] resize-y border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
                {shown.body ? (
                  <FieldError id="tb-body-hint" message={shown.body} />
                ) : (
                  <p id="tb-body-hint" className="text-xs text-muted-foreground">
                    Variável é o trecho que muda a cada envio, como o nome do cliente. Use o botão Variável.
                  </p>
                )}
                {hasGluedFormatting(draft.body) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warning">
                    <span>O WhatsApp só formata quando o * ou ~ não encosta na palavra de antes.</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => update({ body: separateGluedFormatting(draft.body) })}
                    >
                      Separar
                    </Button>
                  </div>
                )}
                {outOfOrder && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const r = renumberVariables(draft.body, draft.examples);
                      update({ body: r.text, examples: r.examples });
                    }}
                  >
                    Corrigir numeração das variáveis
                  </Button>
                )}
              </div>

              {variables.length > 0 && (
                <div className="space-y-2 rounded-lg bg-muted/50 p-3">
                  <div>
                    <p className="text-sm font-medium">Exemplos das variáveis</p>
                    <p className="text-xs text-muted-foreground">
                      A Meta usa para entender a mensagem. Não vai para o cliente.
                    </p>
                  </div>
                  {variables.map((n) => {
                    const err = shown[`examples.${n}`];
                    return (
                      <div key={n} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <code className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{`{{${n}}}`}</code>
                          <Input
                            value={draft.examples[String(n)] ?? ""}
                            aria-label={`Exemplo da variável ${n}`}
                            aria-invalid={err ? true : undefined}
                            placeholder={n === 1 ? "Ex.: Maria" : "Ex.: 12/11"}
                            onChange={(e) => update({ examples: { ...draft.examples, [String(n)]: e.target.value } })}
                            className="h-9 bg-background"
                          />
                        </div>
                        {err && <p role="alert" className="pl-14 text-xs text-destructive">{err}</p>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="tb-footer">Rodapé <span className="font-normal text-muted-foreground">(opcional)</span></Label>
                <div className="relative">
                  <Input
                    id="tb-footer"
                    value={draft.footer}
                    maxLength={LIMITS.footer}
                    aria-invalid={shown.footer ? true : undefined}
                    placeholder="Ex.: Acme"
                    onChange={(e) => update({ footer: e.target.value })}
                    className="pr-14"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Counter value={draft.footer.length} max={LIMITS.footer} />
                  </span>
                </div>
                <FieldError message={shown.footer} />
              </div>
            </section>

            {/* 3. Botões */}
            <section className="space-y-3" aria-labelledby="tb-sec-btn">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 id="tb-sec-btn" className="text-sm font-semibold">Botões <span className="font-normal text-muted-foreground">(opcional)</span></h3>
                  <p className="text-xs text-muted-foreground">Até 10. Links no máximo 2 e ligação 1.</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={draft.buttons.length >= LIMITS.buttonsTotal}>
                      <Plus className="mr-1 h-4 w-4" aria-hidden />
                      Adicionar botão
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    {BUTTON_OPTIONS.map((o) => (
                      <DropdownMenuItem
                        key={o.type}
                        disabled={!canAddButton(draft.buttons, o.type)}
                        onSelect={() => update({ buttons: [...draft.buttons, newButton(o.type)] })}
                        className="items-start gap-2"
                      >
                        <o.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span>
                          <span className="block text-sm">{o.label}</span>
                          <span className="block text-xs text-muted-foreground">{o.hint}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <FieldError message={shown.buttons} />

              {draft.buttons.some((b) => b.type === "QUICK_REPLY") && draft.buttons.some((b) => b.type !== "QUICK_REPLY") && (
                <div className="flex flex-wrap items-center gap-2">
                  <span id="tb-btn-order" className="text-xs text-muted-foreground">Aparecem primeiro:</span>
                  <ToggleGroup
                    type="single"
                    size="sm"
                    variant="outline"
                    value={draft.quickRepliesFirst ? "quick" : "actions"}
                    onValueChange={(v) => v && update({ quickRepliesFirst: v === "quick" })}
                    aria-labelledby="tb-btn-order"
                  >
                    <ToggleGroupItem value="actions" className="h-8 text-xs">Link e ligar</ToggleGroupItem>
                    <ToggleGroupItem value="quick" className="h-8 text-xs">Respostas rápidas</ToggleGroupItem>
                  </ToggleGroup>
                </div>
              )}
              {draft.buttons.length > 3 && (
                <p className="text-xs text-muted-foreground">
                  Com mais de 3 botões o WhatsApp mostra os 2 primeiros e guarda o resto em "Ver todas as opções".
                </p>
              )}

              {/* Na ordem em que vão para a Meta (cada grupo junto). */}
              {orderedButtons(draft).map((b) => {
                const k = `buttons.${b.key}`;
                const opt = BUTTON_OPTIONS.find((o) => o.type === b.type)!;
                return (
                  <div key={b.key} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <opt.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="text-xs font-medium text-muted-foreground">{opt.label}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Remover botão ${b.text || opt.label}`}
                        onClick={() => update({ buttons: draft.buttons.filter((x) => x.key !== b.key) })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="relative">
                      <Input
                        value={b.text}
                        maxLength={LIMITS.buttonText}
                        aria-label="Texto do botão"
                        aria-invalid={shown[`${k}.text`] ? true : undefined}
                        placeholder={b.type === "QUICK_REPLY" ? "Ex.: Confirmar" : b.type === "URL" ? "Ex.: Ver reserva" : "Ex.: Falar com a gente"}
                        onChange={(e) => updateButton(b.key, { text: e.target.value })}
                        className="pr-14"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2">
                        <Counter value={b.text.length} max={LIMITS.buttonText} />
                      </span>
                    </div>
                    <FieldError message={shown[`${k}.text`]} />

                    {b.type === "URL" && (
                      <>
                        <Input
                          value={b.url}
                          inputMode="url"
                          aria-label="Link do botão"
                          aria-invalid={shown[`${k}.url`] ? true : undefined}
                          placeholder="https://seusite.com.br/reserva"
                          onChange={(e) => updateButton(b.key, { url: e.target.value })}
                        />
                        <FieldError message={shown[`${k}.url`]} />
                        {isDynamicUrl(b.url) ? (
                          <div className="space-y-1">
                            <Input
                              value={b.urlExample}
                              aria-label="Exemplo do final do link"
                              aria-invalid={shown[`${k}.urlExample`] ? true : undefined}
                              placeholder="Exemplo do final do link. Ex.: R12345"
                              onChange={(e) => updateButton(b.key, { urlExample: e.target.value })}
                            />
                            <FieldError message={shown[`${k}.urlExample`]} />
                          </div>
                        ) : /^https?:\/\/[^\s/]+\.[^\s]+/.test(b.url.trim()) &&
                          // Query no meio (…?id=5) não tem onde pôr a parte variável sem quebrar o valor.
                          (!b.url.includes("?") || /[=?]$/.test(b.url.trim())) &&
                          !draft.buttons.some((x) => x.type === "URL" && isDynamicUrl(x.url)) && (
                          <button
                            type="button"
                            className="text-xs text-primary underline-offset-2 hover:underline"
                            onClick={() => {
                              const url = b.url.trim();
                              // "…?ref=" e "…/" recebem o {{1}} direto; o resto ganha uma barra.
                              updateButton(b.key, { url: /[=?/]$/.test(url) ? `${url}{{1}}` : `${url}/{{1}}` });
                            }}
                          >
                            O final do link muda a cada envio? Adicionar parte variável
                          </button>
                        )}
                      </>
                    )}

                    {b.type === "PHONE_NUMBER" && (
                      <div data-invalid={shown[`${k}.phone`] ? "true" : undefined} tabIndex={-1}>
                        <PhoneNumberInput
                          value={b.phone}
                          onChange={(digits) => updateButton(b.key, { phone: digits })}
                          error={shown[`${k}.phone`]}
                        />
                        {!b.phone && <FieldError message={shown[`${k}.phone`]} />}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          </div>

          {/* Prévia */}
          <aside className="hidden md:flex min-h-0 flex-col gap-2 overflow-y-auto border-l bg-muted/30 p-5" aria-label="Prévia">
            <p className="text-xs font-medium text-muted-foreground">Prévia no WhatsApp</p>
            <TemplatePreview draft={draft} />
          </aside>
        </div>

        {/* No celular o rodapé fica preso embaixo da rolagem do drawer. */}
        <ResponsiveDialogFooter className="flex-none gap-2 border-t py-4 md:px-6 max-md:sticky max-md:bottom-0 max-md:bg-background">
          {showErrors && Object.keys(errors).length > 0 && (
            <p role="status" className="mr-auto self-center text-xs text-destructive">
              {Object.keys(errors).length === 1 ? "1 campo precisa de ajuste." : `${Object.keys(errors).length} campos precisam de ajuste.`}
            </p>
          )}
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Send className="mr-2 h-4 w-4" aria-hidden />}
            {saving ? "Enviando…" : "Enviar para aprovação"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
