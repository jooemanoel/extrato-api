// Leitura do OFX de cartão de crédito do Banco do Brasil (OFX 1.02, SGML).
//
// O BB fecha todas as tags, mas o formato SGML permite tags sem fechamento;
// por isso cada campo é lido até o próximo "<" ou quebra de linha, sem usar um parser XML.
import { ErroHttp } from "../validacao.js";

const ENTIDADES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decodificar = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (e) => ENTIDADES[e]);

function campo(bloco, tag) {
  const m = bloco.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i"));
  return m ? decodificar(m[1].trim()) : null;
}

/** "20261029" ou "20261029120000[-3:BRT]" -> "2026-10-29" */
function data(valor, tag) {
  const m = String(valor ?? "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) throw new ErroHttp(422, `Data inválida no arquivo (${tag})`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** "-14.25" -> -1425. Sem ponto flutuante acumulado: arredonda uma vez. */
function centavos(valor, tag) {
  const numero = Number(String(valor ?? "").replace(",", "."));
  if (valor == null || valor === "" || !Number.isFinite(numero)) {
    throw new ErroHttp(422, `Valor inválido no arquivo (${tag})`);
  }
  return Math.round(numero * 100) || 0; // "|| 0" troca o -0 de "-0.00" por 0
}

/**
 * {
 *   numeroCartao  "1234000000005678" (já vem mascarado pelo banco)
 *   saldo         LEDGERBAL em centavos: total da fatura fechada; 0 na fatura aberta
 *   transacoes    [{ fitid, data, valor, memo }]
 * }
 */
export function lerOfx(conteudo) {
  const texto = String(conteudo ?? "");
  if (!/<OFX>/i.test(texto)) throw new ErroHttp(422, "O arquivo não parece ser um OFX");
  if (!/<CREDITCARDMSGSRSV1>/i.test(texto)) {
    throw new ErroHttp(422, "Este OFX não é de fatura de cartão de crédito (extrato de conta corrente não é aceito)");
  }

  const numeroCartao = (campo(texto, "ACCTID") ?? "").replace(/\D/g, "");
  if (numeroCartao.length < 8) throw new ErroHttp(422, "Número do cartão (ACCTID) não encontrado no arquivo");

  const ledger = texto.split(/<LEDGERBAL>/i)[1];
  const saldoBruto = ledger ? campo(ledger, "BALAMT") : null;
  const saldo = saldoBruto == null ? null : centavos(saldoBruto, "BALAMT");

  const transacoes = texto
    .split(/<STMTTRN>/i)
    .slice(1)
    .map((bloco) => bloco.split(/<\/STMTTRN>/i)[0])
    .map((bloco) => ({
      fitid: campo(bloco, "FITID"),
      data: data(campo(bloco, "DTPOSTED"), "DTPOSTED"),
      valor: centavos(campo(bloco, "TRNAMT"), "TRNAMT"),
      memo: campo(bloco, "MEMO") ?? campo(bloco, "NAME") ?? "",
    }));

  return { numeroCartao, saldo, transacoes };
}

/** "1234000000005678" -> "1234-5678": os únicos dígitos reais do número mascarado. */
export const idDoCartao = (numeroCartao) => `${numeroCartao.slice(0, 4)}-${numeroCartao.slice(-4)}`;
