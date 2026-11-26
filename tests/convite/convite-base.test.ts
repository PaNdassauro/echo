// deno test --no-config --allow-env --allow-read tests/convite
import { baseDoConviteLocal } from "../../supabase/functions/_shared/convite-base.ts";

function igual(a: unknown, b: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
const h = (o: Record<string, string>) => new Headers(o);

Deno.test("com ECHO_PUBLIC_URL (docker), a origem localhost do chamador nunca vale: o link usa o canônico", () => {
  igual(baseDoConviteLocal(h({ origin: "http://localhost:8088" }), "http://192.168.1.10:8088"), "", "origin localhost");
  igual(baseDoConviteLocal(h({ referer: "http://127.0.0.1:8088/settings" }), "https://echo.example.com"), "", "referer 127.0.0.1");
});

Deno.test("sem ECHO_PUBLIC_URL (CLI/Cloud), localhost segue valendo para o desenvolvimento, só com a origem", () => {
  igual(baseDoConviteLocal(h({ origin: "http://localhost:8080" }), undefined), "http://localhost:8080", "origin");
  igual(baseDoConviteLocal(h({ referer: "http://127.0.0.1:5173/team?x=1" }), ""), "http://127.0.0.1:5173", "referer sem o path");
  igual(baseDoConviteLocal(h({ origin: "http://localhost:8080" }), "  "), "http://localhost:8080", "variável só com espaço");
});

Deno.test("origem de outro domínio nunca vale, nem com 'localhost' no nome", () => {
  igual(baseDoConviteLocal(h({ origin: "https://app.example.com" }), undefined), "", "outro domínio");
  igual(baseDoConviteLocal(h({ origin: "https://localhost.evil.com" }), undefined), "", "localhost.evil.com");
  igual(baseDoConviteLocal(h({ referer: "https://evil.com/localhost" }), undefined), "", "localhost no path");
  igual(baseDoConviteLocal(h({}), undefined), "", "sem cabeçalho");
  igual(baseDoConviteLocal(h({ origin: "null" }), undefined), "", "origin 'null'");
});
