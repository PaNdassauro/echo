/**
 * uploadFileResumable contra um servidor TUS em memória: pedaços na ordem, retomada
 * pelo offset do servidor (inclusive quando a resposta se perde depois de gravar) e
 * falha rápida em 4xx permanente.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { alinharLocation, uploadFileResumable, ResumableUploadError } from '../src/lib/resumableUpload.js';

interface Upload { length: number; data: Buffer; metadata: string; headers: IncomingMessage['headers'] }

let server: Server;
let base = '';
let dir = '';
const uploads = new Map<string, Upload>();
/** Hook por teste: decide o destino do PATCH número n (1-based). */
let onPatch: (n: number, upload: Upload, chunk: Buffer) => 'ok' | 'fail' | 'store-then-fail' = () => 'ok';
let createStatus = 201;
/** Quando definido, o Location da criação sai absoluto com esta origem (o público do gateway). */
let locationOrigin = '';
let patchCount = 0;
const patchOffsets: number[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
        const parts: Buffer[] = [];
        req.on('data', (c: Buffer) => parts.push(c));
        req.on('end', () => resolve(Buffer.concat(parts)));
    });
}

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tus-test-'));
    server = createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.method === 'POST') {
            if (createStatus !== 201) { res.writeHead(createStatus).end('{"message":"Payload too large"}'); return; }
            const id = String(uploads.size + 1);
            uploads.set(id, {
                length: Number(req.headers['upload-length']),
                data: Buffer.alloc(0),
                metadata: String(req.headers['upload-metadata']),
                headers: req.headers,
            });
            res.writeHead(201, { location: `${locationOrigin}/upload/resumable/${id}` }).end();
            return;
        }
        const id = req.url!.split('/').pop()!;
        const upload = uploads.get(id);
        if (!upload) { res.writeHead(404).end(); return; }
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'upload-offset': String(upload.data.length) }).end();
            return;
        }
        if (req.method === 'PATCH') {
            patchCount++;
            const offset = Number(req.headers['upload-offset']);
            patchOffsets.push(offset);
            if (offset !== upload.data.length) { res.writeHead(409).end('offset'); return; }
            const outcome = onPatch(patchCount, upload, body);
            if (outcome === 'fail') { res.writeHead(500).end('boom'); return; }
            upload.data = Buffer.concat([upload.data, body]);
            if (outcome === 'store-then-fail') { res.writeHead(502).end('lost'); return; }
            res.writeHead(204, { 'upload-offset': String(upload.data.length) }).end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
});

async function fixture(size: number): Promise<{ path: string; bytes: Buffer }> {
    const bytes = randomBytes(size);
    const path = join(dir, `f-${size}-${Date.now()}`);
    await writeFile(path, bytes);
    return { path, bytes };
}

function reset(): void {
    uploads.clear();
    onPatch = () => 'ok';
    createStatus = 201;
    locationOrigin = '';
    patchCount = 0;
    patchOffsets.length = 0;
}

const common = (path: string, size: number) => ({
    endpoint: `${base}/storage/v1/upload/resumable`,
    apiKey: 'chave',
    bucket: 'attachments',
    objectName: 'inbound/x/video.mov',
    contentType: 'video/quicktime',
    filePath: path,
    size,
    chunkSize: 1000,
    retryDelaysMs: [1, 1, 1],
});

test('sobe em pedaços do tamanho pedido, com metadados e as duas credenciais', async () => {
    reset();
    const { path, bytes } = await fixture(3500);
    await uploadFileResumable(common(path, bytes.length));
    const up = uploads.get('1')!;
    assert.deepEqual(up.data, bytes);
    assert.deepEqual(patchOffsets, [0, 1000, 2000, 3000]);
    assert.equal(up.headers.authorization, 'Bearer chave');
    assert.equal(up.headers.apikey, 'chave');
    assert.equal(up.headers['x-upsert'], 'false');
    const meta = Object.fromEntries(up.metadata.split(',').map((kv) => {
        const [k, v] = kv.split(' ');
        return [k, Buffer.from(v, 'base64').toString()];
    }));
    assert.equal(meta.bucketName, 'attachments');
    assert.equal(meta.objectName, 'inbound/x/video.mov');
    assert.equal(meta.contentType, 'video/quicktime');
});

test('pedaço que falha é reenviado do mesmo offset', async () => {
    reset();
    const { path, bytes } = await fixture(2500);
    onPatch = (n) => (n === 2 ? 'fail' : 'ok');
    await uploadFileResumable(common(path, bytes.length));
    assert.deepEqual(uploads.get('1')!.data, bytes);
    assert.deepEqual(patchOffsets, [0, 1000, 1000, 2000]);
});

test('resposta perdida depois de gravar: retoma do offset do servidor sem duplicar', async () => {
    reset();
    const { path, bytes } = await fixture(2500);
    onPatch = (n) => (n === 2 ? 'store-then-fail' : 'ok');
    await uploadFileResumable(common(path, bytes.length));
    assert.deepEqual(uploads.get('1')!.data, bytes);
    assert.deepEqual(patchOffsets, [0, 1000, 2000]);
});

test('desiste depois de esgotar as tentativas do mesmo pedaço', async () => {
    reset();
    const { path, bytes } = await fixture(1500);
    onPatch = (n) => (n >= 2 ? 'fail' : 'ok');
    await assert.rejects(uploadFileResumable(common(path, bytes.length)), (e: unknown) =>
        e instanceof ResumableUploadError && /offset 1000 falhou 4x/.test(e.message));
    assert.equal(patchCount, 5); // 1 ok + a falha original + 3 novas tentativas
});

test('4xx permanente na criação falha na hora, com o status', async () => {
    reset();
    createStatus = 413;
    const { path, bytes } = await fixture(10);
    await assert.rejects(uploadFileResumable(common(path, bytes.length)), (e: unknown) =>
        e instanceof ResumableUploadError && e.status === 413 && /Payload too large/.test(e.message));
    assert.equal(patchCount, 0);
});

test('Location com origem diferente da do endpoint é reescrito para a do endpoint', async () => {
    reset();
    // Atrás do gateway o storage-api devolve o endereço PÚBLICO; o serviço só alcança o interno.
    locationOrigin = 'https://echo.publico.invalid:9443';
    const { path, bytes } = await fixture(2500);
    await uploadFileResumable(common(path, bytes.length));
    assert.deepEqual(uploads.get('1')!.data, bytes);
    assert.deepEqual(patchOffsets, [0, 1000, 2000]);
});

test('alinharLocation: relativo, mesma origem e origem alheia (esquema, host e porta)', () => {
    const endpoint = 'http://gateway:8000/storage/v1/upload/resumable';
    assert.equal(alinharLocation('/storage/v1/upload/resumable/abc', endpoint), 'http://gateway:8000/storage/v1/upload/resumable/abc');
    assert.equal(alinharLocation('http://gateway:8000/storage/v1/upload/resumable/abc', endpoint), 'http://gateway:8000/storage/v1/upload/resumable/abc');
    assert.equal(alinharLocation('https://echo.exemplo.com/storage/v1/upload/resumable/abc?x=1', endpoint), 'http://gateway:8000/storage/v1/upload/resumable/abc?x=1');
    assert.equal(alinharLocation('http://localhost:8088/storage/v1/upload/resumable/abc', endpoint), 'http://gateway:8000/storage/v1/upload/resumable/abc');
    assert.equal(alinharLocation('http://gateway:9000/storage/v1/upload/resumable/abc', endpoint), 'http://gateway:8000/storage/v1/upload/resumable/abc');
});
