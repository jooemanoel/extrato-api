// Conta as leituras do Firestore feitas em cada requisição e registra no log da Vercel:
//   [leituras] GET /lojas/sugestoes 200 312
// O Firestore cobra 1 leitura por documento devolvido (no mínimo 1 por consulta, mesmo vazia)
// e 1 por documento buscado pelo id, exista ele ou não.
import { AsyncLocalStorage } from "node:async_hooks";

const contexto = new AsyncLocalStorage();

/** Soma `n` leituras na requisição em andamento (fora de uma requisição, não faz nada). */
export function contarLeituras(n) {
  const atual = contexto.getStore();
  if (atual) atual.leituras += n;
}

/** Middleware: abre a contagem e escreve a linha de log quando a resposta termina. */
export function registrarLeituras(req, res, next) {
  const registro = { leituras: 0 };
  res.on("finish", () => {
    if (!registro.leituras) return;
    // O caminho da rota ("/faturas/:id"), não o da URL: os ids não vão para o log.
    const rota = req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path;
    console.log(`[leituras] ${req.method} ${rota} ${res.statusCode} ${registro.leituras}`);
  });
  contexto.run(registro, next);
}
