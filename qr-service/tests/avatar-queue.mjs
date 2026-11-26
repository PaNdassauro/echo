#!/usr/bin/env node
/**
 * Fila de avatares — checks de comportamento contra a classe REAL (dist/), com o
 * trabalho pesado (processAvatarJob) trocado por stub.
 *
 * Existe porque este serviço não tem suíte de testes e a fila é a parte com mais
 * armadilha de tempo. Pegou, na primeira execução, um bug fatal: o callback do
 * timer chamava pumpAvatarQueue, que voltava na hora ao ver o próprio handle ainda
 * setado — a fila parava depois da primeira drenada e nenhuma foto era buscada.
 *
 * Uso:  npm run build && npm run test:avatar-queue
 */

// Credenciais FALSAS, e antes do import: o serviço carrega o .env de verdade, e
// dotenv não sobrescreve variável já definida. Nada aqui deve poder falar com prod.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY = 'stub-service-key-nao-usar';
process.env.WEBHOOK_URL = '';

// Relógio monotônico: o serviço mede pausa e espaçamento com Date.now(), e o relógio do
// host pode saltar para trás ou para a frente (WSL, VM pausada, ajuste de NTP). Um salto
// de 20 s no meio do teste atrasava a retomada da fila e dava falso FAIL. O performance.now()
// não salta, então a hora do teste anda só com o tempo real decorrido.
const origem = Date.now() - performance.now();
Date.now = () => Math.round(origem + performance.now());

const { SessionManager } = await import(new URL('../dist/services/SessionManager.js', import.meta.url).href);

