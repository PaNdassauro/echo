#!/usr/bin/env node
// Fumaça, passo 8: Storage atrás do gateway, com o supabase-js do repo e o token do usuário A.
//
//   ECHO_URL=… ANON_KEY=… SMOKE_A_EMAIL=… SMOKE_A_PASSWORD=… SMOKE_B_EMAIL=… SMOKE_B_PASSWORD=… [SMOKE_STATE_DIR=…]
//   node scripts/smoke/storage.mjs
//
// Confere: upload de 1 MiB em outbound/<uidA>/smoke.bin (200); URL pública abre com o mesmo sha256; Range bytes=0-99
// devolve 206; upload em outbound/<uidB>/… é recusado pela RLS (403); URL assinada abre. Grava o caminho, a URL e o
// sha256 em $SMOKE_STATE_DIR/storage.json para o passo 20 (restore) conferir o mesmo objeto.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const env = z
  .object({
    ECHO_URL: z.string().url(),
    ANON_KEY: z.string().min(20),
    SMOKE_A_EMAIL: z.string().email(),
    SMOKE_A_PASSWORD: z.string().min(8),
    SMOKE_B_EMAIL: z.string().email(),
    SMOKE_B_PASSWORD: z.string().min(8),
    SMOKE_STATE_DIR: z.string().optional(),
  })
  .parse(process.env);

const ok = (nome) => console.log(`OK ${nome}`);
const falhou = (nome, detalhe) => {
  console.error(`FALHOU ${nome}: ${detalhe}`);
  process.exit(1);
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const opcoes = { auth: { persistSession: false, autoRefreshToken: false } };

async function entrar(email, senha) {
  const c = createClient(env.ECHO_URL, env.ANON_KEY, opcoes);
  const { data, error } = await c.auth.signInWithPassword({ email, password: senha });
  if (error || !data.session) falhou(`login ${email}`, error?.message ?? "sem sessão");
  return { cliente: c, uid: data.user.id };
}

const A = await entrar(env.SMOKE_A_EMAIL, env.SMOKE_A_PASSWORD);
const B = await entrar(env.SMOKE_B_EMAIL, env.SMOKE_B_PASSWORD);
const bucket = A.cliente.storage.from("attachments");

const caminho = `outbound/${A.uid}/smoke.bin`;
const corpo = randomBytes(1024 * 1024);
const up = await bucket.upload(caminho, corpo, { contentType: "application/octet-stream", upsert: true });
if (up.error) falhou("storage: upload de 1 MiB em outbound/<uidA>", up.error.message);
ok("storage: upload de 1 MiB em outbound/<uidA>/smoke.bin (200)");

const publica = bucket.getPublicUrl(caminho).data.publicUrl;
const esperada = `${env.ECHO_URL}/storage/v1/object/public/attachments/${caminho}`;
if (publica !== esperada) falhou("storage: URL pública na mesma origem", `${publica} != ${esperada}`);
const rPub = await fetch(publica);
const bPub = Buffer.from(await rPub.arrayBuffer());
if (rPub.status !== 200 || sha(bPub) !== sha(corpo)) falhou("storage: GET público com o mesmo sha256", `HTTP ${rPub.status}, ${bPub.length} B`);
ok("storage: URL pública 200 e sha256 igual");

const rRange = await fetch(publica, { headers: { Range: "bytes=0-99" } });
if (rRange.status !== 206) falhou("storage: Range bytes=0-99 devolve 206", `HTTP ${rRange.status}`);
ok("storage: Range bytes=0-99 = 206");

const alheio = await bucket.upload(`outbound/${B.uid}/x`, Buffer.from("x"), { contentType: "text/plain" });
if (!alheio.error) falhou("storage: outbound/<uidB>/x recusado pela RLS", "upload aceito");
const statusAlheio = String(alheio.error.statusCode ?? "");
if (statusAlheio !== "403" && !/row-level security/i.test(alheio.error.message)) falhou("storage: outbound/<uidB>/x = 403", `${statusAlheio} ${alheio.error.message}`);
ok("storage: upload em outbound/<uidB>/x recusado (403)");

const assinada = await bucket.createSignedUrl(caminho, 60);
if (assinada.error) falhou("storage: createSignedUrl", assinada.error.message);
const rAss = await fetch(assinada.data.signedUrl);
if (rAss.status !== 200) falhou("storage: URL assinada abre", `HTTP ${rAss.status}`);
ok("storage: URL assinada abre (200)");

if (env.SMOKE_STATE_DIR) {
  writeFileSync(join(env.SMOKE_STATE_DIR, "storage.json"), JSON.stringify({ caminho, url: publica, sha256: sha(corpo) }));
}
process.exit(0);
