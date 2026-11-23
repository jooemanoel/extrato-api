// Sincronização com o aparelho: carga completa, mudanças desde a última vez, exclusões
// e a fila de alterações feitas offline. Repositório em memória.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { criarApp } from "../src/app.js";
import { criarRepositorioMemoria } from "../src/repositorios/memoria.js";
import { gerarOfx, saldoDe } from "./ofx-sintetico.js";

const config = { segredo: "s".repeat(40), validade: "30d", origens: ["*"], limiteTentativas: 1000 };
const repo = criarRepositorioMemoria();
let servidor;
let base;
let ana;

async function chamar(metodo, caminho, { corpo, token = ana } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (corpo !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  return { status: r.status, dados: texto ? JSON.parse(texto) : null };
}

const sincronizar = (desde) => chamar("GET", `/sincronizacao${desde ? `?desde=${encodeURIComponent(desde)}` : ""}`);
const enviar = (operacoes) => chamar("POST", "/sincronizacao", { corpo: { operacoes } });
const ids = (lista) => lista.map((x) => x.id).sort();

const LINHAS = [
  ["20261105", "-12.50", "PADARIA PAO BOM        BRASILIA      BR"],
  ["20261106", "-30.00", "POSTO SOL              BRASILIA      BR"],
];

before(async () => {
  servidor = criarApp({ repo, config }).listen(0);
  await new Promise((ok) => servidor.once("listening", ok));
  base = `http://localhost:${servidor.address().port}`;
  const r = await fetch(`${base}/auth/cadastro`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: "Ana", senha: "segredo1" }),
  });
  ana = (await r.json()).token;
  await chamar("POST", "/importacoes", {
    corpo: { nomeArquivo: "CARTAO-Dez_26.ofx", conteudo: gerarOfx({ cartao: "1234000000005678", saldo: saldoDe(LINHAS), linhas: LINHAS }) },
  });
});
after(() => servidor.close());

describe("sincronização", () => {
  let primeira;

  test("sem 'desde' vem tudo, com as categorias", async () => {
    const r = await sincronizar();
    assert.equal(r.status, 200);
    primeira = r.dados;
    assert.equal(primeira.completa, true);
    assert.equal(primeira.cartoes.length, 1);
    assert.deepEqual(ids(primeira.faturas), ["1234-5678_2026-12"]);
    assert.equal(primeira.compras.length, 2);
    assert.deepEqual(primeira.exclusoes, []);
    assert.ok(primeira.categorias.some((c) => c.id === "restaurante"));
    assert.ok(primeira.compras.every((c) => c.atualizadoEm));
    assert.equal(primeira.token, undefined); // token de 30 dias ainda não precisa ser renovado
  });

  test("com 'desde' vem só o que mudou, e as exclusões", async () => {
    const [padaria, posto] = [...primeira.compras].sort((a, b) => a.data.localeCompare(b.data));
    const instante = (await repo.mudancas("ANA")).compras.map((c) => c.atualizadoEm).sort().at(-1);
    await chamar("PATCH", `/compras/${encodeURIComponent(padaria.id)}`, { corpo: { descricao: "Pão de sábado" } });
    await chamar("DELETE", `/compras/${encodeURIComponent(posto.id)}`);

    // No repositório, sem a folga da rota: só o que foi gravado depois do instante.
    const exato = await repo.mudancas("ANA", instante);
    assert.deepEqual(ids(exato.compras), [padaria.id]);
    assert.equal(exato.cartoes.length, 0);
    assert.deepEqual(ids(exato.faturas), ["1234-5678_2026-12"]); // o total mudou com a exclusão
    assert.deepEqual(exato.exclusoes.map((e) => [e.tipo, e.id]), [["compra", posto.id]]);

    // Pela rota (com a folga, vem também o que foi gravado logo antes).
    const r = (await sincronizar(primeira.agora)).dados;
    assert.equal(r.completa, false);
    assert.equal(r.compras.find((c) => c.id === padaria.id).descricao, "PÃO DE SÁBADO");
    assert.ok(!r.compras.some((c) => c.id === posto.id));
    assert.ok(r.exclusoes.some((e) => e.tipo === "compra" && e.id === posto.id));
  });

  test("'desde' inválido é recusado", async () => {
    assert.equal((await sincronizar("ontem")).status, 400);
  });

  test("token perto de vencer volta renovado", async () => {
    const curto = jwt.sign({ nome: "ANA" }, config.segredo, { subject: "ANA", issuer: "extrato-api", expiresIn: "1d" });
    const r = await chamar("GET", "/sincronizacao", { token: curto });
    assert.equal(r.status, 200);
    assert.ok(r.dados.token);
    assert.equal(jwt.decode(r.dados.token).sub, "ANA");
  });
});

