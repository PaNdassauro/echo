// deno test --no-config --allow-env --allow-read supabase/functions/_shared/url-publica.test.ts
// O mesmo storage-js que o supabase-js 2.87.1 embute (o createClient inteiro deixa timers abertos no teste).
import { StorageClient } from 'https://esm.sh/@supabase/storage-js@2.87.1';
import {
  PublicUrlConfigError,
  basePublica,
  baseInterna,
  caminhoDoAnexoNosso,
  ehAnexoNosso,
  paraUrlInterna,
  urlPublicaDoAnexo,
} from './url-publica.ts';

function igual(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

function comEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const antes = Object.keys(vars).map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    fn();
  } finally {
    for (const [k, v] of antes) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const DOCKER = { SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: 'https://echo.example.com' };
const NUVEM = { SUPABASE_URL: 'https://abc.supabase.co', ECHO_PUBLIC_URL: undefined };

Deno.test('bases: interna = SUPABASE_URL, pública = ECHO_PUBLIC_URL, sem barra final', () => {
  comEnv({ SUPABASE_URL: 'http://gateway:8000/', ECHO_PUBLIC_URL: 'https://echo.example.com//' }, () => {
    igual(baseInterna(), 'http://gateway:8000', 'interna');
    igual(basePublica(), 'https://echo.example.com', 'pública');
  });
});

Deno.test('sem ECHO_PUBLIC_URL a pública é a SUPABASE_URL (caminho Supabase Cloud/CLI: nada muda)', () => {
  comEnv(NUVEM, () => {
    igual(basePublica(), 'https://abc.supabase.co', 'pública = SUPABASE_URL');
    igual(urlPublicaDoAnexo('outbound/u/a.png'), 'https://abc.supabase.co/storage/v1/object/public/attachments/outbound/u/a.png', 'url');
  });
  comEnv({ ...NUVEM, ECHO_PUBLIC_URL: '   ' }, () => {
    igual(basePublica(), 'https://abc.supabase.co', 'ECHO_PUBLIC_URL em branco vale como ausente');
  });
});

Deno.test('sem nenhuma das duas variáveis, falha com erro claro; valor inválido também', () => {
  comEnv({ SUPABASE_URL: undefined, ECHO_PUBLIC_URL: undefined }, () => {
    for (const f of [baseInterna, basePublica, () => urlPublicaDoAnexo('a')]) {
      let msg = '';
      try {
        f();
      } catch (e) {
        msg = (e as Error).message;
      }
      igual(msg.includes('não configurada'), true, `mensagem: ${msg}`);
    }
    igual(ehAnexoNosso('http://gateway:8000/storage/v1/object/public/attachments/a.png'), false, 'sem bases nada é nosso');
  });
  comEnv({ SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: 'isso nao e url' }, () => {
    let lancou = false;
    try {
      basePublica();
    } catch {
      lancou = true;
    }
    igual(lancou, true, 'ECHO_PUBLIC_URL inválida não cai no fallback em silêncio');
  });
});

Deno.test('urlPublicaDoAnexo é idêntica ao getPublicUrl do storage-js 2.87.1 (nomes com espaço, acento, # e ?)', () => {
  comEnv(DOCKER, () => {
    const storage = new StorageClient(`${basePublica()}/storage/v1`, { apikey: 'chave-qualquer' });
    const storageJs = storage.from('attachments');
    for (
      const path of [
        'outbound/u1/foto.png',
        'outbound/u1/Relatório final (v2).pdf',
        'outbound/u1/a b+c%d.png',
        'stickers/u/ç ã ü.webp',
        'outbound/u1/arquivo#1?x=2.png',
        'template-headers/2026/11/ünïcode-🙂.jpg',
      ]
    ) {
      igual(urlPublicaDoAnexo(path), storageJs.getPublicUrl(path).data.publicUrl, path);
    }
    igual(
      urlPublicaDoAnexo('x/a.png', 'outro'),
      storage.from('outro').getPublicUrl('x/a.png').data.publicUrl,
      'outro bucket',
    );
  });
});

Deno.test('caminhoDoAnexoNosso reconhece a base pública e a interna e devolve o caminho decodificado', () => {
  comEnv(DOCKER, () => {
    const publica = urlPublicaDoAnexo('outbound/u1/Relatório final.pdf');
    igual(caminhoDoAnexoNosso(publica), 'outbound/u1/Relatório final.pdf', 'pública, decodificado');
    igual(
      caminhoDoAnexoNosso('http://gateway:8000/storage/v1/object/public/attachments/outbound/u1/a%20b.png?x=1'),
      'outbound/u1/a b.png',
      'interna, sem query',
    );
    igual(
      caminhoDoAnexoNosso('https://echo.example.com/storage/v1/object/public/attachments/a/b.png?v=1a2b3c4d'),
      'a/b.png',
      'query fora do caminho',
    );
    igual(
      caminhoDoAnexoNosso('https://echo.example.com/storage/v1/object/sign/attachments/a/b.png?token=abc'),
      null,
      'URL assinada é externa (decisão 6: só object/public/)',
    );
    igual(ehAnexoNosso(publica), true, 'ehAnexoNosso');
  });
});

Deno.test('caminhoDoAnexoNosso recusa host alheio, outro bucket, `..`, escape malformado e não-URL', () => {
  comEnv(DOCKER, () => {
    for (
      const url of [
        'https://evil.example.com/storage/v1/object/public/attachments/a.png',
        'https://echo.example.com.evil.com/storage/v1/object/public/attachments/a.png',
        'http://echo.example.com/storage/v1/object/public/attachments/a.png', // outro esquema = outra origem
        'https://echo.example.com/storage/v1/object/public/outro/a.png',
        'https://echo.example.com/storage/v1/object/public/attachments/../segredo',
        'https://echo.example.com/storage/v1/object/public/attachments/%2e%2e/segredo',
        'https://echo.example.com/storage/v1/object/public/attachments/a%E0%A4%A.png',
        'https://echo.example.com/storage/v1/object/authenticated/attachments/a.png',
        'https://echo.example.com/storage/v1/render/image/public/attachments/a.png',
        'https://echo.example.com/dashboard',
        'não é url',
        '',
      ]
    ) {
      igual(caminhoDoAnexoNosso(url), null, url);
    }
  });
});

Deno.test('caminhoDoAnexoNosso: bucket explícito', () => {
  comEnv(DOCKER, () => {
    const u = 'https://echo.example.com/storage/v1/object/public/stickers/a.webp';
    igual(caminhoDoAnexoNosso(u), null, 'bucket padrão não casa');
    igual(caminhoDoAnexoNosso(u, 'stickers'), 'a.webp', 'bucket informado');
  });
});

Deno.test('paraUrlInterna troca só a base dos anexos nossos e mantém caminho e query', () => {
  comEnv(DOCKER, () => {
    igual(
      paraUrlInterna('https://echo.example.com/storage/v1/object/public/attachments/outbound/u1/a%20b.png'),
      'http://gateway:8000/storage/v1/object/public/attachments/outbound/u1/a%20b.png',
      'pública vira interna',
    );
    igual(
      paraUrlInterna('https://echo.example.com/storage/v1/object/public/attachments/a.png?v=1a2b3c4d'),
      'http://gateway:8000/storage/v1/object/public/attachments/a.png?v=1a2b3c4d',
      'query preservada',
    );
    const assinada = 'https://echo.example.com/storage/v1/object/sign/attachments/a.png?token=abc';
    igual(paraUrlInterna(assinada), assinada, 'URL assinada fica como está (externa)');
    const interna = 'http://gateway:8000/storage/v1/object/public/attachments/a.png';
    igual(paraUrlInterna(interna), interna, 'já interna fica igual');
  });
});

Deno.test('paraUrlInterna de URL alheia devolve igual (nunca reescreve host de terceiro)', () => {
  comEnv(DOCKER, () => {
    for (
      const url of [
        'https://evil.example.com/storage/v1/object/public/attachments/a.png',
        'https://cdn.example.org/foto.png',
        'https://echo.example.com/dashboard',
        'https://echo.example.com/storage/v1/object/public/outro/a.png',
        'não é url',
      ]
    ) {
      igual(paraUrlInterna(url), url, url);
    }
  });
});

Deno.test('sem ECHO_PUBLIC_URL, interna e pública coincidem e paraUrlInterna não muda nada', () => {
  comEnv(NUVEM, () => {
    const url = urlPublicaDoAnexo('outbound/u/a.png');
    igual(paraUrlInterna(url), url, 'igual');
    igual(ehAnexoNosso(url), true, 'nosso');
  });
});

// ---- tabela de casos de qr-service/tests/public-url.test.ts (o par; mudou lá, muda aqui) ----------------------------

const PAR = { SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: 'https://echo.exemplo.com' };
const PUB = 'https://echo.exemplo.com/storage/v1/object/public/attachments/inbound/abc/1_foto.jpg';
const INT = 'http://gateway:8000/storage/v1/object/public/attachments/inbound/abc/1_foto.jpg';

function lanca(f: () => unknown): Error | null {
  try {
    f();
    return null;
  } catch (e) {
    return e as Error;
  }
}

Deno.test('par do qr: bases (barra final, espaços, SUPABASE_URL como pública sem ECHO_PUBLIC_URL)', () => {
  comEnv(PAR, () => {
    igual(baseInterna(), 'http://gateway:8000', 'interna');
    igual(basePublica(), 'https://echo.exemplo.com', 'pública');
  });
  comEnv({ SUPABASE_URL: 'https://abc.supabase.co/', ECHO_PUBLIC_URL: undefined }, () => {
    igual(baseInterna(), 'https://abc.supabase.co', 'interna sem barra');
    igual(basePublica(), 'https://abc.supabase.co', 'pública = interna');
  });
  comEnv({ SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: '  http://localhost:8088/  ' }, () => {
    igual(basePublica(), 'http://localhost:8088', 'espaços e barra');
  });
});

Deno.test('par do qr: variável inválida lança PublicUrlConfigError com o nome da variável', () => {
  for (const [valor, nome] of [['ftp://echo.exemplo.com', 'ECHO_PUBLIC_URL'], ['não é url', 'ECHO_PUBLIC_URL'], ['https://u:p@echo.exemplo.com', 'ECHO_PUBLIC_URL'], ['https://echo.exemplo.com/?a=1', 'ECHO_PUBLIC_URL'], ['https://echo.exemplo.com/#x', 'ECHO_PUBLIC_URL']] as const) {
    comEnv({ SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: valor }, () => {
      const e = lanca(basePublica);
      igual(e instanceof PublicUrlConfigError && e.message.includes(nome), true, `${valor}: ${e?.message}`);
    });
  }
  comEnv({ SUPABASE_URL: 'gateway:8000', ECHO_PUBLIC_URL: undefined }, () => {
    igual(lanca(baseInterna) instanceof PublicUrlConfigError, true, 'SUPABASE_URL sem esquema');
  });
  comEnv({ SUPABASE_URL: undefined, ECHO_PUBLIC_URL: undefined }, () => {
    igual(lanca(baseInterna)?.message.includes('SUPABASE_URL não configurada'), true, 'ausente');
  });
});

Deno.test('par do qr: urlPublicaDoAnexo usa a base pública e é idêntica ao getPublicUrl do storage-js', () => {
  comEnv(PAR, () => {
    igual(urlPublicaDoAnexo('inbound/abc/1_foto.jpg'), PUB, 'pública');
  });
  comEnv({ SUPABASE_URL: 'http://127.0.0.1:54321', ECHO_PUBLIC_URL: undefined }, () => {
    const storage = new StorageClient('http://127.0.0.1:54321/storage/v1', { apikey: 'chave-qualquer' });
    for (
      const caminho of [
        'inbound/abc/1_foto.jpg',
        'contact-avatars/x/5511999990001_s_whatsapp_net.jpg',
        'inbound/abc/um arquivo com espaço.pdf',
        'inbound/abc/ação.png',
        'inbound/abc/100%.bin',
        'sticker-cache/ab12.webp',
      ]
    ) {
      igual(urlPublicaDoAnexo(caminho), storage.from('attachments').getPublicUrl(caminho).data.publicUrl, caminho);
    }
    igual(urlPublicaDoAnexo('a/b.txt', 'outro'), 'http://127.0.0.1:54321/storage/v1/object/public/outro/a/b.txt', 'outro bucket');
  });
});

Deno.test('par do qr: caminhoDoAnexoNosso aceita as duas bases, decodifica e ignora a query', () => {
  comEnv(PAR, () => {
    igual(caminhoDoAnexoNosso(PUB), 'inbound/abc/1_foto.jpg', 'pública');
    igual(caminhoDoAnexoNosso(INT), 'inbound/abc/1_foto.jpg', 'interna');
    igual(caminhoDoAnexoNosso(`${PUB}?v=1a2b3c4d`), 'inbound/abc/1_foto.jpg', 'query');
    igual(caminhoDoAnexoNosso(urlPublicaDoAnexo('inbound/abc/ação 100%.png')), 'inbound/abc/ação 100%.png', 'acento, espaço e %');
    igual(caminhoDoAnexoNosso('HTTPS://ECHO.EXEMPLO.COM:443/storage/v1/object/public/attachments/x.png'), 'x.png', 'origem normalizada');
    igual(ehAnexoNosso(PUB), true, 'ehAnexoNosso');
  });
});

Deno.test('par do qr: URL alheia, outro bucket, outro prefixo e disfarces são null', () => {
  comEnv(PAR, () => {
    for (
      const url of [
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
      ]
    ) {
      igual(caminhoDoAnexoNosso(url), null, url);
      igual(ehAnexoNosso(url), false, url);
    }
  });
});

Deno.test('par do qr: subida de diretório e caracteres de controle não passam', () => {
  comEnv(PAR, () => {
    const h = 'https://echo.exemplo.com/storage/v1/object/public/attachments';
    for (
      const url of [
        `${h}/../../../../auth/v1/admin/users`,
        `${h}/%2e%2e/%2e%2e/x`,
        `${h}/a%2f..%2f..%2fb`,
        `${h}/a%2f.%2fb`,
        `${h}/a%5cb`,
        `${h}/a%00b`,
        `${h}/%E0%A4%A`,
      ]
    ) {
      igual(caminhoDoAnexoNosso(url), null, url);
    }
  });
});

Deno.test('par do qr: paraUrlInterna troca a base pública pela interna e deixa o resto como está', () => {
  comEnv(PAR, () => {
    igual(paraUrlInterna(PUB), INT, 'pública');
    igual(paraUrlInterna(INT), INT, 'interna');
    igual(paraUrlInterna(`${PUB}?v=1a2b3c4d`), `${INT}?v=1a2b3c4d`, 'query');
    igual(
      paraUrlInterna(urlPublicaDoAnexo('inbound/abc/ação 100%.png')),
      'http://gateway:8000/storage/v1/object/public/attachments/inbound/abc/a%C3%A7%C3%A3o%20100%25.png',
      'caminho codificado',
    );
    for (const url of ['https://cdn.exemplo.org/foto.jpg', 'https://echo.exemplo.com@atacante.com/storage/v1/object/public/attachments/x.png']) {
      igual(paraUrlInterna(url), url, url);
    }
    igual(paraUrlInterna('https://echo.exemplo.com/storage/v1/object/public/stickers/a.webp', 'stickers'), 'http://gateway:8000/storage/v1/object/public/stickers/a.webp', 'bucket informado');
  });
});

Deno.test('par do qr: sem ECHO_PUBLIC_URL (Supabase hospedado) pública e interna são a mesma base e nada muda', () => {
  comEnv({ SUPABASE_URL: 'https://abc.supabase.co', ECHO_PUBLIC_URL: undefined }, () => {
    const url = 'https://abc.supabase.co/storage/v1/object/public/attachments/inbound/a/1.png';
    igual(urlPublicaDoAnexo('inbound/a/1.png'), url, 'url');
    igual(paraUrlInterna(url), url, 'paraUrlInterna');
    igual(caminhoDoAnexoNosso(url), 'inbound/a/1.png', 'caminho');
  });
});