const sm = new SessionManager();
const started = [];
let fail = 0;
const check = (nome, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${nome}${extra ? '  → ' + extra : ''}`);
  if (!ok) fail++;
};

// Stubs: sessão viva e nenhum I/O real.
// `client` é o que o pump consulta: sem ele o job sai da fila e some, sem desfecho.
sm.sessions.set('L1', { socket: { fake: true }, client: { fake: true }, status: 'connected', listeners: new Set() });
sm.debugLog = async () => {};
let holdResolvers = [];
sm.processAvatarJob = (job) => {
  started.push({ jid: job.jid, priority: job.priority, at: Date.now() });
  return new Promise((resolve) => holdResolvers.push(resolve));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Espera uma condição em vez de um tempo fixo: com a máquina carregada o event loop
// atrasa os timers, e um sleep curto olhava a fila antes de ela ter tido a vez.
// O limite alto só vale para o caso de a fila realmente travar (aí o check falha).
const until = async (cond, limitMs = 30000) => {
  const deadline = Date.now() + limitMs;
  while (!cond() && Date.now() < deadline) await sleep(20);
};
const t0 = Date.now();

// --- 1. dedupe por JID e teto de concorrência
for (let i = 0; i < 5; i++) sm.enqueueAvatarFetch('L1', '5511900000001@s.whatsapp.net');
sm.enqueueAvatarFetch('L1', '5511900000002@s.whatsapp.net');
sm.enqueueAvatarFetch('L1', '5511900000003@s.whatsapp.net');
await until(() => started.length >= 1);
check('rajada do mesmo JID vira 1 job', sm.avatarQueue.size + started.length === 3, `fila=${sm.avatarQueue.size} started=${started.length}`);
check('1ª partida é imediata', started.length === 1, `started=${started.length}`);

// O espaçamento de 300ms entre PARTIDAS é global, então a 2ª vaga só é ocupada
// depois dele — concorrência 2 vale para chamadas longas (profilePictureUrl leva
// segundos), não para uma rajada instantânea.
await until(() => sm.avatarConcurrent === 2);
check('2ª vaga ocupada após o espaçamento', sm.avatarConcurrent === 2, `concurrent=${sm.avatarConcurrent}`);
check('não passa de 2 em vôo', started.length === 2, `started=${started.length}`);

// --- 2. a fila volta a andar quando um worker libera (era o bug do timer:
// o callback via o próprio handle ainda setado e voltava sem fazer nada)
holdResolvers.shift()();
await until(() => started.length >= 3);
check('liberar vaga faz a fila andar', started.length === 3, `started=${started.length}`);

// --- 3. vivo passa na frente do backfill
holdResolvers.forEach((r) => r());
holdResolvers = [];
await until(() => sm.avatarConcurrent === 0);
started.length = 0;
for (let i = 0; i < 4; i++) {
  sm.enqueueAvatarFetch('L1', `1203634000000000${i}@g.us`, { priority: 1, backfillId: 'bf1' });
}
sm.enqueueAvatarFetch('L1', '5511977777777@s.whatsapp.net', { priority: 0 });
await until(() => started.length >= 1);
check('job vivo é o primeiro a partir', started[0]?.priority === 0, `primeiro=${JSON.stringify(started[0])}`);

// --- 4. espaçamento de 2s entre partidas de backfill
const soltaTudo = setInterval(() => {
  holdResolvers.forEach((r) => r());
  holdResolvers = [];
}, 50);
const backfillStarts = () => started.filter((s) => s.priority === 1).map((s) => s.at);
await until(() => backfillStarts().length >= 3);
clearInterval(soltaTudo);
const starts = backfillStarts();
const gaps = starts.slice(1).map((at, i) => at - starts[i]);
check(
  'backfill respeita ~2s entre partidas',
  gaps.length >= 1 && gaps.every((g) => g >= 1900),
  `starts=${starts.length} gaps=${JSON.stringify(gaps)}`
);

// --- 5. disjuntor de 429 pausa a fila inteira
holdResolvers.forEach((r) => r());
holdResolvers = [];
sm.avatarQueue.clear();
started.length = 0;
sm.avatarPausedUntil = Date.now() + 5000;
sm.enqueueAvatarFetch('L1', '5511966666666@s.whatsapp.net', { force: true });
await sleep(500);
check('pausado não parte nada', started.length === 0, `started=${started.length}`);
await until(() => started.length >= 1);
check('acaba a pausa e a fila anda sozinha', started.length === 1, `started=${started.length}`);

// --- 6. notBefore distante não bloqueia um job pronto
holdResolvers.forEach((r) => r());
holdResolvers = [];
sm.avatarQueue.clear();
started.length = 0;
sm.avatarLastStartAt = 0;
sm.enqueueAvatarFetch('L1', '5511955555555@s.whatsapp.net', { force: true, notBefore: Date.now() + 300000 });
sm.enqueueAvatarFetch('L1', '5511944444444@s.whatsapp.net', { force: true });
await until(() => started.length >= 1);
await sleep(100);
check('job pronto não espera o adiado', started.length === 1 && started[0].jid.includes('44444'), `started=${JSON.stringify(started)}`);

// --- 7. cache de desfecho bloqueia re-enfileiramento
sm.avatarQueue.clear();
started.length = 0;
sm.rememberAvatarAttempt('L1', '5511933333333@s.whatsapp.net', 'no_photo');
sm.enqueueAvatarFetch('L1', '5511933333333@s.whatsapp.net');
check('desfecho conhecido não reenfileira', sm.avatarQueue.size === 0);
sm.enqueueAvatarFetch('L1', '5511933333333@s.whatsapp.net', { force: true });
check('force ignora o cache', sm.avatarQueue.size === 1);

// --- 8. teto da fila rejeita o novo, não o antigo
sm.avatarQueue.clear();
for (let i = 0; i < sm.MAX_AVATAR_QUEUE + 10; i++) {
  sm.enqueueAvatarFetch('L1', `55119${String(i).padStart(8, '0')}@s.whatsapp.net`, { force: true });
}
check('fila não passa do teto', sm.avatarQueue.size <= sm.MAX_AVATAR_QUEUE, `size=${sm.avatarQueue.size}`);
check('primeiro enfileirado sobreviveu', sm.avatarQueue.has('L1:5511900000000@s.whatsapp.net'), '(rejeita-o-novo)');
check('contador de descarte subiu', sm.avatarQueueDropped >= 10, `dropped=${sm.avatarQueueDropped}`);

// --- 9. reenfileiro de DENTRO do job (chave ainda em voo) não pode ser descartado
sm.avatarQueue.clear();
sm.avatarAttemptCache.flushAll();
const emVoo = { phoneNumberId: 'L1', jid: '111222333444555@lid', isGroup: false, quality: 'preview', priority: 0, resolveMisses: 0, notBefore: 0, contactPhone: '5511922222222' };
sm.avatarInFlight.add('L1:111222333444555@lid');
sm.enqueueAvatarFetch('L1', '111222333444555@lid', { force: true, notBefore: Date.now() + 300000 });
check('enqueue direto com chave em voo é recusado (dedupe)', sm.avatarQueue.size === 0, `size=${sm.avatarQueue.size}`);
sm.requeueAvatarJob(emVoo, { notBefore: Date.now() + 300000, resolveMisses: 1 });
const requeued = sm.avatarQueue.get('L1:111222333444555@lid');
check('requeueAvatarJob entra na fila mesmo com a chave em voo', !!requeued, `size=${sm.avatarQueue.size}`);
check('requeue preserva o telefone e conta a tentativa', requeued?.contactPhone === '5511922222222' && requeued?.resolveMisses === 1, JSON.stringify(requeued));
check('requeue tira a chave de voo', !sm.avatarInFlight.has('L1:111222333444555@lid'));
sm.avatarQueue.clear();

// --- 10. conversa 1:1 é procurada pelo telefone, não pelos dígitos do LID
check('hint de telefone vence o JID', sm.avatarLookupPhone('111222333444555@lid', '5511933333333') === '5511933333333');
check('hint com formatação é limpo', sm.avatarLookupPhone('5511933333333@s.whatsapp.net', '+55 11 93333-3333') === '5511933333333');
sm.lidPhoneCache.set('999888777666555', '5511944444444');
check('sem hint, LID resolve pelo cache', sm.avatarLookupPhone('999888777666555@lid') === '5511944444444');
check('LID desconhecido cai nos dígitos crus (conversa com LID cru)', sm.avatarLookupPhone('123123123123123@lid') === '123123123123123');
check('PN sem hint usa os próprios dígitos', sm.avatarLookupPhone('5511955555555@s.whatsapp.net') === '5511955555555');

console.log(`\n${fail === 0 ? 'TODOS OS CHECKS PASSARAM' : fail + ' CHECK(S) FALHARAM'}  (${Date.now() - t0}ms)`);
process.exit(fail === 0 ? 0 : 1);
