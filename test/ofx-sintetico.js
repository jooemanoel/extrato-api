// Gera OFX no mesmo formato do Banco do Brasil, para os testes.
// (Os arquivos reais têm dados financeiros e não entram no repositório.)

const memoFechada = (estab, cidade = "BRASILIA") => `${estab.padEnd(23)}${cidade.padEnd(13)} BR`;
const memoAberta = (estab, cidade = "BRASILIA") => `${estab.padEnd(23)}${cidade}`;

/**
 * linhas: [data "AAAAMMDD", valor "−12.34", estabelecimento | memo completo, { parcela?: "01/06" }]
 * aberta: MEMO aparado, sem o país (como no arquivo "Próxima_Fatura")
 */
export function gerarOfx({ cartao = "1234000000005678", saldo = "0.00", aberta = false, linhas = [] }) {
  const trns = linhas
    .map(([data, valor, estab, opcoes = {}], i) => {
      let memo;
      if (estab.startsWith("PGTO")) memo = estab;
      else if (opcoes.parcela) memo = `${estab.slice(0, 13).padEnd(13)} PARC ${opcoes.parcela} SAO PAULO   BR`;
      else memo = aberta ? memoAberta(estab) : memoFechada(estab);
      const tipo = Number(valor) < 0 ? "PAYMENT" : "CREDIT";
      const fitid = `${data}${cartao}${String(i).padStart(10, "0")}`;
      return `<STMTTRN><TRNTYPE>${tipo}</TRNTYPE>\n<DTPOSTED>${data}</DTPOSTED>\n<TRNAMT>${valor}</TRNAMT>\n<FITID>${fitid}</FITID>\n<MEMO>${memo}</MEMO>\n</STMTTRN>`;
    })
    .join("\n");

  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0</CODE>
<SEVERITY>INFO</SEVERITY>
</STATUS>
<DTSERVER>20261121123905</DTSERVER>
<LANGUAGE>POR</LANGUAGE>
</SONRS>
</SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1</TRNUID>
<CCSTMTRS>
<CURDEF>BRL</CURDEF>
<CCACCTFROM><ACCTID>
${cartao}
</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<DTSTART>20261001</DTSTART>
<DTEND>20261031</DTEND>
${trns}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${saldo}</BALAMT>
<DTASOF>20261121</DTASOF>
</LEDGERBAL>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}

/** Soma dos valores (sem PGTO), no formato do BALAMT. */
export function saldoDe(linhas) {
  const centavos = linhas
    .filter(([, , estab]) => !estab.startsWith("PGTO"))
    .reduce((s, [, valor]) => s + Math.round(Number(valor) * 100), 0);
  return (centavos / 100).toFixed(2);
}
