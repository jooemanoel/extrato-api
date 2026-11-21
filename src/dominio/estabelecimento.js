// Interpretação do MEMO das faturas do Banco do Brasil.
//
// Na fatura fechada o MEMO tem 39 colunas fixas:
//   [0,23) estabelecimento   [23,36) cidade   [37,39) país
//   "FRANGOLAR              BRASILIA      BR"
// Em parcelas, o estabelecimento ocupa só 13 colunas e a parcela vem logo depois:
//   "EC *EBAZARCOM PARC 01/06 CAJAMAR     BR"
// Na fatura aberta ("Próxima_Fatura") o MEMO vem aparado e sem o país,
// mas as 23 primeiras colunas são as mesmas:
//   "FRANGOLAR              BRASILIA"

const PARCELA = /^(.{13}) PARC (\d{2})\/(\d{2})/;

/** Padrões e estabelecimentos são comparados assim: maiúsculas, sem acento, só A-Z e 0-9. */
export function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Tamanho mínimo do texto de um padrão. "99" é uma loja real (99 Táxi), por isso 2 no prefixo. */
export const TAMANHO_MINIMO_PADRAO = { prefixo: 2, contem: 3 };

/**
 * { estabelecimento, nomeEstabelecimento, parcela }
 *   estabelecimento      normalizado; base da chave da compra e do reconhecimento da loja
 *   nomeEstabelecimento  o mesmo trecho legível ("DL *GOOGLE YouTubePrem")
 *   parcela              { numero, total } ou null. Em parcelas o nome vem cortado em 13 colunas.
 */
export function interpretarMemo(memo) {
  const texto = String(memo ?? "");
  const m = texto.match(PARCELA);
  const campo = m ? m[1] : texto.slice(0, 23);
  return {
    estabelecimento: normalizar(campo),
    nomeEstabelecimento: campo.replace(/\s+/g, " ").trim(),
    parcela: m ? { numero: Number(m[2]), total: Number(m[3]) } : null,
  };
}
