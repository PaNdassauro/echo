import {
  antesDeLer,
  depoisDeLer,
  ehMensagemDeAudio,
  motivoDaChave,
} from "../../supabase/functions/transcrever-audio/logica.ts";
import type { Leitura, MensagemMidia } from "../../supabase/functions/_shared/leitura-midia.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const AGORA = new Date("2026-11-10T15:00:00.000Z");
const HA_1_MIN = "2026-11-10T14:59:00.000000Z";
const HA_10_MIN = "2026-11-10T14:50:00.000000Z";

function leitura(p: Partial<Leitura> = {}): Leitura {
  return {
    v: 1,
    tipo: "audio",
    classe: null,
    texto: null,
    modelo: null,
    segundos: null,
    tokens: null,
    custo_usd: 0,
    at: null,
    erro: null,
    tentativas: 0,
    em_leitura_desde: null,
    lacuna: false,
    ...p,
  };
}

function audio(p: Partial<MensagemMidia> = {}, l?: Leitura): MensagemMidia {
  return {
    id: "m1",
    conversation_id: "c1",
    direction: "inbound",
    message_type: "audio",
    content: null,
    is_deleted: false,
    media_url: "https://x.supabase.co/storage/v1/object/public/attachments/a.ogg",
    media_mime_type: "audio/ogg; codecs=opus",
    media_filename: null,
    media_size_bytes: 40_000,
    metadata: l ? { leitura: l } : null,
    ...p,
  };
}

Deno.test("ehMensagemDeAudio: audio e ptt, nada mais", () => {
  equal(ehMensagemDeAudio({ message_type: "audio" }), true);
  equal(ehMensagemDeAudio({ message_type: "ptt" }), true);
  equal(ehMensagemDeAudio({ message_type: "video" }), false);
  equal(ehMensagemDeAudio({ message_type: null }), false);
});

Deno.test("motivoDaChave: vazia, Anthropic e OpenAI", () => {
  equal(motivoDaChave(null), "sem_chave");
  equal(motivoDaChave("   "), "sem_chave");
  equal(motivoDaChave("sk-ant-abc"), "chave_anthropic");
  equal(motivoDaChave(" sk-ant-abc"), "chave_anthropic");
  equal(motivoDaChave("sk-proj-abc"), null);
});

Deno.test("antesDeLer: áudio sem leitura pede transcrição", () => {
  equal(antesDeLer(audio(), AGORA), "ler");
});

Deno.test("antesDeLer: já transcrito volta o texto, sem custo", () => {
  const l = leitura({ texto: "oi, tudo bem?", at: HA_10_MIN, tentativas: 1 });
  equal(antesDeLer(audio({}, l), AGORA), { status: "ok", texto: "oi, tudo bem?" });
});

Deno.test("antesDeLer: transcrição vazia (áudio mudo) também é ok", () => {
  const l = leitura({ texto: "", at: HA_10_MIN, tentativas: 1 });
  equal(antesDeLer(audio({}, l), AGORA), { status: "ok", texto: "" });
});

Deno.test("antesDeLer: apagada ou sem arquivo não gasta", () => {
  equal(antesDeLer(audio({ is_deleted: true }), AGORA), { status: "falhou", erro: "sem_midia", definitivo: true });
  equal(antesDeLer(audio({ media_url: null }), AGORA), { status: "falhou", erro: "sem_midia", definitivo: true });
});

Deno.test("antesDeLer: formato fora da lista vai ao lerMidia, que grava a lacuna sem custo", () => {
  equal(antesDeLer(audio({ media_mime_type: "audio/amr" }), AGORA), "ler");
});

Deno.test("antesDeLer: tentativas esgotadas sem lacuna é definitivo (a reserva não aceita outra)", () => {
  const l = leitura({ tentativas: 3, em_leitura_desde: HA_10_MIN });
  equal(antesDeLer(audio({}, l), AGORA), { status: "falhou", erro: "tentativas_esgotadas", definitivo: true });
});

Deno.test("antesDeLer: reserva recente sem erro = alguém transcrevendo", () => {
  const l = leitura({ tentativas: 1, em_leitura_desde: HA_1_MIN });
  equal(antesDeLer(audio({}, l), AGORA), { status: "em_andamento" });
});

Deno.test("antesDeLer: falha recente fica em recuo, não definitiva", () => {
  const l = leitura({ tentativas: 1, em_leitura_desde: HA_1_MIN, erro: "timeout" });
  equal(antesDeLer(audio({}, l), AGORA), { status: "falhou", erro: "timeout", definitivo: false });
});

Deno.test("antesDeLer: falha antiga (fora do recuo) tenta de novo", () => {
  const l = leitura({ tentativas: 1, em_leitura_desde: HA_10_MIN, erro: "timeout" });
  equal(antesDeLer(audio({}, l), AGORA), "ler");
});

Deno.test("antesDeLer: lacuna é definitiva", () => {
  const l = leitura({ tentativas: 3, lacuna: true, erro: "grande_demais" });
  equal(antesDeLer(audio({}, l), AGORA), { status: "falhou", erro: "grande_demais", definitivo: true });
});

Deno.test("depoisDeLer: texto, erro e reserva recusada", () => {
  equal(depoisDeLer(leitura({ texto: "fechado", at: HA_1_MIN })), { status: "ok", texto: "fechado" });
  equal(depoisDeLer(leitura({ erro: "download", tentativas: 1 })), {
    status: "falhou",
    erro: "download",
    definitivo: false,
  });
  equal(depoisDeLer(leitura({ erro: "timeout", tentativas: 3, lacuna: true })), {
    status: "falhou",
    erro: "timeout",
    definitivo: true,
  });
  // reserva recusada: lerMidia devolve a leitura lida ANTES da reserva (aqui, vazia)
  equal(depoisDeLer(leitura()), { status: "em_andamento" });
  equal(depoisDeLer(leitura({ lacuna: true, erro: "nao_suportado" })), {
    status: "falhou",
    erro: "nao_suportado",
    definitivo: true,
  });
});
