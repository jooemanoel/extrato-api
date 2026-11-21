// Testes das regras de negócio puras (sem HTTP e sem banco).
// Rodar: npm test
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { interpretarMemo, normalizar } from "../src/dominio/estabelecimento.js";
import { analisarArquivo, lerNomeArquivo, somarMes } from "../src/dominio/importacao.js";
import { lerOfx } from "../src/dominio/ofx.js";
import { agruparSugestoes, encontrarLoja, lojasParecidas, sugerirCategoria, sugerirNome, sugerirPadrao } from "../src/dominio/lojas.js";
import { gerarOfx, saldoDe } from "./ofx-sintetico.js";

describe("MEMO do Banco do Brasil", () => {
  test("fatura fechada: estabelecimento nas 23 primeiras colunas", () => {
    const m = interpretarMemo("BRB MOBILIDADE  METRO  BRASILIA      BR");
    assert.equal(m.estabelecimento, "BRBMOBILIDADEMETRO");
    assert.equal(m.nomeEstabelecimento, "BRB MOBILIDADE METRO");
    assert.equal(m.parcela, null);
  });

  test("fatura aberta (MEMO aparado) dá o mesmo estabelecimento", () => {
    assert.equal(
      interpretarMemo("BRB MOBILIDADE  METRO  BRASILIA").estabelecimento,
      interpretarMemo("BRB MOBILIDADE  METRO  BRASILIA      BR").estabelecimento
    );
  });

  test("parcela: nome em 13 colunas e número da parcela", () => {
    const m = interpretarMemo("EC *EBAZARCOM PARC 03/06 CAJAMAR     BR");
    assert.equal(m.estabelecimento, "ECEBAZARCOM");
    assert.deepEqual(m.parcela, { numero: 3, total: 6 });
  });

  test("normalizar tira acentos, espaços e símbolos", () => {
    assert.equal(normalizar("Assaí  Atacadista*"), "ASSAIATACADISTA");
  });
});

describe("leitura do OFX", () => {
  test("cartão, saldo e transações em centavos", () => {
    const ofx = lerOfx(gerarOfx({ saldo: "-19.50", linhas: [["20261029", "-9.75", "CANTINA"], ["20261029", "-9.75", "CANTINA"]] }));
    assert.equal(ofx.numeroCartao, "1234000000005678");
    assert.equal(ofx.saldo, -1950);
    assert.deepEqual(ofx.transacoes.map((t) => [t.data, t.valor]), [["2026-10-29", -975], ["2026-10-29", -975]]);
  });

  test("saldo -0.00 vira 0", () => {
    assert.equal(lerOfx(gerarOfx({ saldo: "-0.00" })).saldo, 0);
  });

  test("recusa extrato de conta corrente e arquivo que não é OFX", () => {
    assert.throws(() => lerOfx("<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>"), /conta corrente/);
    assert.throws(() => lerOfx("isto não é um ofx"), /não parece ser um OFX/);
  });
});

describe("nome do arquivo e competência", () => {
  test("fatura fechada traz cartão e mês de vencimento", () => {
    assert.deepEqual(lerNomeArquivo("OUROCARD_VISA_INFINITE-Nov_26.ofx"), {
      nomeCartao: "OUROCARD VISA INFINITE",
      competencia: "2026-11",
      aberta: false,
    });
    assert.equal(lerNomeArquivo("OUROCARD_ELO_NANQUIM-Dez_26 (1).ofx").competencia, "2026-12");
  });

  test("fatura aberta", () => {
    const r = lerNomeArquivo("OUROCARD_VISA_INFINITE-Próxima_Fatura.ofx");
    assert.equal(r.aberta, true);
    assert.equal(r.nomeCartao, "OUROCARD VISA INFINITE");
  });

  test("somarMes atravessa o ano", () => {
    assert.equal(somarMes("2026-12", 1), "2027-01");
    assert.equal(somarMes("2027-01", -1), "2026-12");
  });

  test("sem mês no nome: mês seguinte à compra mais antiga que não é parcela", () => {
    const conteudo = gerarOfx({
      aberta: true,
      linhas: [
        ["20250806", "-120.00", "EC *EBAZARCOM", { parcela: "05/06" }],
        ["20261111", "-42.70", "FRANGOLAR"],
        ["20261118", "-5.50", "BRB MOBILIDADE PMS"],
      ],
    });
    const a = analisarArquivo({ conteudo, nomeArquivo: "fatura.ofx" });
    assert.equal(a.competencia, "2026-12");
    assert.equal(a.origemCompetencia, "datas");
    assert.equal(a.situacao, "aberta"); // saldo 0,00
  });
});

