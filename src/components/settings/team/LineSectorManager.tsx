import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SECTOR_FALLBACK_COLOR, type Sector } from "@/lib/sectors";
import { Layers, Loader2, Plus, Trash2, Users } from "lucide-react";
import type { CreateSectorInput } from "./schemas";
import { SECTOR_PRESET_COLORS, type TeamMember } from "./types";

interface LineSectorManagerProps {
  phoneNumberId: string;
  lineSectors: Sector[];
  membersWithAccess: TeamMember[];
  onCreateSector: (input: CreateSectorInput) => Promise<boolean>;
  onRequestDeleteSector: (sector: { id: string; name: string }) => void;
}

export const LineSectorManager = ({
  phoneNumberId,
  lineSectors,
  membersWithAccess,
  onCreateSector,
  onRequestDeleteSector,
}: LineSectorManagerProps) => {
  const [newSectorName, setNewSectorName] = useState("");
  const [selectedColor, setSelectedColor] = useState<string>(SECTOR_PRESET_COLORS[0]);
  const [isCreating, setIsCreating] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const handleCreate = async () => {
    if (!newSectorName.trim() || isCreating) return;
    setIsCreating(true);
    const ok = await onCreateSector({
      name: newSectorName.trim(),
      phoneNumberId,
      color: selectedColor,
    });
    setIsCreating(false);
    if (ok) {
      setNewSectorName("");
      setShowAddForm(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          Setores desta linha ({lineSectors.length})
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAddForm((prev) => !prev)}
          className="h-7 gap-1 px-2 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {showAddForm ? "Fechar" : "Novo setor"}
        </Button>
      </div>

      {showAddForm && (
        <div className="flex flex-col gap-2 rounded-md border bg-background p-2.5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1.5">
            {SECTOR_PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setSelectedColor(color)}
                aria-label={`Escolher cor ${color}`}
                className={`h-5 w-5 rounded-full transition-transform ${
                  selectedColor === color
                    ? "scale-110 ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "opacity-75 hover:opacity-100"
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div className="flex flex-1 gap-2">
            <Input
              placeholder="Ex: Comercial, Suporte, Financeiro..."
              value={newSectorName}
              onChange={(e) => setNewSectorName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newSectorName.trim()) {
                  void handleCreate();
                }
              }}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              onClick={() => void handleCreate()}
              disabled={isCreating || !newSectorName.trim()}
              className="h-8 px-3 text-xs"
            >
              {isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Criar"}
            </Button>
          </div>
        </div>
      )}

      {lineSectors.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {lineSectors.map((sector) => {
            const count = membersWithAccess.filter((m) =>
              m.sectorIds.includes(sector.id),
            ).length;
            return (
              <div
                key={sector.id}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: sector.color ?? SECTOR_FALLBACK_COLOR }}
                />
                <span className="font-medium text-foreground">{sector.name}</span>
                {sector.phone_number_id === null && (
                  <span className="rounded bg-muted px-1 py-0.2 text-2xs uppercase text-muted-foreground">
                    global
                  </span>
                )}
                <span
                  className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground"
                  title={`${count} atendente(s) vinculado(s) a este setor`}
                >
                  <Users className="h-2.5 w-2.5" />
                  {count}
                </span>
                <button
                  type="button"
                  onClick={() => onRequestDeleteSector({ id: sector.id, name: sector.name })}
                  aria-label={`Excluir setor ${sector.name}`}
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Nenhum setor criado nesta linha. Clique em <strong>Novo setor</strong> para dividir o atendimento.
        </p>
      )}
    </div>
  );
};
