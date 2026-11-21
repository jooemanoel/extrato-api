// Testes de ponta a ponta da API, com o repositório em memória.
// Rodar: npm test
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { criarApp } from "../src/app.js";
import { criarRepositorioMemoria } from "../src/repositorios/memoria.js";
import { gerarOfx, saldoDe } from "./ofx-sintetico.js";

const config = { segredo: "s".repeat(40), validade: "1h", origens: ["http://localhost:5173"], limiteTentativas: 1000 };
const repo = criarRepositorioMemoria();
let servidor;
let base;
let joao;
let maria;

async function chamar(metodo, caminho, { corpo, token } = {}) {
  const headers = {};
  if (corpo !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + caminho, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
  const texto = await r.text();
  return { status: r.status, dados: texto ? JSON.parse(texto) : null };
}

const importar = (token, nomeArquivo, conteudo, extra = {}) =>
  chamar("POST", "/importacoes", { token, corpo: { nomeArquivo, conteudo, ...extra } });

before(async () => {
  servidor = criarApp({ repo, config }).listen(0);
  await new Promise((ok) => servidor.once("listening", ok));
  base = `http://localhost:${servidor.address().port}`;
  joao = (await chamar("POST", "/auth/cadastro", { corpo: { nome: "João", senha: "segredo1" } })).dados.token;
  maria = (await chamar("POST", "/auth/cadastro", { corpo: { nome: "Maria", senha: "segredo2" } })).dados.token;
});
after(() => servidor.close());

describe("autenticação", () => {
  test("login, nome repetido e senha errada", async () => {
    assert.equal((await chamar("POST", "/auth/cadastro", { corpo: { nome: "joao", senha: "segredo1" } })).status, 409);
    assert.equal((await chamar("POST", "/auth/login", { corpo: { nome: "JOAO", senha: "errada" } })).status, 401);
    const ok = await chamar("POST", "/auth/login", { corpo: { nome: "joão", senha: "segredo1" } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await chamar("GET", "/auth/eu", { token: ok.dados.token })).dados.usuario, { id: "JOAO", nome: "JOAO" });
  });

  test("rotas protegidas recusam token ausente, forjado ou de outro emissor", async () => {
    assert.equal((await chamar("GET", "/faturas")).status, 401);
    const forjado = jwt.sign({ nome: "X" }, "outro-segredo-com-mais-de-32-caracteres", { subject: "X", issuer: "extrato-api" });
    assert.equal((await chamar("GET", "/faturas", { token: forjado })).status, 401);
    const deOutroApp = jwt.sign({ nome: "X" }, config.segredo, { subject: "X", issuer: "listas-api" });
    assert.equal((await chamar("GET", "/faturas", { token: deOutroApp })).status, 401);
  });
});

// Ciclo de uma fatura: aberta importada duas vezes, depois fechada.
const ABERTA_1 = [
  ["20261111", "-42.70", "FRANGOLAR"],
  ["20261111", "-5.50", "BRB MOBILIDADE  METRO"],
  ["20261112", "-110.00", "CAPITAL GAS"],
  ["20261113", "-30.00", "LOJA QUE ESTORNOU"],
];
const ABERTA_2 = [...ABERTA_1, ["20261118", "-12.37", "99*"]];
// Fechada: outra ordem, MEMO com o país, um metrô a mais no mesmo dia, uma compra nova,
// e sem "LOJA QUE ESTORNOU". Inclui o pagamento da fatura anterior.
const FECHADA = [
  ["20261121", "1000.00", "PGTO DEBITO CONTA 0000 000000000  000000"],
  ["20261118", "-12.37", "99*"],
  ["20261112", "-110.00", "CAPITAL GAS"],
  ["20261111", "-5.50", "BRB MOBILIDADE  METRO"],
  ["20261111", "-5.50", "BRB MOBILIDADE  METRO"],
  ["20261111", "-42.70", "FRANGOLAR"],
  ["20261205", "-61.64", "IFD*BR"],
];

describe("importação de faturas", () => {
  test("recusa conta corrente e corpo inválido", async () => {
    const cc = await importar(joao, "extrato.ofx", "<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>");
    assert.equal(cc.status, 422);
    assert.equal((await chamar("POST", "/importacoes", { token: joao, corpo: { conteudo: 1 } })).status, 400);
    const competencia = await importar(joao, "x.ofx", gerarOfx({ linhas: ABERTA_1 }), { competencia: "2026-13" });
    assert.equal(competencia.status, 400);
  });

  test("a prévia não grava nada", async () => {
    const r = await chamar("POST", "/importacoes/previa", {
      token: joao,
      corpo: { nomeArquivo: "OUROCARD_VISA_INFINITE-Próxima_Fatura.ofx", conteudo: gerarOfx({ aberta: true, linhas: ABERTA_1 }) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.dados.novas.length, 4);
    assert.equal(r.dados.fatura.id, "1234-5678_2026-12");
    assert.equal(r.dados.fatura.situacao, "aberta");
    assert.deepEqual((await chamar("GET", "/faturas", { token: joao })).dados, []);
  });

  test("fatura aberta: importar de novo dias depois só acrescenta as compras novas", async () => {
    const primeira = await importar(joao, "OUROCARD_VISA_INFINITE-Próxima_Fatura.ofx", gerarOfx({ aberta: true, linhas: ABERTA_1 }));
    assert.equal(primeira.status, 201);
    assert.equal(primeira.dados.cartao.nome, "OUROCARD VISA INFINITE");
    assert.equal(primeira.dados.novas.length, 4);

    const segunda = await importar(joao, "OUROCARD_VISA_INFINITE-Próxima_Fatura (1).ofx", gerarOfx({ aberta: true, linhas: ABERTA_2 }));
    assert.equal(segunda.dados.novas.length, 1);
    assert.equal(segunda.dados.existentes, 4);
    assert.equal(segunda.dados.fatura.totalCompras, -20057);
    assert.equal(segunda.dados.fatura.quantidade, 5);
  });

  test("fatura fechada: reconhece as compras da aberta, aponta ausentes e confere o total", async () => {
    const conteudo = gerarOfx({ saldo: saldoDe(FECHADA), linhas: FECHADA });
    const r = await importar(joao, "OUROCARD_VISA_INFINITE-Dez_26.ofx", conteudo);
    assert.equal(r.status, 201);
    assert.equal(r.dados.fatura.situacao, "fechada");
    assert.equal(r.dados.existentes, 4); // a aberta tinha um metrô; a fechada tem dois
    assert.deepEqual(r.dados.novas.map((c) => c.nomeEstabelecimento).sort(), ["BRB MOBILIDADE METRO", "IFD*BR"]);
    assert.deepEqual(r.dados.ausentes.map((c) => c.nomeEstabelecimento), ["LOJA QUE ESTORNOU"]);
    assert.equal(r.dados.removidas, 0);
    assert.equal(r.dados.conferencia.confere, false); // a ausente ainda está na fatura
    assert.equal(r.dados.conferencia.diferenca, -3000);
    assert.equal(r.dados.pagamento.aplicado, false); // não há fatura de novembro

    const removendo = await importar(joao, "OUROCARD_VISA_INFINITE-Dez_26.ofx", conteudo, { removerAusentes: true });
    assert.equal(removendo.dados.novas.length, 0);
    assert.equal(removendo.dados.removidas, 1);
    assert.equal(removendo.dados.conferencia.confere, true);

    const fatura = (await chamar("GET", "/faturas/1234-5678_2026-12", { token: joao })).dados.fatura;
    assert.equal(fatura.totalBanco, -23771);
    assert.equal(fatura.totalCompras, -23771);
    assert.equal(fatura.importacoes.length, 4);
  });

  test("depois de fechada, o arquivo da fatura aberta é recusado", async () => {
    const r = await importar(joao, "OUROCARD_VISA_INFINITE-Próxima_Fatura.ofx", gerarOfx({ aberta: true, linhas: ABERTA_2 }), { competencia: "2026-12" });
    assert.equal(r.status, 409);
  });

  test("a fatura fechada move para si compras importadas na competência errada", async () => {
    const linhas = [["20261210", "-20.00", "PADARIA"], ["20261211", "-30.00", "POSTO"]];
    // a aberta foi importada como fevereiro por engano
    await importar(joao, "aberta.ofx", gerarOfx({ aberta: true, linhas }), { competencia: "2027-02" });
    const r = await importar(joao, "OUROCARD_VISA_INFINITE-Jan_27.ofx", gerarOfx({ saldo: saldoDe(linhas), linhas }));
    assert.equal(r.dados.movidas.length, 2);
    assert.equal(r.dados.fatura.quantidade, 2);
    const errada = (await chamar("GET", "/faturas/1234-5678_2027-02", { token: joao })).dados.fatura;
    assert.equal(errada.quantidade, 0);
    assert.equal(errada.totalCompras, 0);
  });

  test("o pagamento da fatura anterior é registrado nela", async () => {
    const nov = [["20261020", "-10.00", "PADARIA"]];
    await importar(joao, "OUROCARD_ELO_NANQUIM-Nov_26.ofx", gerarOfx({ cartao: "9876000000004321", saldo: saldoDe(nov), linhas: nov }));
    const dez = [["20261120", "10.00", "PGTO DEBITO CONTA 0000"], ["20261125", "-9.75", "CANTINA"], ["20261125", "-9.75", "CANTINA"]];
    const r = await importar(joao, "OUROCARD_ELO_NANQUIM-Dez_26.ofx", gerarOfx({ cartao: "9876000000004321", saldo: saldoDe(dez), linhas: dez }));
    assert.equal(r.dados.novas.length, 2); // dois lançamentos idênticos = duas compras
    assert.equal(r.dados.pagamento.aplicado, true);
    const anterior = (await chamar("GET", "/faturas/9876-4321_2026-11", { token: joao })).dados.fatura;
    assert.deepEqual(anterior.pagamento, { data: "2026-11-20", valor: 1000 });
  });

  test("cada usuário só vê as próprias faturas", async () => {
    assert.deepEqual((await chamar("GET", "/faturas", { token: maria })).dados, []);
    assert.equal((await chamar("GET", "/faturas/1234-5678_2026-12", { token: maria })).status, 404);
    const cartoes = (await chamar("GET", "/cartoes", { token: joao })).dados;
    assert.deepEqual(cartoes.map((c) => c.id).sort(), ["1234-5678", "9876-4321"]);
  });
});

describe("lojas", () => {
  let lojaId;

  test("sugestões agrupam as compras sem loja", async () => {
    const r = await chamar("GET", "/lojas/sugestoes", { token: joao });
    assert.equal(r.status, 200);
    const metro = r.dados.find((s) => s.padrao.texto === "BRBMOBILIDADEMETRO");
    assert.equal(metro.quantidade, 2);
    assert.equal(metro.categoria, "transporte");
  });

  test("criar a partir da compra: o padrão segue o nome escolhido", async () => {
    // compras de uma filial que o João tem e outra que só a Maria tem
    const j = [["20261201", "-50.00", "AMERICANAS F485BA"]];
    await importar(joao, "CARTAO-Jan_27.ofx", gerarOfx({ cartao: "1111000000002222", saldo: saldoDe(j), linhas: j }));
    const m = [["20261202", "-70.00", "AMERICANAS F999ZZ"]];
    await importar(maria, "CARTAO-Jan_27.ofx", gerarOfx({ cartao: "3333000000004444", saldo: saldoDe(m), linhas: m }));

    const previa = await chamar("POST", "/lojas/previa", { token: joao, corpo: { padroes: [{ texto: "Americanas" }] } });
    assert.deepEqual(previa.dados.captura.map((g) => g.estabelecimento), ["AMERICANASF485BA"]);

    const r = await chamar("POST", "/lojas", {
      token: joao,
      corpo: { nome: "Americanas", categoria: "variedades", estabelecimento: "AMERICANASF485BA", nomeEstabelecimento: "AMERICANAS F485BA" },
    });
    assert.equal(r.status, 201);
    lojaId = r.dados.loja.id;
    assert.deepEqual(r.dados.loja.padroes, [{ tipo: "prefixo", texto: "AMERICANAS" }]);
    assert.equal(r.dados.comprasAtualizadas, 2); // a do João e a da Maria: lojas são compartilhadas

    const fatura = (await chamar("GET", "/faturas/3333-4444_2027-01", { token: maria })).dados;
    assert.equal(fatura.compras[0].loja.nome, "AMERICANAS");
    assert.equal(fatura.compras[0].categoria, "variedades");
  });

  test("nome repetido e padrão de outra loja são recusados", async () => {
    const nome = await chamar("POST", "/lojas", { token: maria, corpo: { nome: "AMERICANAS", padroes: [{ texto: "AMERICANASSA" }] } });
    assert.equal(nome.status, 409);
    assert.equal(nome.dados.detalhes.lojaId, lojaId);
    const padrao = await chamar("POST", "/lojas", { token: maria, corpo: { nome: "OUTRA", padroes: [{ texto: "americanas" }] } });
    assert.equal(padrao.status, 409);
    assert.equal((await chamar("POST", "/lojas", { token: maria, corpo: { nome: "X", padroes: [{ texto: "A" }] } })).status, 400);
  });

  test("mudar a categoria da loja muda a categoria das compras", async () => {
    await chamar("PATCH", `/lojas/${lojaId}`, { token: joao, corpo: { categoria: "mercado" } });
    const fatura = (await chamar("GET", "/faturas/1111-2222_2027-01", { token: joao })).dados;
    assert.equal(fatura.compras[0].categoria, "mercado");
  });

  test("padrão 'contém' e juntar lojas", async () => {
    const linhas = [["20261203", "-9.10", "PG *99 L2L 99 RIDE"], ["20261204", "-9.80", "DL*99 RIDE"]];
    await importar(joao, "CARTAO-Fev_27.ofx", gerarOfx({ cartao: "1111000000002222", saldo: saldoDe(linhas), linhas }));
    const a = await chamar("POST", "/lojas", { token: joao, corpo: { nome: "99", categoria: "transporte", padroes: [{ tipo: "contem", texto: "99 RIDE" }] } });
    assert.equal(a.dados.comprasAtualizadas, 2);
    const b = await chamar("POST", "/lojas", { token: joao, corpo: { nome: "99 TÁXI", padroes: [{ texto: "99TAXI" }] } });

    const juntou = await chamar("POST", `/lojas/${a.dados.loja.id}/juntar`, { token: joao, corpo: { origemId: b.dados.loja.id } });
    assert.equal(juntou.status, 200);
    assert.equal(juntou.dados.loja.padroes.length, 2);
    assert.equal((await chamar("GET", "/lojas", { token: joao })).dados.some((l) => l.id === b.dados.loja.id), false);
  });

  test("excluir a loja devolve as compras às sugestões", async () => {
    const r = await chamar("DELETE", `/lojas/${lojaId}`, { token: joao });
    assert.equal(r.dados.comprasAtualizadas, 2);
    const sugestoes = (await chamar("GET", "/lojas/sugestoes", { token: maria })).dados;
    assert.ok(sugestoes.some((s) => s.nome === "AMERICANAS"));
  });

  test("ignorar um estabelecimento tira as compras das sugestões", async () => {
    const r = await chamar("POST", "/ignorados", { token: joao, corpo: { estabelecimento: "CAPITALGAS" } });
    assert.equal(r.status, 201);
    assert.equal(r.dados.comprasAtualizadas, 1);
    const sugestoes = (await chamar("GET", "/lojas/sugestoes", { token: joao })).dados;
    assert.ok(!sugestoes.some((s) => s.estabelecimentos.includes("CAPITALGAS")));
    assert.equal((await chamar("DELETE", "/ignorados/CAPITALGAS", { token: joao })).dados.comprasAtualizadas, 1);
  });
});

describe("compras", () => {
  let id;

  test("compra manual soma no total da fatura", async () => {
    const antes = (await chamar("GET", "/faturas/1234-5678_2026-12", { token: joao })).dados.fatura;
    const r = await chamar("POST", "/compras", {
      token: joao,
      corpo: { faturaId: "1234-5678_2026-12", data: "2026-12-01", valor: -1000, descricao: "Feira" },
    });
    assert.equal(r.status, 201);
    id = r.dados.id;
    assert.equal(r.dados.origem, "manual");
    const depois = (await chamar("GET", "/faturas/1234-5678_2026-12", { token: joao })).dados.fatura;
    assert.equal(depois.totalCompras, antes.totalCompras - 1000);
    assert.equal(depois.quantidade, antes.quantidade + 1);
  });

  test("valor de compra manual pode mudar; o de compra do OFX não", async () => {
    const r = await chamar("PATCH", `/compras/${id}`, { token: joao, corpo: { valor: -1500, descricao: "Feira do sábado" } });
    assert.equal(r.dados.valor, -1500);
    assert.equal(r.dados.descricao, "FEIRA DO SÁBADO");

    const fatura = (await chamar("GET", "/faturas/1234-5678_2026-12", { token: joao })).dados;
    const doOfx = fatura.compras.find((c) => c.origem === "ofx");
    assert.equal((await chamar("PATCH", `/compras/${doOfx.id}`, { token: joao, corpo: { valor: -1 } })).status, 400);
  });

  test("loja escolhida à mão não é trocada pelo reconhecimento automático", async () => {
    const loja = (await chamar("POST", "/lojas", { token: joao, corpo: { nome: "FEIRA", categoria: "mercado", padroes: [{ texto: "FEIRAX" }] } })).dados.loja;
    const r = await chamar("PATCH", `/compras/${id}`, { token: joao, corpo: { lojaId: loja.id } });
    assert.equal(r.dados.loja.nome, "FEIRA");
    assert.equal(r.dados.lojaManual, true);
    await chamar("PATCH", `/lojas/${loja.id}`, { token: joao, corpo: { padroes: [{ texto: "FEIRAY" }] } });
    assert.equal((await repo.buscarCompra("JOAO", id)).lojaId, loja.id);

    const auto = await chamar("PATCH", `/compras/${id}`, { token: joao, corpo: { lojaId: null } });
    assert.equal(auto.dados.lojaId, null);
    assert.equal(auto.dados.pendente, true);
  });

  test("excluir desconta do total; compra de outro usuário não é encontrada", async () => {
    assert.equal((await chamar("DELETE", `/compras/${id}`, { token: maria })).status, 404);
    const antes = (await chamar("GET", "/faturas/1234-5678_2026-12", { token: joao })).dados.fatura;
    assert.equal((await chamar("DELETE", `/compras/${id}`, { token: joao })).status, 204);
    const depois = (await chamar("GET", "/faturas/1234-5678_2026-12", { token: joao })).dados.fatura;
    assert.equal(depois.totalCompras, antes.totalCompras + 1500);
  });
});
