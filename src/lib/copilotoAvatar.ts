import type { AvatarDefinition } from "open-bot-avatar";

/**
 * Definição do bichinho do copiloto no contrato v1 do `open-bot-avatar`:
 * uma bola (dois arcos) na caixa 0 0 100 100, com os olhos no alto à direita,
 * como quem olha a conversa (a faixa fica à esquerda, embaixo das mensagens).
 * O teste confere que ela passa no `validateAvatar` da biblioteca.
 */
export const COPILOTO_AVATAR: AvatarDefinition = {
  version: 1,
  id: "copiloto",
  name: "Copiloto",
  body: { path: "M50 12A38 38 0 1 1 50 88A38 38 0 1 1 50 12Z" },
  eyes: { x: 62, y: 41, spacing: 17, scale: 1.25 },
};
