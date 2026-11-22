// Lojas: reconhecimento das compras por padrões e sugestão de lojas novas.
//
// Uma loja (compartilhada entre os usuários) tem um nome livre, uma categoria e uma lista de
// padrões. Cada padrão é comparado com o `estabelecimento` normalizado da compra:
//   prefixo  o estabelecimento começa com o texto          ("AMERICANAS" reconhece "AMERICANASF485BA")
//   contem   o estabelecimento contém o texto              ("99RIDE" reconhece "DL99RIDE" e "PG99L2L99RIDE")
// Vence o padrão mais longo; empatados, o prefixo vence o "contém".
// Em parcelas o nome vem cortado em 13 colunas ("ENCANTOCOLCH"), então ali também vale o
// contrário: o padrão começar com o estabelecimento ("ENCANTOCOLCHOES").
import { normalizar, TAMANHO_MINIMO_PADRAO } from "./estabelecimento.js";

/** Pontuação de um padrão para uma compra (0 = não reconhece). */
function pontuar(padrao, { estabelecimento, parcela }) {
  if (padrao.tipo === "contem") {
    return estabelecimento.includes(padrao.texto) ? padrao.texto.length * 2 : 0;
  }
  if (estabelecimento.startsWith(padrao.texto)) return padrao.texto.length * 2 + 1;
  if (parcela && estabelecimento.length >= TAMANHO_MINIMO_PADRAO.contem && padrao.texto.startsWith(estabelecimento)) {
    return estabelecimento.length * 2 + 1;
  }
  return 0;
}

/** Id da loja que reconhece a compra, ou null. `compra` precisa de { estabelecimento, parcela }. */
export function encontrarLoja(compra, lojas) {
  if (!compra.estabelecimento) return null;
  let melhor = null;
  for (const loja of lojas) {
    for (const padrao of loja.padroes) {
      const pontos = pontuar(padrao, compra);
      if (pontos > (melhor?.pontos ?? 0)) melhor = { id: loja.id, pontos };
    }
  }
  return melhor?.id ?? null;
}

/**
 * Situação de "loja" de uma compra: { lojaId, lojaManual, ignorado, pendente }.
 *   lojaManual  o usuário escolheu a loja à mão; o reconhecimento automático não troca
 *   ignorado    o estabelecimento está na lista de ignorados (compra avulsa, sem loja de propósito)
 *   pendente    sem loja e não ignorada: aparece nas sugestões
 */
export function situacaoDaLoja(compra, lojas, ignorados) {
  if (compra.lojaManual && lojas.some((l) => l.id === compra.lojaId)) {
    return { lojaId: compra.lojaId, lojaManual: true, ignorado: false, pendente: false };
  }
  const lojaId = encontrarLoja(compra, lojas);
  const ignorado = !lojaId && ignorados.has(compra.estabelecimento);
  return { lojaId, lojaManual: false, ignorado, pendente: !lojaId && !ignorado };
}

// ---------- Sugestões ----------

// Intermediadores de pagamento: o lojista vem depois do "*" ("MP*SABORDEMINAS").
const PROCESSADORES =
  /^(?:MP|MERCADOPAGO|PG|PAG|PAGSEGURO|ACQIO|SUMUP|EC|DL|DLOCAL|STONE|CIELO|PICPAY|SQ|EBN|HNA|PAYPAL)\s*\*\s*/i;
// Palavras que sobram no fim do nome e não fazem parte dele.
const RUIDO = new Set(["S", "A", "SA", "LTDA", "ME", "EIRELI", "EPP", "LJ", "LOJA", "FILIAL", "COM", "BR"]);

/**
 * Nome sugerido para uma loja nova, a partir do nome do estabelecimento:
 *   "AMERICANAS F485BA"      -> "AMERICANAS"         (palavra final com número é código de filial)
 *   "CIA DOS CALCADOS F25EA" -> "CIA DOS CALCADOS"
 *   "MP*SABORDEMINAS"        -> "SABORDEMINAS"       (tira o intermediador)
 *   "BrunaRoupas"            -> "BRUNA ROUPAS"       (separa palavras coladas)
 *   "RIACHUELO FILIAL037"    -> "RIACHUELO"
 * É só uma sugestão: o usuário corrige à vontade ("SABOR DE MINAS").
 */
