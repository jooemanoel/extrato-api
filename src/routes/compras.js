// Compras do usuário logado: criação manual, descrição, loja escolhida à mão e exclusão.
// As regras ficam em servicos/compras.js (também usadas pela fila offline, em /sincronizacao).
import { Router } from "express";
import { exigirLogin } from "../autenticacao.js";
import { apresentadorDeCompras } from "../servicos/apresentar.js";
import { alterarCompra, criarCompra, excluirCompra } from "../servicos/compras.js";
import { validarAlteracaoCompra, validarNovaCompra } from "../validacao.js";

export function rotasCompras({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  /** Compra digitada à mão (ex.: lançamento que só aparece no PDF). Valor em centavos, negativo = gasto. */
  router.post("/", async (req, res) => {
    const { compra, lojas } = await criarCompra(repo, req.usuario.id, validarNovaCompra(req.body));
    res.status(201).json(apresentadorDeCompras(lojas)(compra));
  });

  /** { descricao?, lojaId?, data?, valor? } — ver servicos/compras.js. */
  router.patch("/:id", async (req, res) => {
    const { compra, lojas } = await alterarCompra(repo, req.usuario.id, req.params.id, validarAlteracaoCompra(req.body));
    res.json(apresentadorDeCompras(lojas)(compra));
  });

  router.delete("/:id", async (req, res) => {
    await excluirCompra(repo, req.usuario.id, req.params.id);
    res.status(204).end();
  });

  return router;
}
