// Mantém as compras coerentes com as lojas.
//
// A loja de cada compra fica gravada nela (lojaId), para listar e somar sem recalcular.
// Quando lojas, padrões ou ignorados mudam, só as compras que podem ser afetadas são relidas:
//   padrão "prefixo" novo/alterado  compras cujo estabelecimento começa com ele (consulta por intervalo)
//                                   + parcelas cujo nome cortado é o começo dele
//   padrão "contem"                 compras pendentes (sem loja). Ele não tira compras de outras lojas
//                                   que já existiam; nas importações seguintes, vale o padrão mais longo.
//   loja alterada/excluída          compras daquela loja
//   estabelecimento (des)ignorado   compras daquele estabelecimento
// As lojas são compartilhadas, então isso roda para todos os usuários.
import { situacaoDaLoja } from "../dominio/lojas.js";
import { TAMANHO_MINIMO_PADRAO } from "../dominio/estabelecimento.js";

const CAMPOS = ["lojaId", "lojaManual", "ignorado", "pendente"];

/** Prefixos de um padrão que podem ser o nome cortado (13 colunas) de uma parcela. */
function prefixosDeParcela(texto) {
  const lista = [];
  for (let n = TAMANHO_MINIMO_PADRAO.contem; n < texto.length && n <= 13; n++) lista.push(texto.slice(0, n));
  return lista;
}

/**
 * Compras de um usuário que um conjunto de mudanças pode afetar.
 * alvo: { padroes?: [{tipo, texto}], lojaIds?: [], estabelecimentos?: [], pendentes?: bool, redirecionar?: { de, para } }
 */
export async function coletarCandidatas(repo, usuarioId, alvo) {
  const { padroes = [], lojaIds = [], estabelecimentos = [], redirecionar = null } = alvo;
  const pendentes = alvo.pendentes || padroes.some((p) => p.tipo === "contem");
  const candidatas = new Map();
  const juntar = (lista) => lista.forEach((c) => candidatas.set(c.id, c));

  for (const p of padroes.filter((p) => p.tipo === "prefixo")) {
    juntar(await repo.comprasPorPrefixo(usuarioId, p.texto));
    const cortados = prefixosDeParcela(p.texto);
    if (cortados.length) juntar((await repo.comprasPorEstabelecimentos(usuarioId, cortados)).filter((c) => c.parcela));
  }
  if (pendentes) juntar(await repo.comprasPendentes(usuarioId));
  for (const id of lojaIds) juntar(await repo.comprasPorLoja(usuarioId, id));
  if (redirecionar) juntar(await repo.comprasPorLoja(usuarioId, redirecionar.de));
  if (estabelecimentos.length) juntar(await repo.comprasPorEstabelecimentos(usuarioId, estabelecimentos));
  return [...candidatas.values()];
}

/**
 * Recalcula a loja das compras afetadas, em todos os usuários.
 * `alvo` como em coletarCandidatas; `redirecionar` (ao juntar lojas) passa as escolhas manuais
 * da loja que some para a loja que fica.
 * @returns número de compras alteradas
 */
export async function reprocessar(repo, alvo) {
  const { redirecionar = null } = alvo;
  const lojas = await repo.listarLojas();
  const ignorados = new Set((await repo.listarIgnorados()).map((i) => i.estabelecimento));
  let alteradas = 0;

  for (const usuarioId of await repo.listarUsuarioIds()) {
    const mudancas = [];
    for (let compra of await coletarCandidatas(repo, usuarioId, alvo)) {
      if (redirecionar && compra.lojaManual && compra.lojaId === redirecionar.de) {
        compra = { ...compra, lojaId: redirecionar.para, alterada: true };
      }
      const nova = situacaoDaLoja(compra, lojas, ignorados);
      if (compra.alterada || CAMPOS.some((c) => (compra[c] ?? null) !== (nova[c] ?? null))) {
        mudancas.push({ id: compra.id, ...nova });
      }
    }
    if (mudancas.length) await repo.atualizarCompras(usuarioId, mudancas);
    alteradas += mudancas.length;
  }
  return alteradas;
}
