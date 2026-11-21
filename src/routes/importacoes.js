// Importação de fatura OFX: prévia (nada é gravado) e confirmação.
// Corpo: { nomeArquivo, conteudo, competencia?, removerAusentes? }
//   conteudo     o texto do .ofx. O BB grava em windows-1252: no navegador,
//                leia com new TextDecoder("windows-1252").decode(await arquivo.arrayBuffer()).
//   nomeArquivo  o nome original ("OUROCARD_VISA_INFINITE-Nov_26.ofx"): traz o cartão e a competência
//   competencia  "AAAA-MM", para corrigir a competência deduzida
import { Router } from "express";
import { exigirLogin } from "../autenticacao.js";
import { analisarArquivo, chavesDaImportacao, planejar } from "../dominio/importacao.js";
import { validarImportacao } from "../validacao.js";

export function rotasImportacoes({ repo, config }) {
  const router = Router();
  router.use(exigirLogin(config));

  async function executar(req, gravar) {
    const entrada = validarImportacao(req.body);
    const analise = analisarArquivo(entrada);
    const lojas = await repo.listarLojas();
    const ignorados = new Set((await repo.listarIgnorados()).map((i) => i.estabelecimento));
    const agora = new Date().toISOString();

    const plano = await repo.importar(
      req.usuario.id,
      chavesDaImportacao(analise),
      (dados) =>
        planejar({
          ...dados,
          analise,
          lojas,
          ignorados,
          agora,
          removerAusentes: entrada.removerAusentes,
          nomeArquivo: entrada.nomeArquivo,
        }),
      { gravar }
    );
    return plano.resumo;
  }

  router.post("/previa", async (req, res) => {
    res.json(await executar(req, false));
  });

  router.post("/", async (req, res) => {
    res.status(201).json(await executar(req, true));
  });

  return router;
}