export function sugerirNome(nomeEstabelecimento) {
  const texto = String(nomeEstabelecimento ?? "")
    .trim()
    .replace(PROCESSADORES, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  const palavras = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (palavras.length > 1) {
    const ultima = palavras[palavras.length - 1];
    if (!/\d/.test(ultima) && !RUIDO.has(ultima)) break;
    palavras.pop();
  }
  return palavras.join(" ") || String(nomeEstabelecimento ?? "").trim().toUpperCase();
}

/**
 * Padrão para uma loja nova, coerente com o nome escolhido pelo usuário:
 * se o estabelecimento começa com o nome ("AMERICANAS" em "AMERICANASF485BA"), o padrão é o nome,
 * e passa a reconhecer qualquer filial. Senão (o nome é um apelido, como "METRÔ" para
 * "BRB MOBILIDADE"), o padrão é o estabelecimento sem o código do fim, ou ele inteiro.
 */
export function sugerirPadrao(nome, estabelecimento, nomeEstabelecimento) {
  const candidatos = [normalizar(nome)];
  if (nomeEstabelecimento) candidatos.push(normalizar(sugerirNome(nomeEstabelecimento)));
  for (const c of candidatos) {
    if (c.length >= TAMANHO_MINIMO_PADRAO.prefixo && estabelecimento.startsWith(c)) return { tipo: "prefixo", texto: c };
  }
  return { tipo: "prefixo", texto: estabelecimento };
}

// Palavras-chave para sugerir a categoria (comparadas com o estabelecimento normalizado).
const PALAVRAS_CATEGORIA = [
  ["saude", ["DROGA", "FARMA", "LABORAT", "CLINICA", "HOSPITAL", "ODONTO", "EXAME", "SAUDE", "GYM", "ACADEMIA", "WELLHUB"]],
  ["mercado", ["SUPERMERC", "MERCADO", "MERCADINHO", "ATACAD", "ATACAREJO", "HORTI", "PADARIA", "PANIFIC", "PAES", "ACOUGUE", "FRUTAS", "EMPORIO", "FRANGO"]],
  ["transporte", ["POSTO", "PETROLEO", "COMBUST", "UBER", "99RIDE", "99APP", "METRO", "MOBILIDADE", "ESTACIONAMENTO", "LOCALIZA", "LATAM", "GOLLINHAS", "AZUL"]],
  ["restaurante", ["RESTAURANTE", "LANCH", "PIZZ", "HAMBURG", "BURGER", "SORVET", "CHOPP", "CAFE", "ESPET", "PASTEL", "CHURRASC", "IFD", "IFOOD"]],
  ["lazer", ["CINEMA", "INGRESSO"]],
  ["educacao", ["ESCOLA", "UNIVERS", "FACULDADE", "CURSO", "LIVRARIA", "COLEGIO"]],
  ["internet", ["NETFLIX", "SPOTIFY", "YOUTUBE", "PRIME", "DISNEY", "TIM", "CLARO", "VIVO", "GOOGLE", "APPLE", "CLAUDE"]],
  ["variedades", ["SHOPEE", "AMAZON", "MERCADOLIVRE", "MAGALU", "MAGAZINE", "AMERICANAS", "RIACHUELO", "RENNER", "CEA", "LOJAS", "SHEIN"]],
];

export function sugerirCategoria(estabelecimento) {
  for (const [categoria, palavras] of PALAVRAS_CATEGORIA) {
    if (palavras.some((p) => estabelecimento.includes(p))) return categoria;
  }
  return null;
}

const palavrasDoNome = (nome) =>
  new Set(
    String(nome)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((p) => p.length >= 4)
  );

/** Lojas com nome parecido (alguma palavra de 4+ letras em comum): "SORVETES PRESTIGIO" ~ "SORVETERIA PRESTIGIO". */
export function lojasParecidas(nome, lojas, limite = 3) {
  const minhas = palavrasDoNome(nome);
  if (minhas.size === 0) return [];
  return lojas
    .map((loja) => ({ loja, comuns: [...palavrasDoNome(loja.nome)].filter((p) => minhas.has(p)).length }))
    .filter((x) => x.comuns > 0)
    .sort((a, b) => b.comuns - a.comuns)
    .slice(0, limite)
    .map(({ loja }) => ({ id: loja.id, nome: loja.nome, categoria: loja.categoria }));
}

/**
 * Generalização por intermediador: "IFD*NOVO RESTAURANTE" sem loja, e a loja IFOOD já tem vários
 * padrões começando com "IFD" (e nenhuma outra loja tem). Sugere acrescentar o padrão "IFD" à IFOOD.
 * Não vale para intermediadores usados por lojas diferentes (MP*, PG*).
 */
function lojaDoIntermediador(nomeEstabelecimento, lojas) {
  const m = String(nomeEstabelecimento).match(/^([^*]+?)\s*\*/);
  if (!m) return null;
  const prefixo = normalizar(m[1]);
  if (prefixo.length < TAMANHO_MINIMO_PADRAO.prefixo) return null;
  const donas = lojas.filter((l) => l.padroes.some((p) => p.tipo === "prefixo" && p.texto.startsWith(prefixo)));
  if (donas.length !== 1) return null;
  const usos = donas[0].padroes.filter((p) => p.tipo === "prefixo" && p.texto.startsWith(prefixo)).length;
  return usos >= 2 ? { loja: donas[0], padrao: { tipo: "prefixo", texto: prefixo } } : null;
}

/**
 * Agrupa as compras pendentes (sem loja e não ignoradas) em sugestões:
 *   { tipo: "nova", nome, padrao, categoria, parecidas, ... }
 *   { tipo: "adicionar", lojaId, nome, padrao, ... }   o padrão entra numa loja que já existe
 * Cada sugestão traz quantidade, total (centavos), estabelecimentos e exemplos.
 */
export function agruparSugestoes(pendentes, lojas) {
  const porNome = new Map(lojas.map((l) => [normalizar(l.nome), l]));
  const grupos = new Map();

  for (const compra of pendentes) {
    let sugestao;
    const intermediador = lojaDoIntermediador(compra.nomeEstabelecimento, lojas);
    if (intermediador) {
      sugestao = { tipo: "adicionar", lojaId: intermediador.loja.id, nome: intermediador.loja.nome, categoria: intermediador.loja.categoria, padrao: intermediador.padrao };
    } else {
      const nome = sugerirNome(compra.nomeEstabelecimento);
      const padrao = sugerirPadrao(nome, compra.estabelecimento);
      const existente = porNome.get(normalizar(nome));
      sugestao = existente
        ? { tipo: "adicionar", lojaId: existente.id, nome: existente.nome, categoria: existente.categoria, padrao }
        : { tipo: "nova", nome, categoria: sugerirCategoria(compra.estabelecimento), padrao };
    }

    const chave = `${sugestao.tipo}:${sugestao.lojaId ?? ""}:${sugestao.padrao.texto}`;
    if (!grupos.has(chave)) {
      grupos.set(chave, { ...sugestao, quantidade: 0, total: 0, estabelecimentos: new Set(), exemplos: new Set() });
    }
    const grupo = grupos.get(chave);
    grupo.quantidade++;
    grupo.total += compra.valor;
    grupo.estabelecimentos.add(compra.estabelecimento);
    grupo.exemplos.add(compra.nomeEstabelecimento);
  }

  return [...grupos.values()]
    .map((g) => ({
      ...g,
      estabelecimentos: [...g.estabelecimentos],
      exemplos: [...g.exemplos].slice(0, 5),
      parecidas: g.tipo === "nova" ? lojasParecidas(g.nome, lojas) : [],
    }))
    .sort((a, b) => b.quantidade - a.quantidade || Math.abs(b.total) - Math.abs(a.total));
}

/**
 * Conflitos de padrões: um padrão idêntico (mesmo tipo e texto) não pode estar em duas lojas.
 * Devolve [{ padrao, loja }] para os padrões de `padroes` que já pertencem a outra loja.
 */
export function padroesEmConflito(padroes, lojas, lojaIdAtual = null) {
  const conflitos = [];
  for (const p of padroes) {
    const dona = lojas.find((l) => l.id !== lojaIdAtual && l.padroes.some((q) => q.tipo === p.tipo && q.texto === p.texto));
    if (dona) conflitos.push({ padrao: p, loja: { id: dona.id, nome: dona.nome } });
  }
  return conflitos;
}
