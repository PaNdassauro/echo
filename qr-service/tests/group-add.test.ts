import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAddRefusalMessage, joinGroupAddRefusals, toParticipantJids } from '../src/lib/groupAdd.js';

// Números fictícios: celular com o 9º dígito que o WhatsApp conhece sem ele (DDD 11).
const COM_9 = '5511999990006';
const NO_WHATSAPP = '551199990006@s.whatsapp.net';

test('telefone vai pelo lookup e sai no JID que o WhatsApp reconhece', async () => {
    const pedidos: string[] = [];
    const jids = await toParticipantJids([COM_9], async (digits) => {
        pedidos.push(digits);
        return digits === COM_9 ? NO_WHATSAPP : `${digits}@s.whatsapp.net`;
    });
    assert.deepEqual(jids, [NO_WHATSAPP]);
    assert.deepEqual(pedidos, [COM_9]);
});

test('JID que já vem pronto (LID ou telefone) passa sem lookup', async () => {
    const jids = await toParticipantJids(['123456789@lid', '554199990001@s.whatsapp.net'], async () => {
        throw new Error('não devia consultar');
    });
    assert.deepEqual(jids, ['123456789@lid', '554199990001@s.whatsapp.net']);
});

test('telefone com máscara vira só dígitos antes do lookup', async () => {
    const pedidos: string[] = [];
    await toParticipantJids(['+55 (11) 99999-0006'], async (digits) => {
        pedidos.push(digits);
        return `${digits}@s.whatsapp.net`;
    });
    assert.deepEqual(pedidos, [COM_9]);
});

test('vários números: um lookup por vez, na ordem, sem trocar quem é quem', async () => {
    const emVoo: number[] = [];
    let ativos = 0;
    const jids = await toParticipantJids(['5511999990006', '5511999990007'], async (digits) => {
        ativos += 1;
        emVoo.push(ativos);
        await new Promise((r) => setTimeout(r, 5));
        ativos -= 1;
        return `${digits.slice(0, 4)}${digits.slice(5)}@s.whatsapp.net`;
    });
    assert.deepEqual(jids, ['551199990006@s.whatsapp.net', '551199990007@s.whatsapp.net']);
    assert.deepEqual(emVoo, [1, 1], 'nunca dois lookups ao mesmo tempo');
});

test('entrada sem dígito nenhum não consulta e segue crua, como antes', async () => {
    const jids = await toParticipantJids(['abc'], async () => {
        throw new Error('não devia consultar');
    });
    assert.deepEqual(jids, ['abc@s.whatsapp.net']);
});

test('451 explica que o WhatsApp não reconheceu o número e dá o próximo passo', () => {
    const frase = groupAddRefusalMessage('451');
    assert.match(frase, /não reconheceu este número/);
    assert.match(frase, /link do grupo/);
    assert.doesNotMatch(frase, /Erro 451/);
});

test('408 é quem saiu do grupo há pouco, não número inexistente', () => {
    const frase = groupAddRefusalMessage(408);
    assert.match(frase, /saiu do grupo há pouco/);
    assert.doesNotMatch(frase, /não existe/);
});

test('404 é número inválido', () => {
    assert.match(groupAddRefusalMessage('404'), /Número inválido/);
});

test('cada código da tabela do WhatsApp tem frase própria', () => {
    for (const code of ['400', '401', '402', '403', '404', '406', '407', '409', '412', '417', '419', '421', '451', '500']) {
        assert.doesNotMatch(groupAddRefusalMessage(code), /código/, `código ${code} sem frase`);
    }
});

test('código desconhecido sai com o número e o próximo passo', () => {
    const frase = groupAddRefusalMessage('499');
    assert.match(frase, /código 499/);
    assert.match(frase, /link do grupo/);
});

test('recusas iguais de várias pessoas aparecem uma vez só', () => {
    const a = groupAddRefusalMessage('451');
    const b = groupAddRefusalMessage('409');
    assert.equal(joinGroupAddRefusals([a, a, b]), `${a} ${b}`);
});

// --- Contrato do script de lote ----------------------------------------------------------
// O script de lote da raiz do repositório (bulk-add-group-members) lê a resposta do add pelo TEXTO: uma frase por
// pessoa em `details`, ou todas juntas em `error` quando ninguém entrou (a rota só devolve `error`
// no 400). Cópia fiel da função do script; se ela mudar lá, copiar de novo. O balde da 2.5.16 tem
// de ser o mesmo da 2.5.15.

/** ../scripts/bulk-add-group-members.mjs (raiz do repositório) → classificarMensagem */
function baldeGroupMembers(mensagem: string): string {
    const texto = String(mensagem).toLowerCase();
    if (texto.includes('409') || texto.includes('já é participante') || texto.includes('already')) return 'ja_estava';
    if (texto.includes('408') || texto.includes('não existe no whatsapp')) return 'nao_whatsapp';
    if (texto.includes('not connected') || texto.includes('session not found')) return 'sessao';
    if (texto.includes('403') || texto.includes('not-authorized') || texto.includes('sem permissão')) return 'falhou_penalidade';
    return 'falhou';
}

/** O texto que a 2.5.15 mandava (getBaileysStatusMessage) e como ela juntava várias. */
const ANTIGA: Record<string, string> = {
    '403': 'Sem permissão (você não é admin)',
    '408': 'Número não existe no WhatsApp',
    '409': 'Já é participante do grupo',
    '500': 'Erro interno do WhatsApp',
};
const antiga = (code: string) => ANTIGA[code] ?? `Erro ${code}`;
const CODIGOS = ['400', '401', '402', '403', '404', '406', '407', '408', '409', '412', '417', '419', '421', '451', '499', '500'];

test('contrato do script de lote: cada recusa nova cai no mesmo balde da antiga', () => {
    for (const code of CODIGOS) {
        const nova = groupAddRefusalMessage(code);
        assert.equal(baldeGroupMembers(nova), baldeGroupMembers(antiga(code)), `bulk-add-group-members, código ${code}`);
    }
});

test('contrato do script de lote: lote em que ninguém entra (frases juntas no error) cai no mesmo balde', () => {
    for (const a of CODIGOS) {
        for (const b of CODIGOS) {
            const nova = joinGroupAddRefusals([groupAddRefusalMessage(a), groupAddRefusalMessage(b)]);
            const velha = [...new Set([antiga(a), antiga(b)])].join(', ');
            assert.equal(baldeGroupMembers(nova), baldeGroupMembers(velha), `bulk-add-group-members, ${a} + ${b}`);
        }
    }
});
