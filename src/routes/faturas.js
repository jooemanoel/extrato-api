// Cartões e faturas do usuário logado.
import { Router } from "express";
import { exigirLogin } from "../autenticacao.js";
import { apresentadorDeCompras } from "../servicos/apresentar.js";
import { ErroHttp, LIMITES, validarNome } from "../validacao.js";

export function rotasCartoes({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  router.get("/", async (req, res) => {
    res.json(await repo.listarCartoes(req.usuario.id));
  });

  router.patch("/:id", async (req, res) => {
    const nome = validarNome(req.body, LIMITES.nomeCartao);
    const cartao = await repo.alterarCartao(req.usuario.id, req.params.id, { nome });
    if (!cartao) throw new ErroHttp(404, "Cartão não encontrado");
    res.json(cartao);
  });

  return router;
}

export function rotasFaturas({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  router.get("/", async (req, res) => {
    res.json(await repo.listarFaturas(req.usuario.id));
  });

  /** A fatura com as compras (loja e categoria resolvidas), da mais recente para a mais antiga. */
  router.get("/:id", async (req, res) => {
    const u = req.usuario.id;
    const fatura = await repo.buscarFatura(u, req.params.id);
    if (!fatura) throw new ErroHttp(404, "Fatura não encontrada");
    const [compras, lojas] = await Promise.all([repo.listarComprasDaFatura(u, fatura.id), repo.listarLojas()]);
    res.json({ fatura, compras: compras.map(apresentadorDeCompras(lojas)) });
  });

  /** Apaga a fatura e as compras dela (para refazer uma importação do zero). */
  router.delete("/:id", async (req, res) => {
    if (!(await repo.excluirFatura(req.usuario.id, req.params.id))) throw new ErroHttp(404, "Fatura não encontrada");
    res.status(204).end();
  });

  return router;
}
