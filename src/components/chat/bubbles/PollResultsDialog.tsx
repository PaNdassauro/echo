import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initialsFor } from "@/lib/conversationAssignees";
import type { PollData, PollSummary } from "@/lib/pollResults";

interface PollResultsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poll: PollData;
  summary: PollSummary;
}

function PersonList({ people }: { people: Array<{ key: string; name: string }> }) {
  return (
    <ul className="space-y-1.5">
      {people.map((person) => (
        <li key={person.key} className="flex items-center gap-2 text-sm">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs">{initialsFor(person.name)}</AvatarFallback>
          </Avatar>
          <span className="truncate">{person.name}</span>
        </li>
      ))}
    </ul>
  );
}

function describeTotals(summary: PollSummary): string {
  const { totalVoters, participantsTotal } = summary;
  if (totalVoters === 0) return "Nenhum voto ainda";
  if (participantsTotal !== null) {
    return `${totalVoters} de ${participantsTotal} participantes votaram`;
  }
  return totalVoters === 1 ? "1 voto" : `${totalVoters} votos`;
}

/**
 * Painel de resultados da enquete: votantes por opção (ordenadas por contagem)
 * e, em grupo com a lista carregada, quem ainda não votou. O conteúdo só monta
 * com o painel aberto.
 */
export function PollResultsDialog({ open, onOpenChange, poll, summary }: PollResultsDialogProps) {
  // sort estável: empate mantém a ordem original das opções
  const sorted = open ? [...summary.options].sort((a, b) => b.count - a.count) : [];
  const { nonVoters } = summary;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="break-words [overflow-wrap:anywhere]">
            {poll.question}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{describeTotals(summary)}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {open && (
          <div className="max-h-[70dvh] space-y-4 overflow-y-auto">
            {sorted.map((result) => (
              <section key={result.option} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="min-w-0 truncate text-sm font-medium">{result.option}</h3>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {result.count} · {result.pct}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${result.pct}%` }}
                  />
                </div>
                {result.voters.length > 0 ? (
                  <PersonList people={result.voters} />
                ) : (
                  <p className="text-sm text-muted-foreground">Ninguém ainda</p>
                )}
              </section>
            ))}

            {nonVoters !== null && (
              <section className="space-y-1.5">
                {nonVoters.length > 0 ? (
                  <>
                    <h3 className="text-sm font-medium">Ainda não votaram ({nonVoters.length})</h3>
                    <PersonList people={nonVoters} />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Todos já votaram</p>
                )}
              </section>
            )}
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
