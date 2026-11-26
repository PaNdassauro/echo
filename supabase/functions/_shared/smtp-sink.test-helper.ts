// Servidor SMTP mínimo para os testes de e-mail, só em 127.0.0.1 e porta efêmera: nenhum e-mail sai de verdade.
// Aceita EHLO/HELO, AUTH (qualquer coisa), MAIL, RCPT, DATA, RSET, NOOP e QUIT. Guarda as mensagens recebidas.
export interface Recebida {
  from: string;
  to: string[];
  data: string;
  authUsada: boolean;
}

export function abrirSink(): { port: number; recebidas: Recebida[]; fechar: () => void } {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const recebidas: Recebida[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const conexoes: Deno.Conn[] = [];

  (async () => {
    for await (const conn of listener) {
      conexoes.push(conn);
      (async () => {
        const w = (s: string) => conn.write(enc.encode(s + '\r\n'));
        let atual: Recebida = { from: '', to: [], data: '', authUsada: false };
        let emData = false;
        let buf = '';
        let authPendente = 0;
        await w('220 sink ESMTP');
        const bytes = new Uint8Array(65536);
        try {
          while (true) {
            const n = await conn.read(bytes);
            if (n === null) break;
            buf += dec.decode(bytes.subarray(0, n));
            while (true) {
              if (emData) {
                const fim = buf.indexOf('\r\n.\r\n');
                if (fim === -1) break;
                atual.data += buf.slice(0, fim);
                buf = buf.slice(fim + 5);
                emData = false;
                recebidas.push(atual);
                atual = { from: '', to: [], data: '', authUsada: false };
                await w('250 OK queued');
                continue;
              }
              const i = buf.indexOf('\r\n');
              if (i === -1) break;
              const linha = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const cmd = linha.toUpperCase();
              if (authPendente > 0) {
                authPendente--;
                if (authPendente === 0) await w('235 Authentication successful');
                else await w('334 UGFzc3dvcmQ6');
                continue;
              }
              if (cmd.startsWith('EHLO')) {
                await conn.write(enc.encode('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n'));
              } else if (cmd.startsWith('HELO')) await w('250 sink');
              else if (cmd.startsWith('AUTH PLAIN')) {
                atual.authUsada = true;
                if (linha.trim().split(' ').length >= 3) await w('235 Authentication successful');
                else { authPendente = 1; await w('334 '); }
              } else if (cmd.startsWith('AUTH LOGIN')) {
                atual.authUsada = true;
                if (linha.trim().split(' ').length >= 3) { authPendente = 1; await w('334 UGFzc3dvcmQ6'); }
                else { authPendente = 2; await w('334 VXNlcm5hbWU6'); }
              } else if (cmd.startsWith('MAIL FROM')) { atual.from = linha.slice(10); await w('250 OK'); }
              else if (cmd.startsWith('RCPT TO')) { atual.to.push(linha.slice(8)); await w('250 OK'); }
              else if (cmd === 'DATA') { emData = true; await w('354 End data with <CR><LF>.<CR><LF>'); }
              else if (cmd === 'RSET' || cmd === 'NOOP') await w('250 OK');
              else if (cmd === 'QUIT') { await w('221 Bye'); conn.close(); return; }
              else await w('502 not implemented');
            }
          }
        } catch {
          // conexão encerrada pelo cliente
        }
        try { conn.close(); } catch { /* já fechada */ }
      })();
    }
  })().catch(() => {});

  return {
    port,
    recebidas,
    fechar: () => {
      try { listener.close(); } catch { /* já fechado */ }
      for (const c of conexoes) { try { c.close(); } catch { /* já fechada */ } }
    },
  };
}
