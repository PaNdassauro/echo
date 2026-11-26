import { useId } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAccessibilityPrefs } from "@/hooks/useAccessibilityPrefs";
import { DEFAULT_A11Y_PREFS, TEXT_SIZES, type A11yPrefs, type TextSize } from "@/lib/accessibilityPrefs";

interface AccessibilitySettingsProps {
  userId: string;
}

const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  sm: "Pequeno",
  md: "Padrão",
  lg: "Grande",
  xl: "Muito grande",
};

/** Amostra "Aa" em tamanhos crescentes: mostra a ordem sem depender da escala atual. */
const TEXT_SIZE_SAMPLE_CLASS: Record<TextSize, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl",
};

const isDefault = (prefs: A11yPrefs) =>
  (Object.keys(DEFAULT_A11Y_PREFS) as (keyof A11yPrefs)[]).every((key) => prefs[key] === DEFAULT_A11Y_PREFS[key]);

export default function AccessibilitySettings({ userId }: AccessibilitySettingsProps) {
  const { prefs, setPrefs, resetPrefs } = useAccessibilityPrefs(userId);
  const atDefault = isDefault(prefs);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Acessibilidade</h2>
        <p className="text-sm text-muted-foreground">Preferências deste navegador</p>
      </div>

      <section aria-labelledby="a11y-app-text" className="space-y-3">
        <h3 id="a11y-app-text" className="text-sm font-medium text-muted-foreground">
          Tamanho do texto do app
        </h3>
        <TextSizePicker
          labelledBy="a11y-app-text"
          value={prefs.appTextSize}
          onChange={(appTextSize) => setPrefs({ appTextSize })}
        />
      </section>

      <section aria-labelledby="a11y-message-text" className="space-y-3">
        <h3 id="a11y-message-text" className="text-sm font-medium text-muted-foreground">
          Tamanho do texto das mensagens
        </h3>
        <TextSizePicker
          labelledBy="a11y-message-text"
          value={prefs.messageTextSize}
          onChange={(messageTextSize) => setPrefs({ messageTextSize })}
        />
        <MessagePreview />
      </section>

      <section aria-labelledby="a11y-motion" className="space-y-3">
        <h3 id="a11y-motion" className="text-sm font-medium text-muted-foreground">
          Movimento
        </h3>
        <ToggleRow
          label="Reduzir animações"
          description="Desliga transições e efeitos de movimento, mesmo que o sistema não peça."
          checked={prefs.reduceMotion}
          onChange={(reduceMotion) => setPrefs({ reduceMotion })}
        />
      </section>

      <section aria-labelledby="a11y-contrast" className="space-y-3">
        <h3 id="a11y-contrast" className="text-sm font-medium text-muted-foreground">
          Contraste
        </h3>
        <ToggleRow
          label="Alto contraste"
          description="Bordas e textos secundários mais fortes."
          checked={prefs.highContrast}
          onChange={(highContrast) => setPrefs({ highContrast })}
        />
      </section>

      <div className="flex justify-end">
        {/* aria-disabled, não disabled: o botão focado que vira disabled joga o
            foco no <body> logo depois de restaurar pelo teclado. */}
        <Button
          type="button"
          variant="outline"
          aria-disabled={atDefault}
          onClick={() => {
            if (!atDefault) resetPrefs();
          }}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Restaurar padrão
        </Button>
      </div>
    </div>
  );
}

interface TextSizePickerProps {
  labelledBy: string;
  value: TextSize;
  onChange: (size: TextSize) => void;
}

function TextSizePicker({ labelledBy, value, onChange }: TextSizePickerProps) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {TEXT_SIZES.map((size) => {
        const selected = value === size;
        return (
          <button
            key={size}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(size)}
            className={cn(
              "relative flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-lg border bg-card px-3 py-2",
              "transition-[border-color,box-shadow,transform] duration-150 ease-out",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "active:scale-[0.96]",
              selected ? "border-primary shadow-sm" : "border-border hover:border-primary/50",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("font-semibold leading-none", TEXT_SIZE_SAMPLE_CLASS[size], selected && "text-primary")}
            >
              Aa
            </span>
            <span className="text-xs text-muted-foreground">{TEXT_SIZE_LABEL[size]}</span>
            {/* Marca que não depende só da cor (mesmo selo do ThemeSettings). */}
            {selected && (
              <span
                aria-hidden="true"
                className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
              >
                <Check className="h-3 w-3" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Bolhas com as classes reais do chat: o `text-message` segue a escala ao vivo. */
function MessagePreview() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
      <div className="max-w-[85%] self-start rounded-2xl bg-chat-bubble-contact px-4 py-2 text-message text-chat-bubble-contact-foreground shadow-sm">
        Oi! Conseguimos ver os detalhes do pedido?
      </div>
      <div className="max-w-[85%] self-end rounded-2xl bg-chat-bubble-user px-4 py-2 text-message text-chat-bubble-user-foreground shadow-sm">
        Claro, já te mando as opções.
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A linha inteira é o switch; a chave é só desenho (nada de <button> aninhado). */
function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-description`}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-4 rounded-lg border bg-card p-3 text-left",
        "transition-colors duration-150 ease-out hover:bg-muted/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
      <span className="min-w-0">
        <span id={`${id}-label`} className="block text-sm font-medium">
          {label}
        </span>
        <span id={`${id}-description`} className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-150 ease-out",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span
          className={cn(
            "block h-5 w-5 rounded-full bg-background shadow-lg transition-transform duration-150 ease-out",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}
