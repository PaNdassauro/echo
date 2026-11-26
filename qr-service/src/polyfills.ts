// Polyfill for Node 18 - Baileys requires globalThis.crypto.subtle
// This must be imported BEFORE any Baileys imports
import { webcrypto } from 'crypto';

// @ts-ignore - Node 18 doesn't have crypto on globalThis by default
if (!globalThis.crypto) {
    // @ts-ignore
    globalThis.crypto = webcrypto;
}

export {};
