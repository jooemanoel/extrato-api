// Compras do usuário logado: criação manual, descrição, loja escolhida à mão e exclusão.
import { Router } from "express";
import { exigirLogin } from "../autenticacao.js";
import { normalizar } from "../dominio/estabelecimento.js";
import { situacaoDaLoja } from "../dominio/lojas.js";
import { apresentadorDeCompras } from "../servicos/apresentar.js";
import { ErroHttp, validarAlteracaoCompra, validarNovaCompra } from "../validacao.js";

export function rotasCompras({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  const contexto = async () => ({
    lojas: await repo.listarLojas(),
    ignorados: new Set((await repo.listarIgnorados()).map((i) => i.estabelecimento)),
  });

  /** Compra digitada à mão (ex.: lançamento que só aparece no PDF). Valor em centavos, negativo = gasto. */
  router.post("/", async (req, res) => {
    const u = req.usuario.id;
    const dados = validarNovaCompra(req.body);
    const fatura = await repo.buscarFatura(u, dados.faturaId);
    if (!fatura) throw new ErroHttp(404, "Fatura não encontrada");
    const { lojas, ignorados } = await contexto();

    const compra = {
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
    res.status(201).json(apresentadorDeCompras(lojas)(criada));
  });

  /**
   * { descricao?, lojaId?, data?, valor? }
   *   descricao  apelido exibido no lugar do nome do estabelecimento (null apaga)
   *   lojaId     escolhe a loja à mão (o reconhecimento automático deixa de mexer nela);
   *              null devolve a compra ao reconhecimento automático
   *   data/valor só em compras manuais (as do OFX voltariam ao valor original na próxima importação)
   */
  router.patch("/:id", async (req, res) => {
    const u = req.usuario.id;
    const campos = validarAlteracaoCompra(req.body);
    const { lojas, ignorados } = await contexto();
    if (campos.lojaId && !lojas.some((l) => l.id === campos.lojaId)) throw new ErroHttp(404, "Loja não encontrada");

    const alterada = await repo.alterarCompra(u, req.params.id, (atual) => {
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
    res.json(apresentadorDeCompras(lojas)(alterada));
  });

  /** Uma compra do OFX apagada volta se o mesmo arquivo for importado de novo. */
  router.delete("/:id", async (req, res) => {
    if (!(await repo.excluirCompra(req.usuario.id, req.params.id))) throw new ErroHttp(404, "Compra não encontrada");
    res.status(204).end();
  });

  return router;
}
