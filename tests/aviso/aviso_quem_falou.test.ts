import {
  decidirQuemFalou,
  identidadesDoRemetente,
  variantesDeTelefone,
} from "../../supabase/functions/_shared/aviso-quem-falou.ts";

function igual(a: unknown, b: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

const linha = { id: "linha-vendas", nome: "Vendas" };

Deno.test("telefone com e sem o 9º dígito", () => {
  igual(variantesDeTelefone("5511999990001").sort(), ["551199990001", "5511999990001"].sort(), "com 9");
  igual(variantesDeTelefone("+55 11 9999-0002").sort(), ["551199990002", "5511999990002"].sort(), "sem 9");
  igual(variantesDeTelefone(""), [], "vazio");
});

Deno.test("remetente pelo @lid entra só pelo código antes do @", () => {
  igual(identidadesDoRemetente(null, "100000000000001@lid"), ["100000000000001"], "lid");
});

Deno.test("saída da própria linha é equipe, com quem digitou quando o Echo sabe", () => {
  igual(
    decidirQuemFalou({ saida: true, linhaDoAviso: linha, pessoa: "Bruno", origem: "api", grupo: true, remetente: {}, linhaDaIdentidade: null }),
    { tipo: "equipe", linha_id: "linha-vendas", linha_nome: "Vendas", pessoa: "Bruno", origem: "api" },
    "saída",
  );
});

Deno.test("fala nossa vista por outra linha vira equipe da linha que falou", () => {
  igual(
    decidirQuemFalou({
      saida: false, linhaDoAviso: { id: "linha-suporte", nome: "Suporte" }, grupo: true,
      remetente: { telefone: "551199990001", nome: "Bruno" }, linhaDaIdentidade: linha,
    }),
    { tipo: "equipe", linha_id: "linha-vendas", linha_nome: "Vendas" },
    "equipe por outra linha",
  );
});

Deno.test("fala do contato é cliente; grupo sem remetente é não sabemos", () => {
  igual(
    decidirQuemFalou({ saida: false, linhaDoAviso: linha, grupo: true, remetente: { telefone: "551199990003", nome: "Ana" }, linhaDaIdentidade: null }),
    { tipo: "cliente", nome: "Ana", telefone: "551199990003", jid: null },
    "cliente",
  );
  igual(
    decidirQuemFalou({ saida: false, linhaDoAviso: linha, grupo: true, remetente: {}, linhaDaIdentidade: null }),
    { tipo: "desconhecido" },
    "sem remetente",
  );
});
