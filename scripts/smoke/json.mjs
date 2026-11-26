#!/usr/bin/env node
// Lê JSON do stdin e imprime o valor do caminho dado (a.b[0].c). String sai crua; o resto, como JSON. Caminho ausente
// = linha vazia e exit 3. Usado pelo lib.sh no lugar do jq (o host da fumaça só tem Docker, bash e Node).
import { readFileSync } from "node:fs";

const caminho = process.argv[2] ?? "";
let doc;
try {
  doc = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("json.mjs: entrada não é JSON");
  process.exit(2);
}
let atual = doc;
for (const parte of caminho.split(/[.[\]]/).filter(Boolean)) {
  if (atual === null || typeof atual !== "object" || !(parte in atual)) {
    console.log("");
    process.exit(3);
  }
  atual = atual[parte];
}
console.log(typeof atual === "string" ? atual : JSON.stringify(atual));
