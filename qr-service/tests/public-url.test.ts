/**
 * URL pública × interna do Storage (src/lib/publicUrl.ts) e a guarda SSRF que a usa
 * (src/lib/url-guard.ts): no Docker o anexo nosso chega pela URL pública do gateway,
 * que a guarda recusaria, e o servidor busca pela interna.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
    PublicUrlConfigError,
    baseInterna,
    basePublica,
    caminhoDoAnexoNosso,
    ehAnexoNosso,
    paraUrlInterna,
    urlPublicaDoAnexo,
} from '../src/lib/publicUrl.js';
import { fetchMediaUrl, resolveOwnStorageUrl } from '../src/lib/url-guard.js';

const ENV_ORIGINAL = { SUPABASE_URL: process.env.SUPABASE_URL, ECHO_PUBLIC_URL: process.env.ECHO_PUBLIC_URL };

function definirEnv(supabaseUrl: string | undefined, publicUrl: string | undefined): void {
    if (supabaseUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = supabaseUrl;
    if (publicUrl === undefined) delete process.env.ECHO_PUBLIC_URL; else process.env.ECHO_PUBLIC_URL = publicUrl;
}

beforeEach(() => definirEnv('http://gateway:8000', 'https://echo.exemplo.com'));
afterEach(() => definirEnv(ENV_ORIGINAL.SUPABASE_URL, ENV_ORIGINAL.ECHO_PUBLIC_URL));

const PUB = 'https://echo.exemplo.com/storage/v1/object/public/attachments/inbound/abc/1_foto.jpg';
const INT = 'http://gateway:8000/storage/v1/object/public/attachments/inbound/abc/1_foto.jpg';

test('bases: interna = SUPABASE_URL; pública = ECHO_PUBLIC_URL, ou a SUPABASE_URL sem ela', () => {
    assert.equal(baseInterna(), 'http://gateway:8000');
    assert.equal(basePublica(), 'https://echo.exemplo.com');
    definirEnv('https://abc.supabase.co/', undefined);
    assert.equal(baseInterna(), 'https://abc.supabase.co');
    assert.equal(basePublica(), 'https://abc.supabase.co');
    definirEnv('http://gateway:8000', '  http://localhost:8088/  ');
    assert.equal(basePublica(), 'http://localhost:8088');
});

test('bases: variável inválida lança PublicUrlConfigError com o nome da variável', () => {
    definirEnv('http://gateway:8000', 'ftp://echo.exemplo.com');
    assert.throws(() => basePublica(), (e: unknown) => e instanceof PublicUrlConfigError && /ECHO_PUBLIC_URL/.test(e.message));
    definirEnv('http://gateway:8000', 'não é url');
    assert.throws(() => basePublica(), PublicUrlConfigError);
    definirEnv('http://gateway:8000', 'https://u:p@echo.exemplo.com');
    assert.throws(() => basePublica(), PublicUrlConfigError);
    definirEnv(undefined, undefined);
    assert.throws(() => baseInterna(), /SUPABASE_URL não configurada/);
});

test('urlPublicaDoAnexo usa a base pública e é idêntica ao getPublicUrl do storage-js', () => {
    assert.equal(urlPublicaDoAnexo('inbound/abc/1_foto.jpg'), PUB);
    definirEnv('http://127.0.0.1:54321', undefined);
    const supabase = createClient('http://127.0.0.1:54321', 'chave-qualquer');
    for (const caminho of [
        'inbound/abc/1_foto.jpg',
        'contact-avatars/x/5511999990001_s_whatsapp_net.jpg',
        'inbound/abc/um arquivo com espaço.pdf',
        'inbound/abc/ação.png',
        'inbound/abc/100%.bin',
        'sticker-cache/ab12.webp',
    ]) {
        assert.equal(
            urlPublicaDoAnexo(caminho),
            supabase.storage.from('attachments').getPublicUrl(caminho).data.publicUrl,
            caminho,
        );
    }
    assert.equal(urlPublicaDoAnexo('a/b.txt', 'outro'), 'http://127.0.0.1:54321/storage/v1/object/public/outro/a/b.txt');
});

test('caminhoDoAnexoNosso: aceita a base pública e a interna, decodifica, ignora a query', () => {
    assert.equal(caminhoDoAnexoNosso(PUB), 'inbound/abc/1_foto.jpg');
    assert.equal(caminhoDoAnexoNosso(INT), 'inbound/abc/1_foto.jpg');
    assert.equal(caminhoDoAnexoNosso(`${PUB}?v=1a2b3c4d`), 'inbound/abc/1_foto.jpg');
    assert.equal(caminhoDoAnexoNosso(urlPublicaDoAnexo('inbound/abc/ação 100%.png')), 'inbound/abc/ação 100%.png');
    assert.equal(caminhoDoAnexoNosso('HTTPS://ECHO.EXEMPLO.COM:443/storage/v1/object/public/attachments/x.png'), 'x.png');
    assert.equal(ehAnexoNosso(PUB), true);
});

test('caminhoDoAnexoNosso: URL alheia, outro bucket, outro prefixo e disfarces são null', () => {
    for (const url of [
        'https://outro.exemplo.com/storage/v1/object/public/attachments/x.png',
        'https://echo.exemplo.com.atacante.com/storage/v1/object/public/attachments/x.png',
        'https://echo.exemplo.com@atacante.com/storage/v1/object/public/attachments/x.png',
        'https://echo.exemplo.com:8443/storage/v1/object/public/attachments/x.png',
        'http://echo.exemplo.com/storage/v1/object/public/attachments/x.png',
        'https://echo.exemplo.com/storage/v1/object/public/outro/x.png',
        'https://echo.exemplo.com/storage/v1/object/sign/attachments/x.png',
        'https://echo.exemplo.com/storage/v1/object/public/attachments/',
        'https://echo.exemplo.com/storage/v1/object/public/attachments',
        'https://echo.exemplo.com/auth/v1/admin/users',
        'http://gateway:8000/auth/v1/admin/users',
        'ftp://echo.exemplo.com/storage/v1/object/public/attachments/x.png',
        'file:///etc/passwd',
        'isto não é url',
        '',
    ]) {
        assert.equal(caminhoDoAnexoNosso(url), null, url);
        assert.equal(ehAnexoNosso(url), false, url);
    }
});

test('caminhoDoAnexoNosso: subida de diretório e caracteres de controle não passam', () => {
    // `..` literal e `%2e%2e` são resolvidos pela URL: o prefixo deixa de casar.
    assert.equal(caminhoDoAnexoNosso('https://echo.exemplo.com/storage/v1/object/public/attachments/../../../../auth/v1/admin/users'), null);
    assert.equal(caminhoDoAnexoNosso('https://echo.exemplo.com/storage/v1/object/public/attachments/%2e%2e/%2e%2e/x'), null);
    // `%2f` fica codificado na URL: o decodificado teria `..` e é recusado.
    assert.equal(caminhoDoAnexoNosso('https://echo.exemplo.com/storage/v1/object/public/attachments/a%2f..%2f..%2fb'), null);
    assert.equal(caminhoDoAnexoNosso('https://echo.exemplo.com/storage/v1/object/public/attachments/a%5cb'), null);
    assert.equal(caminhoDoAnexoNosso('https://echo.exemplo.com/storage/v1/object/public/attachments/a%00b'), null);
    assert.equal(caminhoDoAnexoNosso('https://echo.exemplo.com/storage/v1/object/public/attachments/%E0%A4%A'), null);
});

test('paraUrlInterna troca a base pública pela interna e deixa o resto como está', () => {
    assert.equal(paraUrlInterna(PUB), INT);
    assert.equal(paraUrlInterna(INT), INT);
    assert.equal(paraUrlInterna(`${PUB}?v=1a2b3c4d`), `${INT}?v=1a2b3c4d`);
    assert.equal(
        paraUrlInterna(urlPublicaDoAnexo('inbound/abc/ação 100%.png')),
        'http://gateway:8000/storage/v1/object/public/attachments/inbound/abc/a%C3%A7%C3%A3o%20100%25.png',
    );
    const alheia = 'https://cdn.exemplo.org/foto.jpg';
    assert.equal(paraUrlInterna(alheia), alheia);
    const disfarce = 'https://echo.exemplo.com@atacante.com/storage/v1/object/public/attachments/x.png';
    assert.equal(paraUrlInterna(disfarce), disfarce);
});

test('sem ECHO_PUBLIC_URL (Supabase hospedado) pública e interna são a mesma base e nada muda', () => {
    definirEnv('https://abc.supabase.co', undefined);
    const url = 'https://abc.supabase.co/storage/v1/object/public/attachments/inbound/a/1.png';
    assert.equal(urlPublicaDoAnexo('inbound/a/1.png'), url);
    assert.equal(paraUrlInterna(url), url);
    assert.equal(caminhoDoAnexoNosso(url), 'inbound/a/1.png');
});

test('resolveOwnStorageUrl: pública e interna viram a interna; alheia (inclusive host privado) é null', () => {
    assert.equal(resolveOwnStorageUrl(PUB), INT);
    assert.equal(resolveOwnStorageUrl(INT), INT);
    assert.equal(resolveOwnStorageUrl('https://cdn.exemplo.org/foto.jpg'), null);
    // Host privado que NÃO é o nosso Storage não ganha passe livre.
    assert.equal(resolveOwnStorageUrl('http://169.254.169.254/latest/meta-data/'), null);
    assert.equal(resolveOwnStorageUrl('http://rest:3000/messages'), null);
    assert.equal(resolveOwnStorageUrl('http://gateway:8000/rest/v1/messages'), null);
    assert.equal(resolveOwnStorageUrl('http://localhost:8088/storage/v1/object/public/attachments/x.png'), null);
});

test('fetchMediaUrl: anexo nosso é buscado pela interna, sem guarda e sem seguir redirecionamento', async () => {
    const chamadas: Array<{ url: string; init?: RequestInit }> = [];
    const falso = (async (url: string | URL | Request, init?: RequestInit) => {
        chamadas.push({ url: String(url), init });
        return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const viaPublica = await fetchMediaUrl(PUB, falso);
    assert.equal(viaPublica.status, 200);
    assert.deepEqual(chamadas[0], { url: INT, init: { redirect: 'manual' } });

    await fetchMediaUrl(INT, falso);
    assert.equal(chamadas[1]!.url, INT);
});

test('fetchMediaUrl sem ECHO_PUBLIC_URL (hospedado): comportamento de sempre, guarda em tudo (redirecionamento à mão)', async () => {
    // IP literal público: a guarda aceita sem consultar DNS.
    definirEnv('http://203.0.113.10', undefined);
    const chamadas: Array<{ url: string; init?: RequestInit }> = [];
    const falso = (async (url: string | URL | Request, init?: RequestInit) => {
        chamadas.push({ url: String(url), init });
        return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const nosso = 'http://203.0.113.10/storage/v1/object/public/attachments/inbound/a/1.png';
    await fetchMediaUrl(nosso, falso);
    assert.deepEqual(chamadas[0], { url: nosso, init: { redirect: 'manual' } });

    // Anexo "nosso" num host privado continua passando pela guarda quando não há URL pública separada.
    definirEnv('http://gateway:8000', undefined);
    await assert.rejects(
        fetchMediaUrl('http://10.0.0.5/storage/v1/object/public/attachments/x.png', falso),
        /blocked address/,
    );
    assert.equal(chamadas.length, 1);
});

test('fetchMediaUrl: URL alheia segue a guarda SSRF (host privado, localhost e esquema são recusados)', async () => {
    let chamou = false;
    const falso = (async () => {
        chamou = true;
        return new Response('x');
    }) as typeof fetch;

    await assert.rejects(fetchMediaUrl('http://169.254.169.254/latest/meta-data/', falso), /blocked address/);
    await assert.rejects(fetchMediaUrl('http://10.0.0.5/x.png', falso), /blocked address/);
    await assert.rejects(fetchMediaUrl('http://localhost:8088/x.png', falso), /host is not allowed/);
    await assert.rejects(fetchMediaUrl('http://192.168.1.10:8000/rest/v1/messages', falso), /blocked address/);
    await assert.rejects(fetchMediaUrl('file:///etc/passwd', falso), /http or https/);
    assert.equal(chamou, false);

    const ok = await fetchMediaUrl('http://203.0.113.10/foto.png', falso);
    assert.equal(ok.status, 200);
    assert.equal(chamou, true);
});

/** fetch falso que responde por URL: string = 200 com esse corpo; objeto = 30x com Location. */
function fetchRoteado(rotas: Record<string, string | { status: number; location?: string }>, chamadas: string[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        chamadas.push(u);
        assert.equal(init?.redirect, 'manual', 'o fetch nunca segue redirecionamento sozinho');
        const rota = rotas[u];
        if (rota === undefined) return new Response('nada', { status: 404 });
        if (typeof rota === 'string') return new Response(rota, { status: 200 });
        const headers = new Headers();
        if (rota.location) headers.set('location', rota.location);
        return new Response(null, { status: rota.status, headers });
    }) as typeof fetch;
}

