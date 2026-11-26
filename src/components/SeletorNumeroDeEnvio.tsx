import { Label } from "@/components/ui/label";
import { corDoNumero } from "@/lib/caixaConjunta";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface OpcaoDeNumero {
  id: string;
  displayName: string;
  themeHue: number | null;
}

/** Número por onde uma conversa nova pode sair: o que o envio precisa saber dele. */
export interface NumeroDeEnvio extends OpcaoDeNumero {
  /** `phone_numbers.phone_number_id`: o id da Meta que as edges de envio pedem. */
  metaPhoneNumberId: string;
  /** 'qr' = texto livre; qualquer outro valor exige template (Cloud API). */
  connectionType: string | null;
}

/**
 * "Enviar pelo número": a escolha do número ao criar conversa ou grupo quando o
 * escopo tem mais de um. Valores são uuids reais (nunca um sentinela) e o valor é
 * sempre controlado: o pai passa o número que já resolveu, com padrão.
 */
export function SeletorNumeroDeEnvio({
  id,
  opcoes,
  valor,
  onChange,
}: {
  id: string;
  opcoes: readonly OpcaoDeNumero[];
  valor: string;
  onChange: (numeroId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        Enviar pelo número
      </Label>
      <Select value={valor} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Escolha o número" />
        </SelectTrigger>
        <SelectContent>
          {opcoes.map((opcao) => (
            <SelectItem key={opcao.id} value={opcao.id}>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: corDoNumero(opcao.themeHue) }}
                />
                <span className="truncate">{opcao.displayName}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
