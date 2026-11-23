// Sincronização com o aparelho (modo offline).
//
// O aparelho guarda cartões, faturas, compras e lojas e só pergunta o que mudou:
//
//   GET /sincronizacao?desde=<agora da resposta anterior>
//     { agora, completa, cartoes, faturas, compras, lojas, exclusoes, categorias, token? }
//     Sem "desde", vem tudo (completa: true): o aparelho troca o que tinha pelo que chegou.
//     Com "desde", só o que foi gravado depois, e as exclusões [{ tipo, id, em }]
//     (tipo "fatura" apaga também as compras dela). O aparelho guarda "agora" para a próxima vez.
//     "token" vem quando o atual vence em menos de 15 dias: quem usa o app não fica
//     trancado do lado de fora (offline, sem poder entrar de novo) quando o login vence.
//
//   POST /sincronizacao  { operacoes: [...] }
//     As alterações de compras feitas no aparelho (online ou offline), na ordem em que
//     aconteceram (ver validarOperacao). Repetir o envio não duplica nada: a compra criada
//     no aparelho traz o próprio id, e alterar ou excluir de novo dá no mesmo.
//     { resultados: [{ id, ok: true } | { id, ok: false, motivo }] }
//     Uma operação recusada (compra que já não existe, valor inválido...) não trava as outras.
import { Router } from "express";
import { emitirToken, exigirLogin } from "../autenticacao.js";
import { CATEGORIAS } from "../categorias.js";
import { alterarCompra, criarCompra, excluirCompra } from "../servicos/compras.js";
import { ErroHttp, validarDesde, validarLote, validarOperacao } from "../validacao.js";

// O horário de uma gravação é marcado um pouco antes de ela chegar ao banco. Pedir as
// mudanças com essa folga garante que nada gravado no meio de uma sincronização se perca;
// o que vier repetido o aparelho só grava de novo.
const FOLGA = 2 * 60_000;
const RENOVAR_TOKEN = 15 * 24 * 60 * 60_000;

export function rotasSincronizacao({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  router.get("/", async (req, res) => {
    const desde = validarDesde(req.query.desde);
    const agora = new Date().toISOString();
    const comFolga = desde ? new Date(Date.parse(desde) - FOLGA).toISOString() : null;
    const mudancas = await repo.mudancas(req.usuario.id, comFolga);

    const resposta = {
      agora,
      completa: !desde,
      ...mudancas,
      categorias: CATEGORIAS.map(({ id, nome, icone }) => ({ id, nome, icone })),
    };
    if (req.usuario.expiraEm - Date.now() < RENOVAR_TOKEN) {
      resposta.token = emitirToken(req.usuario, config);
    }
    res.json(resposta);
  });

  router.post("/", async (req, res) => {
    const u = req.usuario.id;
    const resultados = [];
    for (const bruta of validarLote(req.body)) {
      const id = typeof bruta?.id === "string" ? bruta.id : null;
      try {
        const op = validarOperacao(bruta);
        if (op.tipo === "criarCompra") {
          await criarCompra(repo, u, { id: op.compraId, faturaId: op.faturaId, data: op.data, valor: op.valor, descricao: op.descricao });
        } else if (op.tipo === "alterarCompra") {
          await alterarCompra(repo, u, op.compraId, op.campos);
        } else {
          // Excluir o que já não existe (excluída em outro aparelho, ou envio repetido) dá no mesmo.
          await excluirCompra(repo, u, op.compraId).catch((erro) => {
            if (erro.status !== 404) throw erro;
          });
        }
        resultados.push({ id, ok: true });
      } catch (erro) {
        // Erro do pedido (400/404/...): a operação é recusada e as outras seguem.
        // Erro do servidor ou do banco: para tudo, e o aparelho tenta de novo mais tarde.
        if (!(erro instanceof ErroHttp)) throw erro;
        resultados.push({ id, ok: false, motivo: erro.message });
      }
    }
    res.json({ resultados });
  });

  return router;
}