test('fetchMediaUrl: 302 de URL externa para IMDS, IP privado ou localhost é recusado sem segundo fetch', async () => {
    for (const alvo of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://localhost/', 'http://172.17.0.1:9000/']) {
        const chamadas: string[] = [];
        const falso = fetchRoteado({ 'http://203.0.113.7/r': { status: 302, location: alvo } }, chamadas);
        await assert.rejects(fetchMediaUrl('http://203.0.113.7/r', falso), /blocked address|host is not allowed/, alvo);
        assert.deepEqual(chamadas, ['http://203.0.113.7/r'], alvo);
    }
});

test('fetchMediaUrl: redirecionamento para host público é seguido (absoluto e relativo)', async () => {
    const chamadas: string[] = [];
    const falso = fetchRoteado({
        'http://203.0.113.7/a': { status: 301, location: 'http://203.0.113.8/b' },
        'http://203.0.113.8/b': { status: 307, location: '/c.png' },
        'http://203.0.113.8/c.png': 'bytes',
    }, chamadas);
    const resposta = await fetchMediaUrl('http://203.0.113.7/a', falso);
    assert.equal(resposta.status, 200);
    assert.equal(await resposta.text(), 'bytes');
    assert.deepEqual(chamadas, ['http://203.0.113.7/a', 'http://203.0.113.8/b', 'http://203.0.113.8/c.png']);
});