describe("id das compras", () => {
  test("lançamentos idênticos no mesmo dia recebem ocorrências diferentes", () => {
    const linhas = [["20261106", "-5.50", "BRB MOBILIDADE  METRO"], ["20261106", "-5.50", "BRB MOBILIDADE  METRO"]];
    const a = analisarArquivo({ conteudo: gerarOfx({ saldo: saldoDe(linhas), linhas }), nomeArquivo: "X-Nov_26.ofx" });
    assert.deepEqual(a.lancamentos.map((l) => l.id), [
      "1234-5678_20261106_-550_BRBMOBILIDADEMETRO_0_1",
      "1234-5678_20261106_-550_BRBMOBILIDADEMETRO_0_2",
    ]);
  });

  test("o id não depende do FITID nem do formato do MEMO (aberta x fechada)", () => {
    const linhas = [["20261111", "-42.70", "FRANGOLAR"], ["20261112", "-110.00", "CAPITAL GAS"]];
    const aberta = analisarArquivo({ conteudo: gerarOfx({ aberta: true, linhas }), nomeArquivo: "X-Próxima_Fatura.ofx", competencia: "2026-12" });
    // na fechada as linhas vêm em outra ordem (FITIDs diferentes) e com o país no MEMO
    const fechada = analisarArquivo({ conteudo: gerarOfx({ saldo: saldoDe(linhas), linhas: [...linhas].reverse() }), nomeArquivo: "X-Dez_26.ofx" });
    assert.deepEqual(aberta.lancamentos.map((l) => l.id).sort(), fechada.lancamentos.map((l) => l.id).sort());
    assert.notDeepEqual(aberta.lancamentos.map((l) => l.fitid).sort(), fechada.lancamentos.map((l) => l.fitid).sort());
  });

  test("parcelas da mesma compra têm ids diferentes; PGTO não é compra", () => {
    const linhas = [
      ["20261021", "2000.00", "PGTO DEBITO CONTA 0000 000000000  000000"],
      ["20250714", "-150.00", "GOL LINHAS A*", { parcela: "03/04" }],
      ["20261014", "18.90", "SHOPEE *LOJAEXEMPLO"],
    ];
    const a = analisarArquivo({ conteudo: gerarOfx({ saldo: saldoDe(linhas), linhas }), nomeArquivo: "X-Nov_26.ofx" });
    assert.equal(a.lancamentos.length, 2);
    assert.equal(a.pagamentos[0].valor, 200000);
    assert.match(a.lancamentos[0].id, /_0304_1$/);
    assert.equal(a.lancamentos[1].tipo, "estorno");
  });
});

describe("reconhecimento de lojas", () => {
  const lojas = [
    { id: "americanas", nome: "AMERICANAS", padroes: [{ tipo: "prefixo", texto: "AMERICANAS" }] },
    { id: "lojasam", nome: "LOJAS AMERICANAS", padroes: [{ tipo: "prefixo", texto: "AMERICANASSA" }] },
    { id: "99", nome: "99", padroes: [{ tipo: "prefixo", texto: "99" }, { tipo: "contem", texto: "99RIDE" }] },
    { id: "colchoes", nome: "ENCANTO COLCHÕES", padroes: [{ tipo: "prefixo", texto: "ENCANTOCOLCHOES" }] },
  ];
  const compra = (memo) => interpretarMemo(memo);

  test("prefixo reconhece qualquer filial", () => {
    assert.equal(encontrarLoja(compra("AMERICANAS F485BA      BRASILIA      BR"), lojas), "americanas");
  });

  test("vence o padrão mais longo", () => {
    assert.equal(encontrarLoja(compra("AMERICANAS SA          BRASILIA      BR"), lojas), "lojasam");
  });

  test("contém: intermediadores diferentes, mesma loja", () => {
    assert.equal(encontrarLoja(compra("DL*99 RIDE             SAO PAULO     BR"), lojas), "99");
    assert.equal(encontrarLoja(compra("PG *99 L2L 99 RIDE     SAO PAULO     BR"), lojas), "99");
  });

  test("parcela com nome cortado em 13 colunas", () => {
    assert.equal(encontrarLoja(compra("ENCANTO COLCH PARC 02/10 BRASILIA    BR"), lojas), "colchoes");
    // fora de parcela, o nome cortado não basta
    assert.equal(encontrarLoja(compra("ENCANTO COLCH          BRASILIA      BR"), lojas), null);
  });
});

