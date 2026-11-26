import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { siteUrl } from "@/lib/runtimeConfig";
import {
  SendInviteResponseSchema,
  estadoDoEmail,
  type ConviteCriado,
  type ResultadoConvites,
} from "./inviteResult";
import {
  createSectorSchema,
  inviteMemberSchema,
  type CreateSectorInput,
  type InviteMemberInput,
} from "./schemas";
import type { TeamCoreState } from "./useTeamManagement";

export function useTeamActions(core: TeamCoreState) {
  const { toast } = useToast();
  const { orgId, members, setMembers, phoneNumbers, refreshAll } = core;

  const updateDefaultSector = async (targetUserId: string, sectorId: string | null) => {
    if (!orgId) return;
    const prevMembers = members;
    setMembers((curr) =>
      curr.map((m) => (m.userId === targetUserId ? { ...m, defaultSectorId: sectorId } : m)),
    );
    const { error } = await supabase
      .from("organization_members")
      .update({ sector_id: sectorId })
      .eq("user_id", targetUserId)
      .eq("organization_id", orgId);

    if (error) {
      setMembers(prevMembers);
      toast({
        title: "Não foi possível atualizar setor padrão",
        description: toUserMessage(error),
        variant: "destructive",
      });
    }
  };

  const toggleMemberSector = async (targetUserId: string, sectorId: string, checked: boolean) => {
    const prevMembers = members;
    const targetMember = members.find((m) => m.userId === targetUserId);
    setMembers((curr) =>
      curr.map((m) => {
        if (m.userId !== targetUserId) return m;
        const nextIds = checked
          ? Array.from(new Set([...m.sectorIds, sectorId]))
          : m.sectorIds.filter((id) => id !== sectorId);
        return { ...m, sectorIds: nextIds };
      }),
    );

    const { error } = checked
      ? await supabase.from("sector_members").insert({ sector_id: sectorId, user_id: targetUserId })
      : await supabase.from("sector_members").delete().eq("sector_id", sectorId).eq("user_id", targetUserId);

    if (error) {
      setMembers(prevMembers);
      toast({
        title: checked ? "Erro ao vincular setor" : "Erro ao desvincular setor",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return;
    }

    if (!checked && targetMember?.defaultSectorId === sectorId) {
      await updateDefaultSector(targetUserId, null);
    }
  };

  const createSector = async (rawInput: CreateSectorInput): Promise<boolean> => {
    if (!orgId) return false;
    const parsed = createSectorSchema.safeParse(rawInput);
    if (!parsed.success) {
      toast({
        title: "Dados inválidos",
        description: parsed.error.issues[0]?.message ?? "Preencha o setor corretamente.",
        variant: "destructive",
      });
      return false;
    }
    const { name, phoneNumberId, color } = parsed.data;
    const { error } = await supabase.from("sectors").insert({
      organization_id: orgId,
      phone_number_id: phoneNumberId,
      name,
      color: color ?? null,
    });
    if (error) {
      toast({
        title: "Não foi possível criar setor",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return false;
    }
    toast({ title: "Setor criado", description: `O setor "${name}" foi adicionado à linha.` });
    await refreshAll();
    return true;
  };

  const deleteSector = async (sectorId: string): Promise<boolean> => {
    const { error } = await supabase.from("sectors").delete().eq("id", sectorId);
    if (error) {
      toast({
        title: "Não foi possível excluir setor",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return false;
    }
    toast({ title: "Setor excluído" });
    await refreshAll();
    return true;
  };

  /**
   * Cria os convites (um por número). Devolve o que a tela precisa mostrar, ou
   * null quando falhou (o toast de erro já saiu). Pessoa que já tem conta é
   * vinculada na hora; pessoa nova ganha um link por número, que o diálogo
   * mostra para copiar: sem e-mail na instalação, o link é a única entrega.
   */
  const sendInvitations = async (rawInput: InviteMemberInput): Promise<ResultadoConvites | null> => {
    const parsed = inviteMemberSchema.safeParse(rawInput);
    if (!parsed.success) {
      toast({
        title: "Verifique os campos do convite",
        description: parsed.error.issues[0]?.message ?? "Preencha e-mail e número.",
        variant: "destructive",
      });
      return null;
    }
    const { email, phoneNumberIds } = parsed.data;
    try {
      let vinculados = 0;
      const criados: ConviteCriado[] = [];

      for (const phoneNumberId of phoneNumberIds) {
        const { data, error } = await supabase.functions.invoke<unknown>(
          "send-invitation",
          { body: { email, phoneNumberId } },
        );
        if (error) throw error;
        const resposta = SendInviteResponseSchema.parse(data ?? {});
        if (resposta.existingUser) {
          vinculados += 1;
          continue;
        }
        const url = resposta.invitation?.inviteUrl;
        if (!url) throw new Error("O convite foi criado, mas a resposta veio sem o link. Veja a lista de convites pendentes.");
        criados.push({
          phoneNumberId,
          phoneNumberName:
            resposta.invitation?.phoneNumberName ??
            phoneNumbers.find((p) => p.id === phoneNumberId)?.display_name ??
            "Número",
          url,
          email: estadoDoEmail(resposta),
        });
      }

      if (vinculados > 0 && criados.length === 0) {
        toast({
          title: "Membro vinculado",
          description:
            phoneNumberIds.length === 1
              ? "O usuário já possuía conta e recebeu acesso ao número selecionado."
              : `O usuário já possuía conta e recebeu acesso a ${phoneNumberIds.length} números.`,
        });
      }
      await refreshAll();
      return { vinculados, criados };
    } catch (error: unknown) {
      toast({
        title: "Não foi possível enviar convite",
        description: toUserMessage(error),
        variant: "destructive",
      });
      return null;
    }
  };

  const deleteInvitation = async (invitationId: string) => {
    const { error } = await supabase.from("user_invitations").delete().eq("id", invitationId);
    if (error) {
      toast({ title: "Não foi possível excluir convite", description: toUserMessage(error), variant: "destructive" });
      return;
    }
    toast({ title: "Convite cancelado" });
    await refreshAll();
  };

  const copyInviteLink = async (token: string) => {
    const link = `${siteUrl()}/auth?invite=${token}`;
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copiado", description: "O link de convite foi copiado para a área de transferência." });
    } catch (error: unknown) {
      // Sem HTTPS o navegador recusa o clipboard: mostra o link para copiar à mão.
      console.warn("[convite] o navegador recusou a cópia:", error);
      toast({ title: "Não foi possível copiar sozinho", description: link });
    }
  };

  return {
    updateDefaultSector,
    toggleMemberSector,
    createSector,
    deleteSector,
    sendInvitations,
    deleteInvitation,
    copyInviteLink,
  };
}