test('fetchMediaUrl: mais de 3 saltos, ciclo e 30x sem Location são recusados', async () => {
    const cadeia: Record<string, { status: number; location: string }> = {};
    for (let i = 0; i < 6; i++) cadeia[`http://203.0.113.7/${i}`] = { status: 302, location: `http://203.0.113.7/${i + 1}` };
    const c1: string[] = [];
    await assert.rejects(fetchMediaUrl('http://203.0.113.7/0', fetchRoteado(cadeia, c1)), /too many redirects/);
    assert.equal(c1.length, 4); // a original + 3 saltos

    const c2: string[] = [];
    const ciclo = fetchRoteado({
        'http://203.0.113.7/a': { status: 302, location: '/b' },
        'http://203.0.113.7/b': { status: 302, location: '/a' },
    }, c2);
    await assert.rejects(fetchMediaUrl('http://203.0.113.7/a', ciclo), /redirect loop/);

    const c3: string[] = [];
    await assert.rejects(
        fetchMediaUrl('http://203.0.113.7/x', fetchRoteado({ 'http://203.0.113.7/x': { status: 302 } }, c3)),
        /without Location/,
    );
});

test('fetchMediaUrl: 304 e outras respostas não-30x voltam como estão', async () => {
    const chamadas: string[] = [];
    const resposta = await fetchMediaUrl('http://203.0.113.7/x', fetchRoteado({ 'http://203.0.113.7/x': { status: 304 } }, chamadas));
    assert.equal(resposta.status, 304);
});
