// Lojas (compartilhadas entre todos os usuários) e estabelecimentos ignorados.
//
// Fluxo pensado para o front-end:
//   1. GET  /lojas/sugestoes      compras sem loja agrupadas, com nome, padrão e categoria sugeridos
//   2. O usuário corrige o nome ("AMERICANAS F485BA" -> "AMERICANAS") e, se quiser, o padrão
//   3. POST /lojas/previa         mostra o que o padrão vai reconhecer, e de quais lojas tiraria compras
//   4. POST /lojas                cria; ou PATCH /lojas/:id para acrescentar o padrão a uma loja existente
// Toda mudança de loja ou padrão recalcula a loja das compras afetadas (servicos/reprocessar.js).
import { Router } from "express";
import { exigirLogin } from "../autenticacao.js";
import { normalizar } from "../dominio/estabelecimento.js";
import { agruparSugestoes, encontrarLoja, padroesEmConflito, sugerirPadrao } from "../dominio/lojas.js";
import { coletarCandidatas, reprocessar } from "../servicos/reprocessar.js";
import { CATEGORIAS } from "../categorias.js";
import {
  ErroHttp,
  validarAlteracaoLoja,
  validarEstabelecimento,
  validarNovaLoja,
  validarPadroes,
} from "../validacao.js";

const unirPadroes = (...listas) => {
  const vistos = new Set();
  return listas.flat().filter((p) => {
    const chave = `${p.tipo}:${p.texto}`;
    return !vistos.has(chave) && vistos.add(chave);
  });
};

function exigirSemConflito(padroes, lojas, lojaIdAtual) {
  const conflitos = padroesEmConflito(padroes, lojas, lojaIdAtual);
  if (conflitos.length) {
    const { padrao, loja } = conflitos[0];
    throw new ErroHttp(409, `O padrão "${padrao.texto}" já pertence à loja ${loja.nome}`, { conflitos });
  }
}

