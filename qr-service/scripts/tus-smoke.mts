// Smoke do upload resumível contra um Storage real. Uso:
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node --import tsx scripts/tus-smoke.mts <bytes>
import { writeFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFileResumable } from '../src/lib/resumableUpload.ts';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
    console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY.');
    process.exit(1);
}
const size = Number(process.argv[2] ?? 20 * 1024 * 1024);
const bytes = randomBytes(size);
const file = join(tmpdir(), `tus-smoke-${Date.now()}`);
await writeFile(file, bytes);
const objectName = `inbound/_tus-smoke/${Date.now()}_teste.mov`;
const t0 = Date.now();
try {
    await uploadFileResumable({ endpoint: `${url}/storage/v1/upload/resumable`, apiKey: key, bucket: 'attachments', objectName, contentType: 'video/quicktime', filePath: file, size });
    const res = await fetch(`${url}/storage/v1/object/public/attachments/${objectName}`);
    const got = Buffer.from(await res.arrayBuffer());
    const same = createHash('sha256').update(got).digest('hex') === createHash('sha256').update(bytes).digest('hex');
    console.log(JSON.stringify({ upload_s: (Date.now() - t0) / 1000, status: res.status, type: res.headers.get('content-type'), bytes: got.length, same }));
} finally {
    await rm(file, { force: true });
    const del = await fetch(`${url}/storage/v1/object/attachments/${objectName}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}`, apikey: key } });
    console.log('delete', del.status);
}
