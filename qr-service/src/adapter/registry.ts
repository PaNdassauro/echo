import type { WhatsAppClientFactory } from './WhatsAppClient.js';

/**
 * Resolve o provider de uma linha pelo nome (`phone_numbers.qr_provider`).
 * Os adapters se registram no boot (index.ts); ninguém importa a lib direto.
 */
export class ProviderRegistry {
    private readonly factories = new Map<string, WhatsAppClientFactory>();

    constructor(private readonly defaultName: string = 'baileys') {}

    register(factory: WhatsAppClientFactory): this {
        if (this.factories.has(factory.name)) {
            throw new Error(`Provider '${factory.name}' já registrado`);
        }
        this.factories.set(factory.name, factory);
        return this;
    }

    for(name: string | null | undefined): WhatsAppClientFactory {
        const resolved = name && name.trim() ? name.trim() : this.defaultName;
        const factory = this.factories.get(resolved);
        if (!factory) {
            throw new Error(`Provider desconhecido: '${resolved}' (registrados: ${[...this.factories.keys()].join(', ') || 'nenhum'})`);
        }
        return factory;
    }

    has(name: string): boolean {
        return this.factories.has(name);
    }

    names(): string[] {
        return [...this.factories.keys()];
    }

    all(): WhatsAppClientFactory[] {
        return [...this.factories.values()];
    }

    get defaultProvider(): string {
        return this.defaultName;
    }
}
