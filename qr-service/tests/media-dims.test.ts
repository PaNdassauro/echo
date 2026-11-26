import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaDimsMeta } from '../src/services/mediaDims';

test('imagem 1280x720 vira media com source proto', () => {
    assert.deepEqual(mediaDimsMeta({ kind: 'image', width: 1280, height: 720 }), { width: 1280, height: 720, source: 'proto' });
});
test('vídeo inclui seconds quando > 0', () => {
    assert.deepEqual(mediaDimsMeta({ kind: 'video', width: 640, height: 360, seconds: 12 }), { width: 640, height: 360, seconds: 12, source: 'proto' });
});
test('figurinha só com dimensões; áudio, largura 0 ou altura ausente não geram media', () => {
    assert.equal(mediaDimsMeta({ kind: 'sticker' }), undefined);
    assert.equal(mediaDimsMeta({ kind: 'audio', seconds: 3 }), undefined);
    assert.equal(mediaDimsMeta({ kind: 'image', width: 0, height: 100 }), undefined);
    assert.equal(mediaDimsMeta({ kind: 'image', width: 100 }), undefined);
});

test('thumbnail Buffer vira thumb em base64', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const r = mediaDimsMeta({ kind: 'image', width: 100, height: 80, thumbnail: jpg });
    assert.equal(r?.thumb, jpg.toString('base64'));
    assert.equal(r?.thumbMime, undefined);
    assert.equal(mediaDimsMeta({ kind: 'video', width: 100, height: 80, thumbnail: jpg })?.thumb, jpg.toString('base64'));
});
test('figurinha com thumbnail marca thumbMime image/png', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const r = mediaDimsMeta({ kind: 'sticker', width: 512, height: 512, thumbnail: png });
    assert.equal(r?.thumb, png.toString('base64'));
    assert.equal(r?.thumbMime, 'image/png');
});
test('thumbnail grande demais não gera thumb (limite 9000 bytes)', () => {
    assert.equal(mediaDimsMeta({ kind: 'image', width: 10, height: 10, thumbnail: Buffer.alloc(9001) })?.thumb, undefined);
    assert.equal(mediaDimsMeta({ kind: 'image', width: 10, height: 10, thumbnail: Buffer.alloc(9000, 1) })?.thumb?.length, 12000);
});
test('sem thumbnail (ou vazio) não gera thumb', () => {
    assert.equal(mediaDimsMeta({ kind: 'image', width: 10, height: 10 })?.thumb, undefined);
    assert.equal(mediaDimsMeta({ kind: 'image', width: 10, height: 10, thumbnail: Buffer.alloc(0) })?.thumb, undefined);
});
