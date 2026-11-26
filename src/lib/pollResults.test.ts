import { describe, expect, it } from "vitest";
import { pollVoterName, summarizePoll, type PollData, type PollParticipantRef } from "./pollResults";

const poll = (votes: PollData["votes"], voter_names?: PollData["voter_names"]): PollData => ({
  question: "Jantar?",
  options: ["Sim", "Não", "Talvez"],
  selectable_count: 1,
  votes,
  voter_names,
});

const people: PollParticipantRef[] = [
  { key: "111", name: "Ana" },
  { key: "222", name: "Bia" },
  { key: "333", name: "Caio" },
  { key: "999", name: "Eu", isSelf: true },
];

describe("summarizePoll", () => {
  it("conta votos e calcula a porcentagem sobre quem votou", () => {
    const s = summarizePoll(
      poll({ "111@lid": ["Sim"], "222@lid": ["Sim"], "333@lid": ["Sim"], "444@lid": ["Não"], "555@lid": ["Não"] }),
      undefined,
    );
    expect(s.totalVoters).toBe(5);
    expect(s.options.map((o) => [o.option, o.count, o.pct])).toEqual([
      ["Sim", 3, 60],
      ["Não", 2, 40],
      ["Talvez", 0, 0],
    ]);
  });

  it("pct é 0 sem votos", () => {
    const s = summarizePoll(poll({}), undefined);
    expect(s.totalVoters).toBe(0);
    expect(s.options.every((o) => o.pct === 0)).toBe(true);
    expect(s.leader).toBeNull();
  });

  it("voto retirado fica fora do total e dentro de quem não votou", () => {
    const s = summarizePoll(poll({ "111@lid": ["Sim"], "222@lid": [] }), people);
    expect(s.totalVoters).toBe(1);
    expect(s.nonVoters?.map((p) => p.key)).toEqual(["222", "333"]);
  });

  it("nonVoters exclui a própria linha e é null sem participantes", () => {
    const s = summarizePoll(poll({ "111@lid": ["Sim"] }), people);
    expect(s.nonVoters?.map((p) => p.key)).toEqual(["222", "333"]);
    expect(s.participantsTotal).toBe(3);
    const none = summarizePoll(poll({ "111@lid": ["Sim"] }), undefined);
    expect(none.nonVoters).toBeNull();
    expect(none.participantsTotal).toBeNull();
  });

  it("casa o voto por telefone com o participante", () => {
    const s = summarizePoll(poll({ "111@s.whatsapp.net": ["Sim"] }), people);
    expect(s.nonVoters?.map((p) => p.key)).toEqual(["222", "333"]);
  });

  it("líder: maior contagem, empate fica com a primeira opção", () => {
    const tie = summarizePoll(poll({ "1@lid": ["Não"], "2@lid": ["Sim"] }), undefined);
    expect(tie.leader).toBe("Sim");
    const clear = summarizePoll(poll({ "1@lid": ["Não"], "2@lid": ["Não"], "3@lid": ["Sim"] }), undefined);
    expect(clear.leader).toBe("Não");
  });

  it("mantém a ordem original das opções e a ordem de inserção dos votantes", () => {
    const s = summarizePoll(poll({ "2@lid": ["Não"], "1@lid": ["Não"] }), undefined);
    expect(s.options.map((o) => o.option)).toEqual(["Sim", "Não", "Talvez"]);
    expect(s.options[1].voters.map((v) => v.key)).toEqual(["2", "1"]);
  });
});

describe("pollVoterName", () => {
  const p = poll({}, { "111@lid": "Ana Push", "222@lid": "Você" });

  it("prefere o lookup", () => {
    expect(pollVoterName("111@lid", p, { "111": "Ana Contato" })).toBe("Ana Contato");
  });

  it("cai no nome congelado no voto, inclusive Você", () => {
    expect(pollVoterName("111@lid", p)).toBe("Ana Push");
    expect(pollVoterName("222@lid", p)).toBe("Você");
  });

  it("cai no telefone formatado ou no LID abreviado", () => {
    expect(pollVoterName("5511999998888@s.whatsapp.net", p)).toBe("+55 11 99999-8888");
    expect(pollVoterName("123456789012345@lid", p)).toBe("ID: 1234...2345");
  });

  it("nome congelado vazio é ignorado", () => {
    expect(pollVoterName("333@lid", poll({}, { "333@lid": "" }))).toBe("ID: 333");
  });
});
