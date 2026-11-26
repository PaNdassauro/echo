/**
 * Adicionar gente em grupo: o número que vai ao WhatsApp e a frase de cada recusa.
 *
 * Existe porque o painel pode mandar o número do cadastro com o 9º dígito, e o WhatsApp
 * conhece contas antigas (ex.: DDD 61) sem ele. Montar
 * `${digitos}@s.whatsapp.net` cru faz o servidor tratar o número como "não é usuário do WhatsApp"
 * e responder 451, que chegava na tela como "Erro 451". O envio de mensagem nunca teve esse
 * problema porque passa pelo `resolveOutboundJid` (lookup).
 */

/**
 * Telefones → JIDs de participante, na ordem recebida. JID que já vem com `@` (LID, PN
 * resolvido) passa intacto. Telefone vai pelo `resolvePhone`, que no SessionManager é o
 * `resolveOutboundJid` do envio: mesmo lookup, mesmo cache (achado 6 h; inexistente, 10 min),
 * e número que o lookup não acha, ou consulta que falha, segue no JID cru, como era antes:
 * quem dá a palavra final é o WhatsApp, na resposta do add.
 *
 * Uma consulta por número, em série, como no envio. O painel adiciona uma pessoa por clique e a
 * echo-api cria grupo vazio; o "Criar grupo" do painel e o `scripts/bulk-add-group-members.mjs`
 * (na raiz deste repositório; lotes de 1 a 10 por chamada, padrão 5, 60 s entre lotes) fazem várias seguidas, e o cache
 * poupa as repetidas. Checar muitos números em série é o padrão que o anti-abuso vigia (ver
 * `resolveOutboundJid`): não aumentar o lote por causa disto.
 */
export async function toParticipantJids(
    participants: readonly string[],
    resolvePhone: (digits: string) => Promise<string>
): Promise<string[]> {
    const jids: string[] = [];
    for (const participant of participants) {
        if (participant.includes('@')) {
            jids.push(participant);
            continue;
        }
        const digits = participant.replace(/\D/g, '');
        jids.push(digits ? await resolvePhone(digits) : `${participant}@s.whatsapp.net`);
    }
    return jids;
}

/**
 * Recusa POR PESSOA no `<add>`, com o nome que o próprio WhatsApp dá a cada código (parser
 * `WASmaxGroupsAddParticipantsRPC` do WhatsApp Web, lido no código do WhatsApp Web). Vale só para ADICIONAR:
 * remover, promover e aprovar pedido seguem no `getBaileysStatusMessage`, porque o mesmo número
 * pode querer dizer outra coisa nessas ações. O 403 com `<add_request>` não chega aqui: vira
 * convite (`inviteRequired`).
 *
 * Contrato com o script de lote da raiz deste repositório, que classifica pelo TEXTO, frase sozinha ou várias
 * juntas no `error` (`bulk-add-group-members.mjs` → `classificarMensagem`): cada frase tem as
 * mesmas palavras-chave da frase antiga (2.5.15). Por isso o 409 segue igual, o 403 diz "sem permissão" sem o número 403, o 408
 * leva "408", e nenhuma outra frase tem "já é participante", "409", "408", "403", "sem permissão",
 * "não existe no WhatsApp", "already" ou "not-authorized".
 * Teste: tests/group-add.test.ts ("contrato do script de lote").
 */
const GROUP_ADD_REFUSALS: Readonly<Record<string, string>> = {
    // ParticipantNotFound
    '400': 'O WhatsApp não encontrou esta pessoa. Confira o número.',
    // ParticipantNotAuthorized: pode ser a pessoa ter bloqueado esta linha, então o link vai por outra.
    '401': 'O WhatsApp não autorizou adicionar esta pessoa. Peça a outra pessoa da equipe que fala com ela para mandar o link do grupo.',
    // ParticipantInBanList
    '402': 'O WhatsApp não deixa esta pessoa entrar neste grupo agora.',
    // ParticipantForbidden (403 sem convite)
    '403': 'O WhatsApp recusou, sem permissão para adicionar esta pessoa. Mande o link do grupo para ela.',
    // ParticipantHasInvalidPN
    '404': 'Número inválido no WhatsApp. Confira o DDD e o número.',
    // ParticipantNotAcceptable
    '406': 'O WhatsApp não aceitou adicionar esta pessoa. Mande o link do grupo para ela.',
    // ParticipantWorkUserNotAllowed
    '407': 'Esta conta de trabalho não pode entrar neste grupo.',
    // ParticipantTemporarilyBlocked
    '408': 'Esta pessoa saiu do grupo há pouco, e o WhatsApp ainda não deixa adicionar de volta (código 408). Mande o link do grupo para ela.',
    // ParticipantConflict
    '409': 'Já é participante do grupo',
    // ParticipantParentLinkedGroupsResourceConstraint (grupo de comunidade)
    '412': 'O WhatsApp recusou por um limite da comunidade deste grupo.',
    // ParticipantTemporarilyBlockedFromDefaultSubGroup (grupo geral da comunidade)
    '417': 'O WhatsApp não deixa adicionar esta pessoa ao grupo geral da comunidade por enquanto. Mande o link do grupo para ela.',
    // ParticipantResourceLimit
    '419': 'O grupo está cheio.',
    // ParticipantGroupJoinRequest: conta como recusa (a pessoa ainda não está no grupo).
    '421': 'Ainda não entrou: o grupo pede aprovação, e falta um admin aprovar o pedido no painel do grupo.',
    // ParticipantRequestCodeCannotBeCreatedForLegalConcerns: o servidor tratou o número como
    // quem não é usuário do WhatsApp e não pode convidar para o app fora dos EUA.
    '451': 'O WhatsApp não reconheceu este número. Confira o DDD e o número. Se estiver certo, mande o link do grupo para a pessoa.',
    // ParticipantResourceConstraint
    '500': 'O WhatsApp não conseguiu adicionar agora. Tente de novo em alguns minutos.',
};

/** Frase para a tela, já com o próximo passo. Código desconhecido sai com o número, para quem for investigar. */
export function groupAddRefusalMessage(status: string | number): string {
    return GROUP_ADD_REFUSALS[String(status)]
        ?? `O WhatsApp recusou adicionar esta pessoa (código ${status}). Mande o link do grupo para ela.`;
}

/** Junta as recusas de várias pessoas sem repetir a mesma frase. */
export function joinGroupAddRefusals(messages: readonly string[]): string {
    return [...new Set(messages)].join(' ');
}
