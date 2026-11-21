// Importação de fatura OFX: o que o arquivo diz e o que muda no banco.
//
// Duas etapas, sem acesso ao banco (o repositório fornece os dados e grava o plano):
//   analisarArquivo  lê o OFX e o nome do arquivo: cartão, competência, situação, lançamentos com id
//   planejar         compara com o que já existe e decide o que criar, mover e remover
import { interpretarMemo } from "./estabelecimento.js";
import { situacaoDaLoja } from "./lojas.js";
import { idDoCartao, lerOfx } from "./ofx.js";
import { ErroHttp } from "../validacao.js";

const MESES = {
  JAN: 1, FEV: 2, FEB: 2, MAR: 3, ABR: 4, APR: 4, MAI: 5, MAY: 5, JUN: 6, JUL: 7,
  AGO: 8, AUG: 8, SET: 9, SEP: 9, OUT: 10, OCT: 10, NOV: 11, DEZ: 12, DEC: 12,
};

export const HISTORICO_IMPORTACOES = 20;

/** "2026-11" + 1 -> "2026-12" */
export function somarMes(competencia, meses) {
  const [ano, mes] = competencia.split("-").map(Number);
  const total = ano * 12 + (mes - 1) + meses;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * O BB nomeia os arquivos assim:
 *   OUROCARD_VISA_INFINITE-Nov_26.ofx            fatura fechada, vencimento em novembro/2026
 *   OUROCARD_VISA_INFINITE-Próxima_Fatura.ofx    fatura aberta
 * O navegador pode acrescentar " (1)" a downloads repetidos.
 */
export function lerNomeArquivo(nomeArquivo) {
  const base = String(nomeArquivo ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
  const mes = base.match(/^(.*?)[-_ ]+([A-Za-z]{3})_(\d{2})$/);
  if (mes && MESES[mes[2].toUpperCase()]) {
    return {
      nomeCartao: nomeDoCartao(mes[1]),
      competencia: `20${mes[3]}-${String(MESES[mes[2].toUpperCase()]).padStart(2, "0")}`,
      aberta: false,
    };
  }
  const aberta = base.match(/^(.*?)[-_ ]+Pr.{1,3}xima[_ ]Fatura$/i);
  if (aberta) return { nomeCartao: nomeDoCartao(aberta[1]), competencia: null, aberta: true };
  return { nomeCartao: null, competencia: null, aberta: null };
}

function nomeDoCartao(trecho) {
  const nome = trecho.replace(/_/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  return /[A-Z]/.test(nome) ? nome.slice(0, 60) : null;
}

/** Pagamento da fatura anterior ("PGTO DEBITO CONTA ..."): crédito que não é compra nem estorno. */
const ehPagamento = (t) => t.valor > 0 && /^PGTO\b/i.test(t.memo.trim());

/**
 * Id da compra: o mesmo lançamento gera sempre o mesmo id, em qualquer exportação.
 *   {cartão}_{AAAAMMDD}_{valor}_{estabelecimento}_{parcela}_{ocorrência}
 *   1234-5678_20261106_-550_BRBMOBILIDADEMETRO_0_2
 * Não usa o FITID: ele é a posição da linha no arquivo, e a fatura aberta e a fechada ordenam
 * as linhas de forma diferente. A ocorrência conta lançamentos idênticos no mesmo arquivo
 * (duas passagens de metrô no mesmo dia são duas compras).
 */
export function baseDoId({ cartaoId, data, valor, estabelecimento, parcela }) {
  const parc = parcela ? `${String(parcela.numero).padStart(2, "0")}${String(parcela.total).padStart(2, "0")}` : "0";
  return `${cartaoId}_${data.replaceAll("-", "")}_${valor}_${estabelecimento || "SEMNOME"}_${parc}`;
}

export function atribuirIds(lancamentos) {
  const contagem = new Map();
  return lancamentos.map((l) => {
    const base = baseDoId(l);
    const n = (contagem.get(base) ?? 0) + 1;
    contagem.set(base, n);
    return { ...l, id: `${base}_${n}` };
  });
}

/**
 * Competência = mês de vencimento da fatura ("AAAA-MM").
 * Ordem: a informada pelo usuário; a do nome do arquivo; senão o mês seguinte ao da compra
 * mais antiga que não é parcela (parcelas mantêm a data da compra original).
 */
function deduzirCompetencia(lancamentos) {
  const semParcela = lancamentos.filter((l) => !l.parcela);
  const datas = (semParcela.length ? semParcela : lancamentos).map((l) => l.data).sort();
  if (!datas.length) return null;
  return somarMes(datas[0].slice(0, 7), 1);
}

export function analisarArquivo({ conteudo, nomeArquivo, competencia = null }) {
  const ofx = lerOfx(conteudo);
  const nome = lerNomeArquivo(nomeArquivo);
  const cartaoId = idDoCartao(ofx.numeroCartao);

  const pagamentos = ofx.transacoes.filter(ehPagamento);
  const lancamentos = atribuirIds(
    ofx.transacoes
      .filter((t) => !ehPagamento(t))
      .map((t) => ({
        cartaoId,
        fitid: t.fitid,
        data: t.data,
        valor: t.valor,
        tipo: t.valor < 0 ? "compra" : "estorno",
        memo: t.memo,
        ...interpretarMemo(t.memo),
      }))
  );

  let origemCompetencia = "informada";
  if (!competencia && nome.competencia) {
    competencia = nome.competencia;
    origemCompetencia = "arquivo";
  }
  if (!competencia) {
    competencia = deduzirCompetencia(lancamentos);
    origemCompetencia = "datas";
  }
  if (!competencia) throw new ErroHttp(422, "Arquivo sem lançamentos: informe a competência (AAAA-MM)");

  // Fechada x aberta: o nome do arquivo decide; senão o saldo (LEDGERBAL é 0,00 na fatura aberta).
  const situacao = nome.aberta === true ? "aberta" : nome.aberta === false ? "fechada" : ofx.saldo ? "fechada" : "aberta";

  return {
    cartaoId,
    numeroCartao: ofx.numeroCartao,
    nomeCartao: nome.nomeCartao,
    competencia,
    origemCompetencia,
    situacao,
    saldo: ofx.saldo,
    lancamentos,
    pagamentos: pagamentos.map((p) => ({ data: p.data, valor: p.valor, memo: p.memo.trim() })),
  };
}

export const idDaFatura = (cartaoId, competencia) => `${cartaoId}_${competencia}`;

/** Chaves que o repositório precisa ler antes de planejar. */
export function chavesDaImportacao(analise) {
  return {
    cartaoId: analise.cartaoId,
    faturaId: idDaFatura(analise.cartaoId, analise.competencia),
    faturaAnteriorId: idDaFatura(analise.cartaoId, somarMes(analise.competencia, -1)),
    compraIds: analise.lancamentos.map((l) => l.id),
  };
}

/** Totais e período de um conjunto de compras da fatura. */
export function resumirCompras(compras) {
  const semParcela = compras.filter((c) => !c.parcela);
  const datas = (semParcela.length ? semParcela : compras).map((c) => c.data).sort();
  return {
    totalCompras: compras.reduce((s, c) => s + c.valor, 0),
    quantidade: compras.length,
    inicio: datas[0] ?? null,
    fim: datas[datas.length - 1] ?? null,
  };
}

const resumoCompra = (c) => ({
  id: c.id,
  data: c.data,
  valor: c.valor,
  nomeEstabelecimento: c.nomeEstabelecimento,
  parcela: c.parcela,
  faturaId: c.faturaId,
});

/**
 * Decide o que a importação faz. Entrada:
 *   analise         resultado de analisarArquivo
 *   cartao, fatura, faturaAnterior   documentos atuais (ou null)
 *   existentes      Map(id -> compra) das compras do arquivo que já estão no banco
 *   daFatura        compras que hoje estão nesta fatura
 *   lojas, ignorados (Set de estabelecimentos), agora (ISO), removerAusentes
 * Saída: { resumo, escritas }.
 *
 * Regras:
 *   - Compra nova é criada; compra que já existe não é tocada (preserva descrição e loja escolhidas).
 *   - A fatura fechada é a palavra final do banco: compra que já existe em outra fatura
 *     do mesmo cartão é movida para esta. Na importação da fatura aberta, fica onde está.
 *   - Compras desta fatura que vieram de OFX e não estão no arquivo são "ausentes"
 *     (ex.: estorno que sumiu entre a fatura aberta e a fechada). Só são removidas com removerAusentes.
 *   - O arquivo da fatura aberta é recusado se a fatura já foi importada fechada.
 *   - "PGTO DEBITO CONTA" vira o pagamento da fatura anterior.
 */
export function planejar({ analise, cartao, fatura, faturaAnterior, existentes, daFatura, lojas, ignorados, agora, removerAusentes = false, nomeArquivo = "" }) {
  const faturaId = idDaFatura(analise.cartaoId, analise.competencia);

  if (fatura?.situacao === "fechada" && analise.situacao === "aberta") {
    throw new ErroHttp(409, "Esta fatura já foi importada fechada. O arquivo da fatura aberta não traz nada novo para ela.");
  }
  const situacao = fatura?.situacao === "fechada" ? "fechada" : analise.situacao;

  const criar = [];
  const mover = [];
  const outraFatura = [];
  let jaExistentes = 0;

  for (const l of analise.lancamentos) {
    const atual = existentes.get(l.id);
    if (!atual) {
      const compra = {
        id: l.id,
        cartaoId: l.cartaoId,
        faturaId,
        data: l.data,
        valor: l.valor,
        tipo: l.tipo,
        memo: l.memo,
        fitid: l.fitid,
        estabelecimento: l.estabelecimento,
        nomeEstabelecimento: l.nomeEstabelecimento,
        parcela: l.parcela,
        descricao: null,
        origem: "ofx",
        criadoEm: agora,
      };
      criar.push({ ...compra, ...situacaoDaLoja(compra, lojas, ignorados) });
    } else if (atual.faturaId === faturaId) {
      jaExistentes++;
    } else if (situacao === "fechada") {
      mover.push({ id: atual.id, deFaturaId: atual.faturaId, valor: atual.valor, compra: { ...atual, faturaId } });
    } else {
      outraFatura.push(resumoCompra(atual));
    }
  }

  const idsDoArquivo = new Set(analise.lancamentos.map((l) => l.id));
  const ausentes = daFatura.filter((c) => c.origem === "ofx" && !idsDoArquivo.has(c.id));
  const remover = removerAusentes ? ausentes : [];
  const removidos = new Set(remover.map((c) => c.id));

  const finais = [
    ...daFatura.filter((c) => !removidos.has(c.id)),
    ...mover.map((m) => m.compra),
    ...criar,
  ];
  const totais = resumirCompras(finais);

  // Pagamento da fatura anterior
  let pagamento = null;
  if (analise.pagamentos.length) {
    pagamento = {
      data: analise.pagamentos.map((p) => p.data).sort().at(-1),
      valor: analise.pagamentos.reduce((s, p) => s + p.valor, 0),
    };
  }
  const faturaAnteriorId = idDaFatura(analise.cartaoId, somarMes(analise.competencia, -1));

  const totalBanco = analise.situacao === "fechada" ? analise.saldo : fatura?.totalBanco ?? null;
  const conferencia =
    situacao === "fechada" && totalBanco != null
      ? { totalBanco, totalCompras: totais.totalCompras, confere: totalBanco === totais.totalCompras, diferenca: totais.totalCompras - totalBanco }
      : null;

  const importacao = {
    em: agora,
    arquivo: nomeArquivo,
    situacao: analise.situacao,
    novas: criar.length,
    existentes: jaExistentes,
    movidas: mover.length,
    ausentes: ausentes.length,
    removidas: remover.length,
  };

  const novaFatura = {
    id: faturaId,
    cartaoId: analise.cartaoId,
    competencia: analise.competencia,
    situacao,
    totalBanco,
    ...totais,
    pagamento: fatura?.pagamento ?? null,
    importacoes: [...(fatura?.importacoes ?? []), importacao].slice(-HISTORICO_IMPORTACOES),
    criadoEm: fatura?.criadoEm ?? agora,
    atualizadoEm: agora,
  };

  // Cartão: criado na primeira importação; o nome vem do arquivo, se o atual ainda for o genérico.
  const nomeGenerico = `CARTÃO FINAL ${analise.cartaoId.slice(-4)}`;
  let novoCartao = null;
  if (!cartao) {
    novoCartao = { id: analise.cartaoId, nome: analise.nomeCartao ?? nomeGenerico, numero: analise.numeroCartao, criadoEm: agora };
  } else if (cartao.nome === nomeGenerico && analise.nomeCartao) {
    novoCartao = { ...cartao, nome: analise.nomeCartao };
  }

  return {
    resumo: {
      cartao: { id: analise.cartaoId, nome: novoCartao?.nome ?? cartao.nome, novo: !cartao },
      fatura: {
        id: faturaId,
        competencia: analise.competencia,
        origemCompetencia: analise.origemCompetencia,
        situacao,
        nova: !fatura,
        ...totais,
      },
      lancamentos: analise.lancamentos.length,
      novas: criar.map(resumoCompra),
      existentes: jaExistentes,
      movidas: mover.map((m) => ({ ...resumoCompra(m.compra), deFaturaId: m.deFaturaId })),
      emOutraFatura: outraFatura,
      ausentes: ausentes.map(resumoCompra),
      removidas: remover.length,
      pagamento: pagamento
        ? { ...pagamento, faturaId: faturaAnteriorId, aplicado: Boolean(faturaAnterior) }
        : null,
      conferencia,
    },
    escritas: {
      cartao: novoCartao,
      fatura: novaFatura,
      criar,
      mover: mover.map(({ id, deFaturaId, valor }) => ({ id, deFaturaId, valor, faturaId })),
      remover: remover.map((c) => ({ id: c.id, valor: c.valor })),
      pagamento: pagamento && faturaAnterior ? { faturaId: faturaAnteriorId, pagamento } : null,
    },
  };
}
