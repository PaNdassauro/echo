/**
 * Setores de um membro numa linha: vínculos (N:N) e qual deles é o padrão.
 *
 * São dois conceitos diferentes, de propósito:
 *
 *   - VÍNCULO (`sector_members`) é acesso. É o que a RLS consulta para decidir
 *     quais conversas o atendente enxerga quando a linha tem isolamento ligado.
 *   - PADRÃO (`organization_members.sector_id`) é um só por membro, e responde
 *     "para qual setor vai a conversa que ele assumir da triagem". É também a
 *     coluna que os relatórios de Analytics agrupam.
 *
 * O padrão só pode ser um setor de que o membro é membro: marcar como padrão um
 * setor sem vínculo daria a ele um destino que ele não consegue ver depois de
 * assumir. Quem garante isso é este componente (a lista de padrão vem dos
 * vínculos) e a checagem de `resolveAssumeSector` em src/lib/sectors.ts, que
 * ignora padrão sem vínculo.
 */

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertTriangle, ChevronDown, Layers, Star } from "lucide-react";
import { SECTOR_FALLBACK_COLOR, type Sector } from "@/lib/sectors";

interface MemberSectorsControlProps {
  /** Setores que valem para a linha desta linha da lista (já filtrados). */
  sectors: Sector[];
  /** Vínculos atuais do membro, entre os setores acima. */
  memberSectorIds: string[];
  /** organization_members.sector_id do membro (pode ser de outra linha). */
  defaultSectorId: string | null;
  onToggle: (sectorId: string, checked: boolean) => void;
  onSetDefault: (sectorId: string | null) => void;
  disabled?: boolean;
  /** Indica se a linha tem isolamento por setor ativo (`phone_numbers.sector_isolation_enabled`). */
  isolationEnabled?: boolean;
  /** Se o membro é Admin da organização (enxerga todos os setores por RLS). */
  isAdminMember?: boolean;
}

const MemberSectorsControl = ({
  sectors,
  memberSectorIds,
  defaultSectorId,
  onToggle,
  onSetDefault,
  disabled,
  isolationEnabled = false,
  isAdminMember = false,
}: MemberSectorsControlProps) => {
  const linked = sectors.filter((sector) => memberSectorIds.includes(sector.id));

  // O padrão pode apontar para setor de outra linha: o radio dele só faz
  // sentido entre os vínculos QUE ESTÃO nesta lista.
  const defaultInThisLine = linked.some((sector) => sector.id === defaultSectorId);

  if (sectors.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
        Sem setores na linha
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-auto min-h-7 max-w-full flex-wrap justify-start gap-1.5 px-2 py-1 text-xs font-normal hover:bg-muted/60"
        >
          {linked.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {linked.map((sector) => {
                const isDefault = sector.id === defaultSectorId;
                const color = sector.color ?? SECTOR_FALLBACK_COLOR;
                return (
                  <span
                    key={sector.id}
                    className="inline-flex items-center gap-1 rounded-md border bg-background/80 px-1.5 py-0.5 text-2xs font-medium"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="truncate max-w-[110px]">{sector.name}</span>
                    {isDefault && (
                      <Star
                        className="h-2.5 w-2.5 shrink-0 fill-amber-400 text-amber-500"
                        aria-label="Setor padrão"
                      />
                    )}
                  </span>
                );
              })}
            </span>
          ) : isAdminMember ? (
            <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <Layers className="h-3 w-3 opacity-70" />
              Todos os setores (Admin)
            </span>
          ) : isolationEnabled ? (
            <span className="inline-flex items-center gap-1 text-2xs text-warning font-medium">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Só triagem (sem setor)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <Layers className="h-3 w-3 opacity-60" />
              Sem setor (visão aberta)
            </span>
          )}
          <ChevronDown className="ml-auto h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {isAdminMember
            ? "Vínculos de setor (Admin já vê todos, mas pode definir padrão)"
            : isolationEnabled
              ? "Setores visíveis para este atendente (isolamento ativo)"
              : "Setores deste atendente (isolamento desligado na linha)"}
        </DropdownMenuLabel>
        {sectors.map((sector) => (
          <DropdownMenuCheckboxItem
            key={sector.id}
            checked={memberSectorIds.includes(sector.id)}
            onCheckedChange={(checked) => onToggle(sector.id, checked)}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: sector.color ?? SECTOR_FALLBACK_COLOR }}
              />
              <span className="truncate">{sector.name}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}

        {linked.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
              Setor padrão ao assumir conversa
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={defaultInThisLine ? (defaultSectorId as string) : "none"}
              onValueChange={(value) => onSetDefault(value === "none" ? null : value)}
            >
              {/* Sem padrão, quem tem um único setor cai nele de
                  todo jeito; só com dois ou mais o app pergunta. */}
              <DropdownMenuRadioItem value="none" onSelect={(e) => e.preventDefault()}>
                Sem padrão definido
              </DropdownMenuRadioItem>
              {linked.map((sector) => (
                <DropdownMenuRadioItem
                  key={sector.id}
                  value={sector.id}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: sector.color ?? SECTOR_FALLBACK_COLOR }}
                    />
                    {sector.name}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default MemberSectorsControl;