describe("sugestões de loja", () => {
  test("nomes sugeridos", () => {
    assert.equal(sugerirNome("AMERICANAS F485BA"), "AMERICANAS");
    assert.equal(sugerirNome("CIA DOS CALCADOS F25EA"), "CIA DOS CALCADOS");
    assert.equal(sugerirNome("MP*SABORDEMINAS"), "SABORDEMINAS");
    assert.equal(sugerirNome("BrunaRoupas"), "BRUNA ROUPAS");
    assert.equal(sugerirNome("RIACHUELO FILIAL037"), "RIACHUELO");
    assert.equal(sugerirNome("ASSAI ATACADISTA  LJ10"), "ASSAI ATACADISTA");
  });

  test("o padrão segue o nome corrigido pelo usuário quando ele é o começo do estabelecimento", () => {
    assert.deepEqual(sugerirPadrao("AMERICANAS", "AMERICANASF485BA"), { tipo: "prefixo", texto: "AMERICANAS" });
    assert.deepEqual(sugerirPadrao("CIA DOS CALÇADOS", "CIADOSCALCADOSF25EA"), { tipo: "prefixo", texto: "CIADOSCALCADOS" });
    // apelido que não está no estabelecimento: usa o estabelecimento sem o código do fim
    assert.deepEqual(sugerirPadrao("METRÔ", "BRBMOBILIDADEMETRO", "BRB MOBILIDADE METRO"), { tipo: "prefixo", texto: "BRBMOBILIDADEMETRO" });
    assert.deepEqual(sugerirPadrao("LOJA DO ZÉ", "RIACHUELO093", "RIACHUELO 093"), { tipo: "prefixo", texto: "RIACHUELO" });
  });

  test("categoria por palavra-chave e lojas parecidas", () => {
    assert.equal(sugerirCategoria("DROGASIL3981"), "saude");
    assert.equal(sugerirCategoria("PRIMORSUPERMERCADO"), "mercado");
    assert.equal(sugerirCategoria("XPTO"), null);
    const parecidas = lojasParecidas("SORVETES PRESTIGIO", [{ id: "1", nome: "SORVETERIA PRESTIGIO", categoria: "lazer", padroes: [] }]);
    assert.deepEqual(parecidas.map((l) => l.id), ["1"]);
  });

  test("agrupa filiais e generaliza intermediador de uma loja só (IFD* -> IFOOD)", () => {
    const lojas = [
      {
        id: "ifood",
        nome: "IFOOD",
        categoria: "lazer",
        padroes: [{ tipo: "prefixo", texto: "IFDUNIAOGVCOMERCIO" }, { tipo: "prefixo", texto: "IFDBUENOEPEIXOTOPIZ" }],
      },
    ];
    const pendente = (memo, valor = -1000) => ({ ...interpretarMemo(memo), valor });
    const sugestoes = agruparSugestoes(
      [
        pendente("RIACHUELO 093          BRASILIA      BR"),
        pendente("RIACHUELO FILIAL037    BRASILIA      BR"),
        pendente("IFD*NOVO RESTAURANTE   BRASILIA      BR"),
      ],
      lojas
    );
    const riachuelo = sugestoes.find((s) => s.nome === "RIACHUELO");
    assert.equal(riachuelo.tipo, "nova");
    assert.equal(riachuelo.quantidade, 2);
    assert.deepEqual(riachuelo.padrao, { tipo: "prefixo", texto: "RIACHUELO" });
    assert.equal(riachuelo.categoria, "variedades");

    const ifood = sugestoes.find((s) => s.lojaId === "ifood");
    assert.equal(ifood.tipo, "adicionar");
    assert.deepEqual(ifood.padrao, { tipo: "prefixo", texto: "IFD" });
  });
});
