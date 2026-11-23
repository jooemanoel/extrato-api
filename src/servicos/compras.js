// Regras de criação, alteração e exclusão de compras, usadas pelas rotas /compras
// e pela fila de alterações feitas offline (POST /sincronizacao).
import { normalizar } from "../dominio/estabelecimento.js";
import { situacaoDaLoja } from "../dominio/lojas.js";
import { ErroHttp } from "../validacao.js";

async function contexto(repo) {
  return {
    lojas: await repo.listarLojas(),
    ignorados: new Set((await repo.listarIgnorados()).map((i) => i.estabelecimento)),
  };
}

/**
 * Compra digitada à mão. `dados`: { id?, faturaId, data, valor, descricao }.
 * Com `id` (gerado no aparelho), repetir o pedido devolve a mesma compra.
 * @returns { compra, lojas }
 */
export async function criarCompra(repo, u, dados) {
  const fatura = await repo.buscarFatura(u, dados.faturaId);
  if (!fatura) throw new ErroHttp(404, "Fatura não encontrada");
  const { lojas, ignorados } = await contexto(repo);

  const compra = {
    ...(dados.id ? { id: dados.id } : {}),
    cartaoId: fatura.cartaoId,
    faturaId: fatura.id,
    data: dados.data,
    valor: dados.valor,
    tipo: dados.valor < 0 ? "compra" : "estorno",
    memo: dados.descricao,
    fitid: null,
    estabelecimento: normalizar(dados.descricao),
    nomeEstabelecimento: dados.descricao,
    parcela: null,
    descricao: null,
    origem: "manual",
    criadoEm: new Date().toISOString(),
  };
  const criada = await repo.criarCompra(u, { ...compra, ...situacaoDaLoja(compra, lojas, ignorados) });
  if (!criada) throw new ErroHttp(404, "Fatura não encontrada");
  return { compra: criada, lojas };
}

/**
 * `campos`: { descricao?, lojaId?, data?, valor? } (já validados).
 *   descricao  apelido exibido no lugar do nome do estabelecimento (null apaga)
 *   lojaId     escolhe a loja à mão (o reconhecimento automático deixa de mexer nela);
 *              null devolve a compra ao reconhecimento automático
 *   data/valor só em compras manuais (as do OFX voltariam ao valor original na próxima importação)
 * @returns { compra, lojas }
 */
export async function alterarCompra(repo, u, id, campos) {
  const { lojas, ignorados } = await contexto(repo);
  if (campos.lojaId && !lojas.some((l) => l.id === campos.lojaId)) throw new ErroHttp(404, "Loja não encontrada");

  const alterada = await repo.alterarCompra(u, id, (atual) => {
    if ((campos.data !== undefined || campos.valor !== undefined) && atual.origem !== "manual") {
      throw new ErroHttp(400, "Data e valor só podem ser alterados em compras digitadas à mão");
    }
    const novos = {};
    if (campos.descricao !== undefined) novos.descricao = campos.descricao;
    if (campos.data !== undefined) novos.data = campos.data;
    if (campos.valor !== undefined) {
      novos.valor = campos.valor;
      novos.tipo = campos.valor < 0 ? "compra" : "estorno";
    }
    if (campos.lojaId !== undefined) {
      Object.assign(
        novos,
        campos.lojaId
          ? { lojaId: campos.lojaId, lojaManual: true, ignorado: false, pendente: false }
          : situacaoDaLoja({ ...atual, lojaManual: false }, lojas, ignorados)
      );
    }
    return novos;
  });
  if (!alterada) throw new ErroHttp(404, "Compra não encontrada");
  return { compra: alterada, lojas };
}

/** Uma compra do OFX apagada volta se o mesmo arquivo for importado de novo. */
export async function excluirCompra(repo, u, id) {
  if (!(await repo.excluirCompra(u, id))) throw new ErroHttp(404, "Compra não encontrada");
}
