import { BaileysClientFactory } from '../../../src/adapter/baileys/index.js';
import type { ContractDriver } from '../harness.js';

export const baileysDriver: ContractDriver = {
    name: 'baileys',
    createFactory: (root) => new BaileysClientFactory(root),
};
