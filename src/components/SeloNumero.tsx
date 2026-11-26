/**
 * Selo do número de onde a conversa é: "● Nome do número".
 *
 * O NOME é o sinal principal: vários números dividem a mesma cor (8 dos 16 de
 * produção usam o mesmo matiz), então o ponto sozinho não diz qual é. O selo NUNCA
 * encolhe para só o ponto, nem na coluna estreita: ali quem cede é o horário, e o nome
 * trunca (com `...`) só se de fato não couber; o nome inteiro segue no `title` e no
 * `aria-label`. Não anima.
 *
 * Na lista, quem chama só renderiza o selo na caixa conjunta (nome nulo no modo número).
 * No cabeçalho do chat e na busca global ele aparece em qualquer modo.
 */

import { corDoNumero } from "@/lib/caixaConjunta";
import { cn } from "@/lib/utils";

/**
 * `className` é para o call site mudar a cor onde o fundo muda (ex.: item destacado da busca,
 * `group-data-[selected=true]:text-accent-foreground`). Não pôr variante na classe-base.
 */
export function SeloNumero({ nome, hue, className }: { nome: string; hue: number | null; className?: string }) {
  const cor = corDoNumero(hue);
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground", className)}
      title={nome}
      role="img"
      aria-label={`Número: ${nome}`}
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: cor }} />
      <span aria-hidden className="truncate">
        {nome}
      </span>
    </span>
  );
}
