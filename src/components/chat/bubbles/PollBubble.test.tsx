import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PollBubble } from "./PollBubble";
import type { PollData, PollParticipantRef } from "@/lib/pollResults";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

afterEach(cleanup);

const poll = (votes: PollData["votes"], voter_names?: PollData["voter_names"]): PollData => ({
  question: "Quem vai ao jantar?",
  options: ["Sim", "Não"],
  selectable_count: 1,
  votes,
  voter_names,
});

const fiveVotes = poll(
  {
    "111@lid": ["Sim"],
    "222@lid": ["Sim"],
    "333@lid": ["Sim"],
    "444@lid": ["Não"],
    "555@lid": ["Não"],
  },
  {
    "111@lid": "Ana Souza",
    "222@lid": "Bia Lima",
    "333@lid": "Caio Reis",
    "444@lid": "Duda Melo",
    "555@lid": "Edu Costa",
  },
);

const participants: PollParticipantRef[] = [
  { key: "111", name: "Ana Souza" },
  { key: "222", name: "Bia Lima" },
  { key: "333", name: "Caio Reis" },
  { key: "444", name: "Duda Melo" },
  { key: "555", name: "Edu Costa" },
  { key: "666", name: "Fábio Nunes" },
  { key: "777", name: "Gabi Alves" },
  { key: "999", name: "Linha própria", isSelf: true },
];

describe("PollBubble", () => {
  it("mostra contagem e porcentagem por opção", () => {
    render(<PollBubble poll={fiveVotes} isOutbound={false} />);
    expect(screen.getByText("3 · 60%")).toBeTruthy();
    expect(screen.getByText("2 · 40%")).toBeTruthy();
  });

  it("sem votos: texto e nenhum botão de ver votos", () => {
    render(<PollBubble poll={poll({})} isOutbound={false} />);
    expect(screen.getByText("Nenhum voto ainda")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ver votos/ })).toBeNull();
  });

  it("Ver votos abre o painel com votantes por opção e quem ainda não votou", () => {
    render(<PollBubble poll={fiveVotes} isOutbound={false} groupParticipants={participants} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ver votos · 5" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Quem vai ao jantar?")).toBeTruthy();
    expect(within(dialog).getByText("5 de 7 participantes votaram")).toBeTruthy();
    expect(within(dialog).getByText("Bia Lima")).toBeTruthy();
    expect(within(dialog).getByText("Duda Melo")).toBeTruthy();
    expect(within(dialog).getByText("Ainda não votaram (2)")).toBeTruthy();
    expect(within(dialog).getByText("Fábio Nunes")).toBeTruthy();
    expect(within(dialog).getByText("Gabi Alves")).toBeTruthy();
    expect(within(dialog).queryByText("Linha própria")).toBeNull();
  });

  it("sem lista de participantes, o painel não tem a seção de quem falta", () => {
    render(<PollBubble poll={fiveVotes} isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver votos · 5" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("5 votos")).toBeTruthy();
    expect(within(dialog).queryByText(/Ainda não votaram/)).toBeNull();
  });

  it("com onVote, tocar numa opção vota nela", () => {
    const onVote = vi.fn();
    render(<PollBubble poll={fiveVotes} isOutbound={false} onVote={onVote} />);
    fireEvent.click(screen.getByRole("button", { name: /^Não/ }));
    expect(onVote).toHaveBeenCalledWith(["Não"]);
  });
});
