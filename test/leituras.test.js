// Contagem de leituras por requisição (o log que aparece na Vercel).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { contarLeituras, registrarLeituras } from "../src/leituras.js";

test("soma as leituras da requisição, mesmo depois de um await, e registra a rota sem os ids", async (t) => {
  const linhas = [];
  t.mock.method(console, "log", (linha) => linhas.push(linha));

  const app = express();
  app.use(registrarLeituras);
  app.get("/faturas/:id", async (req, res) => {
    contarLeituras(1);
    await new Promise((ok) => setTimeout(ok, 5));
    contarLeituras(30);
    res.json({});
  });
  app.get("/nada", (req, res) => res.json({}));

  const servidor = app.listen(0);
  await new Promise((ok) => servidor.once("listening", ok));
  const base = `http://localhost:${servidor.address().port}`;
  await (await fetch(`${base}/faturas/1234-5678_2026-12`)).text();
  await (await fetch(`${base}/nada`)).text();
  servidor.close();
  await new Promise((ok) => setTimeout(ok, 10));

  assert.deepEqual(linhas, ["[leituras] GET /faturas/:id 200 31"]);
});

test("fora de uma requisição não faz nada", () => {
  assert.doesNotThrow(() => contarLeituras(5));
});
