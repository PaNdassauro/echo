import fs from 'node:fs';
import path from 'node:path';

/**
 * O diretório de sessões precisa aceitar escrita: é nele que ficam as credenciais do Baileys e o
 * `_outbox/` (spill dos webhooks). Um volume criado por uma imagem antiga (que rodava como root) mantém
 * o dono root, e a imagem atual roda como o usuário `node`: o serviço subiria "healthy", mas toda gravação
 * falharia só com um log (`[Outbox] SPILL FALHOU`), e as credenciais não persistiriam. Melhor recusar o
 * boot, com o comando que resolve.
 *
 * Testa de verdade (cria e apaga um arquivo), e não só `access(W_OK)`: um volume somente leitura ou sem
 * espaço também falha aqui.
 */
export class SessionsDirNotWritableError extends Error {
    constructor(public readonly dir: string, causa: string) {
        super(
            `o diretório de sessões (${dir}) não aceita escrita (${causa}). ` +
                'Se é um volume criado por uma imagem antiga (dono root), corrija o dono uma vez: ' +
                'docker run --rm -u 0 -v <volume>:/app/sessions --entrypoint chown <imagem> -R 1000:1000 /app/sessions',
        );
        this.name = 'SessionsDirNotWritableError';
    }
}

export function assertSessionsDirWritable(dir: string): void {
    const sonda = path.join(dir, `.escrita-${process.pid}`);
    try {
        fs.accessSync(dir, fs.constants.W_OK);
        fs.writeFileSync(sonda, '');
    } catch (err) {
        throw new SessionsDirNotWritableError(dir, err instanceof Error ? err.message : String(err));
    } finally {
        try {
            fs.rmSync(sonda, { force: true });
        } catch {
            /* a sonda some no próximo boot; não mascarar o erro real */
        }
    }
}