export function rotasLojas({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  router.get("/", async (req, res) => {
    res.json(await repo.listarLojas());
  });

  /** Compras do usuário sem loja (e não ignoradas), agrupadas em sugestões. */
  router.get("/sugestoes", async (req, res) => {
    const [pendentes, lojas] = await Promise.all([repo.comprasPendentes(req.usuario.id), repo.listarLojas()]);
    res.json(agruparSugestoes(pendentes, lojas));
  });

  /**
   * { padroes, lojaId? } -> o que esses padrões reconheceriam nas compras do usuário.
   * Sem lojaId: como uma loja nova. Com lojaId: como se a loja passasse a ter esses padrões.
   */
  router.post("/previa", async (req, res) => {
    const padroes = validarPadroes(req.body?.padroes);
    if (!padroes.length) throw new ErroHttp(400, "Informe ao menos um padrão");
    const lojaId = typeof req.body.lojaId === "string" ? req.body.lojaId : null;
    const lojas = await repo.listarLojas();
    if (lojaId && !lojas.some((l) => l.id === lojaId)) throw new ErroHttp(404, "Loja não encontrada");

    const alvoId = lojaId ?? "(nova)";
    const simuladas = lojaId
      ? lojas.map((l) => (l.id === lojaId ? { ...l, padroes } : l))
      : [...lojas, { id: alvoId, nome: "(nova)", padroes }];
    const nomes = new Map(lojas.map((l) => [l.id, l.nome]));

    const candidatas = await coletarCandidatas(repo, req.usuario.id, { padroes, lojaIds: lojaId ? [lojaId] : [] });
    const captura = new Map();
    const perdidas = new Map();
    for (const c of candidatas) {
      if (c.lojaManual) continue;
      const nova = encontrarLoja(c, simuladas);
      const grupo = nova === alvoId ? captura : c.lojaId === lojaId && lojaId ? perdidas : null;
      if (!grupo) continue;
      const chave = `${c.estabelecimento}|${c.lojaId ?? ""}`;
      if (!grupo.has(chave)) {
        grupo.set(chave, {
          estabelecimento: c.estabelecimento,
          nomeEstabelecimento: c.nomeEstabelecimento,
          quantidade: 0,
          lojaAtual: c.lojaId && c.lojaId !== lojaId ? { id: c.lojaId, nome: nomes.get(c.lojaId) ?? "?" } : null,
        });
      }
      grupo.get(chave).quantidade++;
    }
    const lista = (m) => [...m.values()].sort((a, b) => b.quantidade - a.quantidade);
    res.json({
      captura: lista(captura),
      tomadasDeOutrasLojas: lista(captura).filter((g) => g.lojaAtual).reduce((s, g) => s + g.quantidade, 0),
      perdidas: lista(perdidas),
      conflitos: padroesEmConflito(padroes, lojas, lojaId),
    });
  });

  /**
   * { nome, categoria, padroes? , estabelecimento?, nomeEstabelecimento? }
   * Sem padrões, o padrão sai do estabelecimento da compra, coerente com o nome escolhido:
   * nome "AMERICANAS" + estabelecimento "AMERICANASF485BA" -> padrão "AMERICANAS".
   */
  router.post("/", async (req, res) => {
    const dados = validarNovaLoja(req.body);
    const lojas = await repo.listarLojas();
    const padroes = dados.padroes?.length
      ? dados.padroes
      : [sugerirPadrao(dados.nome, dados.estabelecimento, req.body.nomeEstabelecimento)];
    exigirSemConflito(padroes, lojas, null);

    const agora = new Date().toISOString();
    const loja = await repo.criarLoja({
      nome: dados.nome,
      categoria: dados.categoria,
      padroes,
      criadoPor: req.usuario.id,
      criadoEm: agora,
      atualizadoPor: req.usuario.id,
      atualizadoEm: agora,
    });
    if (!loja) {
      const existente = lojas.find((l) => l.nomeNormalizado === normalizar(dados.nome));
      throw new ErroHttp(409, `Já existe uma loja chamada ${existente?.nome ?? dados.nome}. Acrescente o padrão a ela.`, {
        lojaId: existente?.id ?? null,
      });
    }
    const comprasAtualizadas = await reprocessar(repo, { padroes });
    res.status(201).json({ loja, comprasAtualizadas });
  });

  /** { nome?, categoria?, padroes? } — padroes substitui a lista inteira. */
  router.patch("/:id", async (req, res) => {
    const campos = validarAlteracaoLoja(req.body);
    const lojas = await repo.listarLojas();
    const atual = lojas.find((l) => l.id === req.params.id) ?? (await repo.buscarLoja(req.params.id));
    if (!atual) throw new ErroHttp(404, "Loja não encontrada");
    if (campos.padroes) exigirSemConflito(campos.padroes, lojas, atual.id);

    const loja = await repo.alterarLoja(atual.id, () => ({
      ...campos,
      atualizadoPor: req.usuario.id,
      atualizadoEm: new Date().toISOString(),
    }));
    if (!loja) throw new ErroHttp(404, "Loja não encontrada");

    const comprasAtualizadas = campos.padroes
      ? await reprocessar(repo, { padroes: unirPadroes(atual.padroes, campos.padroes), lojaIds: [atual.id] })
      : 0;
    res.json({ loja, comprasAtualizadas });
  });

  router.delete("/:id", async (req, res) => {
    const loja = await repo.excluirLoja(req.params.id);
    if (!loja) throw new ErroHttp(404, "Loja não encontrada");
    const comprasAtualizadas = await reprocessar(repo, { lojaIds: [loja.id] });
    res.json({ comprasAtualizadas });
  });

  /** { origemId }: a loja origem some; os padrões e as compras dela passam para esta. */
  router.post("/:id/juntar", async (req, res) => {
    const origemId = req.body?.origemId;
    if (typeof origemId !== "string" || origemId === req.params.id) throw new ErroHttp(400, "Informe a outra loja em origemId");
    const [destino, origem] = await Promise.all([repo.buscarLoja(req.params.id), repo.buscarLoja(origemId)]);
    if (!destino || !origem) throw new ErroHttp(404, "Loja não encontrada");

    // Primeiro a loja que fica recebe os padrões; só depois a outra some (uma falha no meio não perde nada).
    const loja = await repo.alterarLoja(destino.id, (atual) => ({
      padroes: unirPadroes(atual.padroes, origem.padroes),
      atualizadoPor: req.usuario.id,
      atualizadoEm: new Date().toISOString(),
    }));
    await repo.excluirLoja(origem.id);
    const comprasAtualizadas = await reprocessar(repo, {
      lojaIds: [origem.id],
      redirecionar: { de: origem.id, para: destino.id },
    });
    res.json({ loja, comprasAtualizadas });
  });

  return router;
}

/** Estabelecimentos ignorados: compras avulsas que não precisam de loja (saem das sugestões). */
export function rotasIgnorados({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  router.get("/", async (req, res) => {
    res.json(await repo.listarIgnorados());
  });

  router.post("/", async (req, res) => {
    const estabelecimento = validarEstabelecimento(req.body?.estabelecimento);
    const criado = await repo.ignorar({ estabelecimento, ignoradoPor: req.usuario.id, em: new Date().toISOString() });
    if (!criado) throw new ErroHttp(409, "Este estabelecimento já está ignorado");
    const comprasAtualizadas = await reprocessar(repo, { estabelecimentos: [estabelecimento] });
    res.status(201).json({ estabelecimento, comprasAtualizadas });
  });

  router.delete("/:estabelecimento", async (req, res) => {
    const estabelecimento = validarEstabelecimento(req.params.estabelecimento);
    if (!(await repo.desfazerIgnorado(estabelecimento))) throw new ErroHttp(404, "Estabelecimento não está ignorado");
    const comprasAtualizadas = await reprocessar(repo, { estabelecimentos: [estabelecimento] });
    res.json({ estabelecimento, comprasAtualizadas });
  });

  return router;
}

export function rotasCategorias() {
  const router = Router();
  router.get("/", (req, res) => {
    res.json(CATEGORIAS.map(({ id, nome, icone }) => ({ id, nome, icone })));
  });
  return router;
}
