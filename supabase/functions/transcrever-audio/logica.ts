// Regras puras da edge `transcrever-audio`: o que responder antes de gastar com a
// transcrição e como traduzir a leitura gravada (`messages.metadata.leitura`) na resposta do botão.
// Par do front:
// `src/lib/transcricaoAudio.ts` (o contrato da resposta muda nos dois).
import { isoUs } from '../_shared/iso-us.ts';
import {
  LEITURA_JANELA_S,
  LEITURA_MAX_TENTATIVAS,
  leituraAtual,
  precisaLeitura,
  type Leitura,
  type MensagemMidia,
} from '../_shared/leitura-midia.ts';

export type RespostaTranscricao =
  | { status: 'ok'; texto: string }
  | { status: 'em_andamento' }
  | { status: 'indisponivel'; motivo: 'sem_chave' | 'chave_anthropic' }
  /** `definitivo` = o áudio não será lido (tipo, tamanho, 3 tentativas): o botão não oferece outra. */
  | { status: 'falhou'; erro: string; definitivo: boolean };

const TIPOS_AUDIO = new Set(['audio', 'ptt']);

export function ehMensagemDeAudio(m: Pick<MensagemMidia, 'message_type'>): boolean {
  return TIPOS_AUDIO.has(m.message_type ?? '');
}

/** Chave da org → motivo de indisponibilidade, ou null se dá para transcrever (só a OpenAI transcreve). */
export function motivoDaChave(chave: unknown): 'sem_chave' | 'chave_anthropic' | null {
  if (typeof chave !== 'string' || chave.trim() === '') return 'sem_chave';
  if (chave.trim().startsWith('sk-ant-')) return 'chave_anthropic';
  return null;
}

/** Traduz uma leitura gravada que não pede transcrição nova. */
function respostaDaLeitura(l: Leitura, agora: Date): RespostaTranscricao {
  if (l.texto !== null) return { status: 'ok', texto: l.texto };
  if (l.lacuna) return { status: 'falhou', erro: l.erro ?? 'lacuna', definitivo: true };
  if (l.at !== null) return { status: 'falhou', erro: 'sem_texto', definitivo: true };
  const recente =
    l.em_leitura_desde !== null &&
    isoUs(l.em_leitura_desde) > isoUs(new Date(agora.getTime() - LEITURA_JANELA_S * 1000));
  // Reservada há pouco e sem erro: alguém (outro clique) está transcrevendo agora.
  if (recente && l.erro === null) return { status: 'em_andamento' };
  // Esgotada sem lacuna (a 3ª invocação morreu depois da reserva): a reserva não aceita outra.
  if (l.tentativas >= LEITURA_MAX_TENTATIVAS) {
    return { status: 'falhou', erro: l.erro ?? 'tentativas_esgotadas', definitivo: true };
  }
  // Tentativa que falhou há pouco (recuo): passa depois de LEITURA_JANELA_S.
  return { status: 'falhou', erro: l.erro ?? 'tentativas_esgotadas', definitivo: false };
}

/**
 * Decide antes de chamar o `lerMidia`. `ler` = chamar (formato fora da lista e tamanho acima do
 * limite viram lacuna gravada lá, sem custo); o resto é a resposta final.
 * Mensagem que não é áudio fica de fora pelo chamador (400).
 */
export function antesDeLer(m: MensagemMidia, agora: Date): RespostaTranscricao | 'ler' {
  if (m.is_deleted || !m.media_url) return { status: 'falhou', erro: 'sem_midia', definitivo: true };
  const l = leituraAtual(m);
  if (precisaLeitura(m, agora)) return 'ler';
  // precisaLeitura só recusa áudio com leitura válida gravada.
  return l ? respostaDaLeitura(l, agora) : { status: 'falhou', erro: 'leitura_invalida', definitivo: false };
}

/** Resposta a partir do que o `lerMidia` devolveu. */
export function depoisDeLer(l: Leitura): RespostaTranscricao {
  if (l.texto !== null) return { status: 'ok', texto: l.texto };
  // Teto de gasto não se aplica aqui (sem reservarCusto); erro gravado = falha desta tentativa.
  if (l.erro !== null) return { status: 'falhou', erro: l.erro, definitivo: l.lacuna };
  if (l.lacuna) return { status: 'falhou', erro: l.erro ?? 'lacuna', definitivo: true };
  // Sem texto e sem erro: a reserva foi recusada. O lerMidia devolve o metadata lido ANTES da
  // reserva, então isto é corrida com outro clique ou outra chamada, que acabou de reservar.
  return { status: 'em_andamento' };
}
