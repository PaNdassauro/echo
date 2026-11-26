import decode from 'audio-decode';

/**
 * Forma de onda (64 amostras, 0–100) e duração de um áudio, como o WhatsApp desenha
 * na nota de voz. O Baileys calcula sozinho quando `audio-decode` existe; outras libs
 * (zapo) esperam receber pronto. Falha vira `null`: a nota vai sem onda, nunca sem enviar.
 */
export async function audioMeta(buffer: Buffer): Promise<{ seconds: number; waveform: Buffer } | null> {
    try {
        const audio = await decode(buffer);
        const channel = audio.getChannelData(0);
        const samples = 64;
        const block = Math.max(1, Math.floor(channel.length / samples));
        const filtered = new Array<number>(samples).fill(0);
        for (let i = 0; i < samples; i++) {
            let sum = 0;
            const start = i * block;
            for (let j = 0; j < block && start + j < channel.length; j++) sum += Math.abs(channel[start + j]!);
            filtered[i] = sum / block;
        }
        const peak = Math.max(...filtered, 1e-6);
        const waveform = Buffer.from(filtered.map((v) => Math.floor(Math.min(100, (v / peak) * 100))));
        return { seconds: Math.max(1, Math.round(audio.duration)), waveform };
    } catch {
        return null;
    }
}
