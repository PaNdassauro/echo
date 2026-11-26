import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Plus, Search, UserPlus } from "lucide-react";
import type { TeamMember } from "./types";

interface LinkMemberPopoverProps {
  phoneDisplayName: string;
  membersWithoutAccess: TeamMember[];
  onGrantAccess: (userId: string) => void;
}

export const LinkMemberPopover = ({
  phoneDisplayName,
  membersWithoutAccess,
  onGrantAccess,
}: LinkMemberPopoverProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return membersWithoutAccess;
    return membersWithoutAccess.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        (m.email ?? "").toLowerCase().includes(q),
    );
  }, [membersWithoutAccess, query]);

  if (membersWithoutAccess.length === 0) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs shrink-0">
          <UserPlus className="h-3.5 w-3.5" />
          Vincular ({membersWithoutAccess.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2.5 space-y-2">
        <div className="px-1">
          <p className="text-xs font-semibold text-foreground truncate">
            Liberar acesso a {phoneDisplayName}
          </p>
          <p className="text-2xs text-muted-foreground">
            Clique em um membro para vincular a este número
          </p>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filtrar membro..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="max-h-56 overflow-y-auto divide-y rounded-md border bg-background">
          {filtered.length === 0 ? (
            <p className="p-3 text-center text-xs text-muted-foreground">
              Nenhum membro encontrado
            </p>
          ) : (
            filtered.map((m) => (
              <button
                key={m.userId}
                type="button"
                onClick={() => onGrantAccess(m.userId)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar className="h-6 w-6 shrink-0 border">
                    {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={m.displayName} />}
                    <AvatarFallback className="bg-primary/10 text-2xs font-semibold text-primary">
                      {m.initials}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate font-medium text-foreground">
                    {m.displayName}
                  </span>
                </span>
                <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