describe("fila de alterações", () => {
  const compraId = "AbCdEfGhIjKlMnOpQrSt";
  const faturaId = "1234-5678_2026-12";

  test("cria, altera e exclui na ordem, sem duplicar quando o envio se repete", async () => {
    const operacoes = [
      { id: "op1", tipo: "criarCompra", compraId, faturaId, data: "2026-11-20", valor: -1990, descricao: "Feira" },
      { id: "op2", tipo: "alterarCompra", compraId, campos: { valor: -2190 } },
    ];
    const r = await enviar(operacoes);
    assert.equal(r.status, 200);
    assert.deepEqual(r.dados.resultados, [{ id: "op1", ok: true }, { id: "op2", ok: true }]);

    // A conexão caiu antes da resposta chegar: o aparelho manda tudo de novo.
    assert.deepEqual((await enviar(operacoes)).dados.resultados.map((x) => x.ok), [true, true]);

    const fatura = (await chamar("GET", `/faturas/${faturaId}`)).dados;
    const criadas = fatura.compras.filter((c) => c.id === compraId);
    assert.equal(criadas.length, 1);
    assert.equal(criadas[0].valor, -2190);
    assert.equal(criadas[0].origem, "manual");
    assert.equal(fatura.fatura.quantidade, 2); // a padaria e a feira (o posto foi excluído antes)
    assert.equal(fatura.fatura.totalCompras, -1250 - 2190);

    const exclusao = [{ id: "op3", tipo: "excluirCompra", compraId }];
    assert.deepEqual((await enviar(exclusao)).dados.resultados, [{ id: "op3", ok: true }]);
    assert.deepEqual((await enviar(exclusao)).dados.resultados, [{ id: "op3", ok: true }]); // já não existia
    assert.equal((await chamar("GET", `/faturas/${faturaId}`)).dados.fatura.quantidade, 1);
  });

  test("uma operação recusada não trava as outras", async () => {
    const r = await enviar([
      { id: "a", tipo: "alterarCompra", compraId: "nao-existe", campos: { descricao: "x" } },
      { id: "b", tipo: "criarCompra", compraId: "curto", faturaId, data: "2026-11-20", valor: -100, descricao: "X" },
      { id: "c", tipo: "voar" },
      { id: "d", tipo: "criarCompra", compraId: "ZzZzZzZzZzZzZzZzZzZz", faturaId, data: "2026-11-21", valor: -100, descricao: "Café" },
    ]);
    assert.deepEqual(r.dados.resultados.map((x) => x.ok), [false, false, false, true]);
    assert.match(r.dados.resultados[0].motivo, /não encontrada/);
  });

  test("lote grande demais é recusado", async () => {
    const muitas = Array.from({ length: 201 }, (_, i) => ({ id: String(i), tipo: "excluirCompra", compraId: "x" }));
    assert.equal((await enviar(muitas)).status, 413);
  });
});

describe("exclusões que o aparelho precisa saber", () => {
  test("fatura excluída e loja excluída aparecem como exclusões", async () => {
    const antes = (await sincronizar()).dados.agora;
    const loja = (await chamar("POST", "/lojas", { corpo: { nome: "Posto Sol", padroes: [{ texto: "POSTOSOL" }] } })).dados.loja;
    await chamar("DELETE", `/lojas/${loja.id}`);
    await chamar("DELETE", "/faturas/1234-5678_2026-12");

    const r = (await sincronizar(antes)).dados;
    assert.ok(r.exclusoes.some((e) => e.tipo === "loja" && e.id === loja.id));
    assert.ok(r.exclusoes.some((e) => e.tipo === "fatura" && e.id === "1234-5678_2026-12"));
    assert.ok(r.exclusoes.every((e) => e.em && !e.id.includes("_2026-12_"))); // o id é o do item, não o da marcação
  });
});
