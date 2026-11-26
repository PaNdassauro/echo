/**
 * Dataset do emoji picker in-house (decisão: sem emoji-mart, ~450KB de dados
 * que o composer não precisa). Categorias herdadas do picker antigo + busca
 * PT/EN por palavra-chave + skin tones gerados por modificador.
 */

import { EMOJI_NAMES_EN, GENERATED_CATEGORIES, SKIN_TONE_BASES } from "./emojiCatalog";

export interface EmojiCategory {
  name: string;
  emojis: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = GENERATED_CATEGORIES;

/**
 * Palavras-chave PT/EN dos emojis mais buscados. Busca por substring nos
 * termos; emoji sem entrada só aparece navegando pelas categorias.
 */
const CURATED_KEYWORDS: Record<string, string> = {
  "⚠️": "perigo alerta aviso atencao cuidado warning",
  "🔥": "fogo chama quente fire hot lit",
  "🚨": "alerta sirene emergencia perigo alarm",
  "☢️": "perigo radioativo radioactive",
  "☣️": "perigo biologico biohazard",
  "⛔": "proibido perigo entrada proibida",
  "🚫": "proibido nao pare",
  "❗": "alerta atencao exclamacao",
  "❌": "erro errado cancelar x",
  "✅": "ok certo feito confirmado check",
  "💣": "bomba perigo bomb",
  "☠️": "caveira perigo morte skull",
  "🧯": "extintor incendio fogo",
  "😀": "sorriso feliz alegre smile happy",
  "😃": "sorriso feliz alegre smile happy",
  "😄": "sorriso feliz riso smile laugh",
  "😁": "sorriso dentes grin",
  "😅": "riso suor nervoso sweat",
  "😂": "riso chorando rindo lagrima joy kkk haha",
  "🤣": "rolando rindo riso rofl kkk",
  "😊": "sorriso timido feliz blush",
  "😇": "anjo santo angel halo",
  "🙂": "sorriso leve slight smile",
  "😉": "piscada wink",
  "😍": "apaixonado olhos coracao amor heart eyes love",
  "🥰": "apaixonado amor coracoes love",
  "😘": "beijo kiss",
  "😋": "delicia gostoso yum",
  "😜": "lingua piscada crazy tongue",
  "🤪": "louco doido crazy",
  "🤑": "dinheiro rico money",
  "🤗": "abraco hug",
  "🤭": "risinho oops",
  "🤫": "silencio segredo shh quiet",
  "🤔": "pensando duvida thinking hmm",
  "😐": "neutro serio neutral",
  "😏": "malicia smirk",
  "🙄": "revirando olhos eye roll",
  "😬": "sem graca grimace",
  "😌": "aliviado calmo relieved",
  "😔": "triste pensativo sad pensive",
  "😴": "dormindo sono sleep zzz",
  "😷": "mascara doente mask sick",
  "🤒": "doente febre sick fever",
  "🤢": "enjoo nojo nausea",
  "🤮": "vomito vomit",
  "🥵": "calor quente hot",
  "🥶": "frio congelando cold",
  "🤯": "cabeca explodindo mind blown",
  "🥳": "festa aniversario party",
  "😎": "oculos legal cool",
  "🤓": "nerd oculos",
  "🥺": "pidao fofo carente pleading",
  "😢": "triste chorando lagrima sad cry",
  "😭": "chorando muito choro sob cry",
  "😱": "susto medo gritando scream",
  "😞": "desapontado triste disappointed",
  "😩": "cansado exausto weary",
  "😫": "cansado estressado tired",
  "🥱": "bocejo sono yawn",
  "😤": "bravo bufando frustrado triumph",
  "😡": "bravo raiva puto angry rage",
  "😠": "bravo raiva angry",
  "🤬": "xingando palavrao cursing",
  "👋": "tchau ola acenando oi wave hello bye",
  "👌": "ok perfeito beleza",
  "✌️": "paz vitoria peace victory",
  "🤞": "dedos cruzados sorte luck fingers crossed",
  "🤙": "hang loose liga me chama call",
  "👈": "esquerda apontando left",
  "👉": "direita apontando right",
  "👆": "cima apontando up",
  "👇": "baixo apontando down",
  "👍": "joia positivo curtir like thumbs up",
  "👎": "negativo nao dislike thumbs down",
  "✊": "punho forca fist",
  "👊": "soco punho punch",
  "👏": "palmas aplauso clap parabens",
  "🙌": "maos pra cima comemorar raise hands",
  "🤝": "aperto maos acordo negocio handshake deal",
  "🙏": "obrigado por favor rezar oracao gratidao thanks pray please",
  "💪": "forca musculo academia strong muscle",
  "❤️": "coracao amor vermelho heart love",
  "🧡": "coracao laranja heart",
  "💛": "coracao amarelo heart",
  "💚": "coracao verde heart",
  "💙": "coracao azul heart",
  "💜": "coracao roxo heart",
  "🖤": "coracao preto heart",
  "🤍": "coracao branco heart",
  "💔": "coracao partido broken heart",
  "💕": "coracoes amor hearts",
  "💖": "coracao brilhando sparkling heart",
  "💯": "cem pontos perfeito 100",
  "💬": "mensagem balao fala chat",
  "📱": "celular telefone phone",
  "💻": "notebook computador laptop",
  "📷": "camera foto photo",
  "📞": "telefone ligacao call",
  "⏰": "despertador alarme hora alarm clock",
  "📅": "calendario data agenda calendar",
  "📍": "localizacao pin lugar location",
  "📎": "clipe anexo attachment",
  "✏️": "lapis escrever pencil",
  "📝": "nota memo escrever anotacao",
  "📊": "grafico barras chart",
  "📈": "grafico subindo alta crescimento up",
  "📉": "grafico caindo queda down",
  "💰": "dinheiro saco money bag",
  "💳": "cartao credito card",
  "💵": "dinheiro dolar nota cash",
  "🎁": "presente gift",
  "🔑": "chave key",
  "🔒": "cadeado trancado lock",
  "🔔": "sino notificacao bell",
  "💡": "ideia lampada idea light",
  "🛒": "carrinho compras cart",
  "🎯": "alvo meta objetivo target",
  "📚": "livros estudo books",
  "✉️": "carta email envelope",
  "📦": "caixa pacote encomenda package",
  "🌹": "rosa flor rose flower",
  "🌻": "girassol flor sunflower",
  "🌷": "tulipa flor flower",
  "🍀": "trevo sorte luck clover",
  "🌍": "mundo terra planeta world earth",
  "🌙": "lua moon",
  "⭐": "estrela star",
  "✨": "brilho estrelas sparkles",
  "☀️": "sol sun",
  "☁️": "nuvem cloud",
  "🌧️": "chuva rain",
  "❄️": "neve floco frio snow",
  "🌈": "arco iris rainbow",
  "🐶": "cachorro cao dog",
  "🐱": "gato cat",
  "🦁": "leao lion",
  "🐴": "cavalo horse",
  "🦄": "unicornio unicorn",
  "🐝": "abelha bee",
  "🦋": "borboleta butterfly",
  "🍎": "maca fruta apple",
  "🍌": "banana fruta",
  "🍉": "melancia fruta watermelon",
  "🍓": "morango fruta strawberry",
  "🥑": "abacate avocado",
  "🍔": "hamburguer lanche burger",
  "🍟": "batata frita fries",
  "🍕": "pizza",
  "🌮": "taco",
  "🍣": "sushi japones",
  "🍰": "bolo fatia cake",
  "🎂": "bolo aniversario birthday cake",
  "🍫": "chocolate",
  "🍿": "pipoca popcorn",
  "☕": "cafe coffee",
  "🍺": "cerveja beer",
  "🥂": "brinde tacas cheers",
  "🍷": "vinho wine",
  "✈️": "aviao viagem plane travel",
  "🚀": "foguete rocket lancamento",
  "🚗": "carro car",
  "🚌": "onibus bus",
  "🚲": "bicicleta bike",
  "🏖️": "praia beach",
  "🏠": "casa house home",
  "🏢": "predio escritorio office",
  "🏥": "hospital",
  "⛪": "igreja church",
  "🎉": "festa parabens confete party tada",
  "🎊": "festa confete celebration",
  "🎈": "balao bexiga balloon",
  "🎄": "natal arvore christmas",
  "🏆": "trofeu campeao trophy winner",
  "🥇": "ouro primeiro medalha gold first",
  "⚽": "futebol bola soccer",
  "🏀": "basquete basketball",
  "🎵": "musica nota music",
  "🎶": "musica notas music",
  "🎤": "microfone cantar mic",
  "🎧": "fone headphone",
  "🎸": "guitarra violao guitar",
};

/**
 * Nomes em inglês do catálogo Unicode + termos PT/EN curados (os curados vêm
 * primeiro; busca por substring).
 */
export const EMOJI_KEYWORDS: Record<string, string> = (() => {
  const merged: Record<string, string> = {};
  for (const [emoji, name] of Object.entries(EMOJI_NAMES_EN)) merged[emoji] = name;
  for (const [emoji, words] of Object.entries(CURATED_KEYWORDS)) {
    merged[emoji] = `${words} ${merged[emoji] ?? ""}`.trim();
  }
  return merged;
})();

/** Emojis de mão/gesto que aceitam modificador de tom de pele. */
const SKIN_TONE_CAPABLE = new Set(SKIN_TONE_BASES);

export const SKIN_TONES = [
  { modifier: "", label: "Padrão", sample: "✋" },
  { modifier: "\u{1F3FB}", label: "Claro", sample: "✋🏻" },
  { modifier: "\u{1F3FC}", label: "Claro médio", sample: "✋🏼" },
  { modifier: "\u{1F3FD}", label: "Médio", sample: "✋🏽" },
  { modifier: "\u{1F3FE}", label: "Escuro médio", sample: "✋🏾" },
  { modifier: "\u{1F3FF}", label: "Escuro", sample: "✋🏿" },
] as const;

/** Aplica o tom de pele quando o emoji suporta (remove o VS16 antes do modificador). */
export function applySkinTone(emoji: string, modifier: string): string {
  if (!modifier || !SKIN_TONE_CAPABLE.has(emoji)) return emoji;
  return emoji.replace(/️$/, "") + modifier;
}

/** Busca por substring nas palavras-chave (case/acento-insensível no termo). */
export function searchEmojis(query: string, limit = 48): string[] {
  const term = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  if (!term) return [];
  const results: string[] = [];
  for (const [emoji, keywords] of Object.entries(EMOJI_KEYWORDS)) {
    if (keywords.includes(term)) {
      results.push(emoji);
      if (results.length >= limit) break;
    }
  }
  return results;
}
