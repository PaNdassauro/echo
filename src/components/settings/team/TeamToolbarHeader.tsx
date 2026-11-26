import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Layers,
  Lock,
  Search,
  ShieldCheck,
  Smartphone,
  UserPlus,
  Users,
} from "lucide-react";
import type { MemberRoleFilter, TeamViewMode } from "./types";

interface TeamToolbarHeaderProps {
  totalMembers: number;
  adminCount: number;
  agentCount: number;
  isolatedLinesCount: number;
  totalLinesCount: number;
  viewMode: TeamViewMode;
  roleFilter: MemberRoleFilter;
  searchQuery: string;
  onChangeViewMode: (mode: TeamViewMode) => void;
  onChangeRoleFilter: (filter: MemberRoleFilter) => void;
  onChangeSearchQuery: (query: string) => void;
  onOpenInvite: () => void;
}

export const TeamToolbarHeader = ({
  totalMembers,
  adminCount,
  agentCount,
  isolatedLinesCount,
  totalLinesCount,
  viewMode,
  roleFilter,
  searchQuery,
  onChangeViewMode,
  onChangeRoleFilter,
  onChangeSearchQuery,
  onOpenInvite,
}: TeamToolbarHeaderProps) => {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => {
            onChangeViewMode("members");
            onChangeRoleFilter("all");
          }}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition-colors ${
            viewMode === "members" && roleFilter === "all"
              ? "border-primary bg-primary/5"
              : "bg-card hover:bg-muted/40"
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" /> Total da equipe
          </span>
          <span className="text-xl font-bold text-foreground">{totalMembers}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            onChangeViewMode("members");
            onChangeRoleFilter(roleFilter === "admin" ? "all" : "admin");
          }}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition-colors ${
            viewMode === "members" && roleFilter === "admin"
              ? "border-primary bg-primary/5"
              : "bg-card hover:bg-muted/40"
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Admins (Acesso total)
          </span>
          <span className="text-xl font-bold text-foreground">{adminCount}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            onChangeViewMode("members");
            onChangeRoleFilter(roleFilter === "agent" ? "all" : "agent");
          }}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition-colors ${
            viewMode === "members" && roleFilter === "agent"
              ? "border-primary bg-primary/5"
              : "bg-card hover:bg-muted/40"
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Layers className="h-3.5 w-3.5" /> Atendentes (Por linha)
          </span>
          <span className="text-xl font-bold text-foreground">{agentCount}</span>
        </button>

        <button
          type="button"
          onClick={() => onChangeViewMode("lines")}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition-colors ${
            viewMode === "lines" ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" /> Linhas isoladas por setor
          </span>
          <span className="text-xl font-bold text-foreground">
            {isolatedLinesCount}/{totalLinesCount}
          </span>
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={
              viewMode === "members"
                ? "Buscar por nome, e-mail ou setor..."
                : "Buscar número ou nome da linha..."
            }
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border bg-muted/40 p-1">
            <button
              type="button"
              onClick={() => onChangeViewMode("lines")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === "lines"
                  ? "bg-background text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" /> Por Número
            </button>
            <button
              type="button"
              onClick={() => onChangeViewMode("members")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === "members"
                  ? "bg-background text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Users className="h-3.5 w-3.5" /> Por Membro
            </button>
          </div>

          <Button onClick={onOpenInvite} className="gap-1.5">
            <UserPlus className="h-4 w-4" /> Convidar membro
          </Button>
        </div>
      </div>
    </div>
  );
};
