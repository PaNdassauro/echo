// Base do link de convite (`<base>/auth?invite=<token>`), escolhida a partir dos cabeçalhos da chamada.
//
// A base canônica é SITE_URL (`siteUrl()` em email.ts). A origem de quem chama só vale em desenvolvimento local
// (painel em localhost falando com as funções do CLI). Na auto-hospedagem o compose define ECHO_PUBLIC_URL, e lá o
// admin pode abrir o painel por http://localhost:PORTA enquanto o convidado entra pelo endereço da rede: o link com
// localhost não abriria na outra máquina, então com ECHO_PUBLIC_URL definido a origem do chamador nunca vale.

/**
 * Devolve a origem localhost/127.0.0.1 do chamador, ou '' quando a base deve ser a canônica (SITE_URL).
 * `publicUrl` é o valor de ECHO_PUBLIC_URL (definido = instalação docker).
 */
export function baseDoConviteLocal(headers: Pick<Headers, 'get'>, publicUrl: string | null | undefined): string {
  if ((publicUrl ?? '').trim() !== '') return '';
  const caller = headers.get('origin') || headers.get('referer') || '';
  let origem: URL;
  try {
    origem = new URL(caller);
  } catch {
    return '';
  }
  // Compara o hostname já parseado: "localhost" dentro de um domínio de terceiro (localhost.evil.com) não vale.
  const host = origem.hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  const http = origem.protocol === 'http:' || origem.protocol === 'https:';
  return local && http ? origem.origin : '';
}
