import { ZapoClientFactory } from '../../../src/adapter/zapo/index.js';
import type { ContractDriver } from '../harness.js';

export const zapoDriver: ContractDriver = {
    name: 'zapo',
    createFactory: () => new ZapoClientFactory({ kind: 'memory' }),
    mediaDirectPath: (server, path) => server.mediaUrl(path),
};
