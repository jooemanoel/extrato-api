# Modelagem do Extrato no Firestore

Este documento registra o modelo de dados do Extrato depois da saída do Supabase, e o
porquê de cada decisão. As regras foram tiradas de arquivos OFX reais do Banco do Brasil
e das 1.652 compras do banco antigo (novembro de 2026).

## Como o Banco do Brasil gera o OFX de cartão

Estes fatos sustentam o resto do modelo.

| Fato | Consequência |
|---|---|
| O `FITID` é `AAAAMMDD` + número do cartão mascarado (16 dígitos) + **posição da linha no arquivo** (10 dígitos). A fatura aberta lista as linhas na ordem de lançamento; a fechada, agrupadas por categoria. Parcelas de meses diferentes repetem o mesmo FITID. | O FITID **não** identifica a compra. É guardado só como informação. |
| O `MEMO` da fatura fechada tem 39 colunas fixas: estabelecimento `[0,23)`, cidade `[23,36)`, país `[37,39)`. Em parcelas, o estabelecimento ocupa `[0,13)` e `PARC NN/NN` começa na coluna 14. Na fatura aberta o MEMO vem aparado, sem o país, mas as 23 primeiras colunas são iguais. | O **estabelecimento** (as 23 colunas, ou 13 em parcelas) é a parte estável do MEMO. |
| Parcelas mantêm a **data da compra original** em todas as faturas. | A fatura de uma compra é decidida pelo **arquivo**, nunca pela data. |
| `LEDGERBAL` é o total da fatura fechada (soma das compras e estornos, sem o pagamento). Na fatura aberta é `0.00`. | Distingue aberta de fechada e permite conferir a importação. |
| Compras vêm como `PAYMENT` e créditos como `CREDIT`, mas o `TRNTYPE` não é confiável. | O **sinal** do valor decide: negativo é compra, positivo é estorno; `PGTO DEBITO CONTA…` é o pagamento da fatura anterior. |
| Lançamentos idênticos no mesmo dia são legítimos (duas passagens de metrô, duas cobranças do Wellhub). | A chave da compra conta as ocorrências. |
| O nome do arquivo traz cartão e mês de vencimento: `OUROCARD_VISA_INFINITE-Nov_26.ofx`; a fatura aberta é `…-Próxima_Fatura.ofx`. | Fonte da competência e do nome do cartão. |
| O `ACCTID` vem mascarado (`1234000000005678`). | O cartão é identificado por `1234-5678`. |

## Estrutura

```
extrato_usuarios/{NOME}                      usuário
  cartoes/{1234-5678}                        cartão
  faturas/{1234-5678_2026-12}                fatura de um cartão num mês de vencimento
  compras/{id}                               compra (id calculado, ver abaixo)
extrato_lojas/{autoId}                       loja, compartilhada entre todos os usuários
extrato_ignorados/{ESTABELECIMENTO}          estabelecimento sem loja de propósito, compartilhado
```

O banco fica no mesmo projeto Firebase do Listas e do Questões Rápidas (`testebd-80d9e`).
Só a API acessa, pelo `firebase-admin`. As regras do Firestore, publicadas pelo listas-api,
fecham o projeto inteiro para o navegador.

Datas e horários são texto: `"2026-11-21T12:00:00.000Z"` para registros e `"AAAA-MM-DD"`
para a data de uma compra (sem fuso horário). Valores são **centavos inteiros com o sinal do
OFX**: negativo é gasto.

### Usuário — `extrato_usuarios/{NOME}`

| Campo | |
|---|---|
| `nome` | maiúsculas, sem acento (`JOAO`); também é o id |
| `senhaHash` | bcrypt |
| `criadoEm` | |

### Cartão — `cartoes/{1234-5678}`

| Campo | |
|---|---|
| `nome` | vem do nome do arquivo (`OUROCARD VISA INFINITE`); editável. Cartões migrados começam como `CARTÃO FINAL 5678` e ganham o nome na primeira importação. |
| `numero` | `ACCTID` mascarado |
| `criadoEm` | |

### Fatura — `faturas/{cartão}_{AAAA-MM}`

A **competência** `AAAA-MM` é o mês de **vencimento**: `Nov_26` vira `2026-11`.

| Campo | |
|---|---|
| `cartaoId`, `competencia` | |
| `situacao` | `aberta` ou `fechada`. Uma vez fechada, não volta a ser aberta. |
| `totalBanco` | `LEDGERBAL` da fatura fechada, para conferência (`null` na aberta e nas migradas) |
| `totalCompras`, `quantidade` | mantidos pela API a cada importação, compra manual ou exclusão |
| `inicio`, `fim` | menor e maior data das compras que não são parcela (recalculados a cada importação) |
| `pagamento` | `{ data, valor }`, preenchido pela linha PGTO do arquivo da fatura seguinte |
| `importacoes` | as últimas 20: `{ em, arquivo, situacao, novas, existentes, movidas, ausentes, removidas }` |
| `criadoEm`, `atualizadoEm` | |

### Compra — `compras/{id}`

| Campo | |
|---|---|
| `cartaoId`, `faturaId` | |
| `data` | `AAAA-MM-DD` (nas parcelas, a data da compra original) |
| `valor` | centavos com sinal |
| `tipo` | `compra` ou `estorno` |
| `memo` | texto bruto do OFX; nunca muda |
| `fitid` | só informativo |
| `estabelecimento` | as 23 (ou 13) colunas normalizadas: maiúsculas, sem acento, só `A-Z0-9` (`BRBMOBILIDADEMETRO`). Nunca muda: é a base do id e do reconhecimento da loja. |
| `nomeEstabelecimento` | o mesmo trecho legível (`BRB MOBILIDADE METRO`) |
| `parcela` | `{ numero, total }` ou `null` |
| `descricao` | apelido dado pelo usuário, ou `null`. A tela mostra `descricao`, senão o nome da loja, senão `nomeEstabelecimento`. |
| `lojaId` | loja reconhecida (ou escolhida à mão) |
| `lojaManual` | `true` se o usuário escolheu a loja; o reconhecimento automático não troca |
| `ignorado` | sem loja porque o estabelecimento está em `extrato_ignorados` |
| `pendente` | sem loja e não ignorada: aparece nas sugestões. Gravado para a consulta das sugestões ser barata. |
| `origem` | `ofx` ou `manual` |
| `criadoEm` | |

**Não há categoria na compra.** A categoria é sempre a da loja (decisão de negócio: lojas que
vendem de tudo, como a Americanas, ficam numa categoria só). A API devolve a compra com
`loja: { id, nome }` e `categoria` resolvidos. Mudar a categoria da loja muda todas as compras dela.

#### Id da compra

```
{cartão}_{AAAAMMDD}_{valor}_{estabelecimento}_{parcela}_{ocorrência}
1234-5678_20261106_-550_BRBMOBILIDADEMETRO_0_1
1234-5678_20261106_-550_BRBMOBILIDADEMETRO_0_2
1234-5678_20250806_-12990_LOJAEXEMPLO_0306_1
```

- O mesmo lançamento gera o mesmo id em qualquer exportação: aberta ou fechada, com qualquer
  ordem de linhas e com ou sem o país no MEMO.
- **Ocorrência** conta lançamentos idênticos dentro do mesmo arquivo. Se a fatura aberta tinha
  uma passagem de metrô no dia e a fechada tem duas, a `_1` já existe e só a `_2` é criada.
- O valor leva o sinal: um estorno não colide com a compra que estornou.
- A chave é por **cartão**, não por fatura. Uma compra que aparece em outra fatura é encontrada
  e pode ser movida.
- O Firestore recusa criar um id que já existe, então reimportar nunca duplica.

### Loja — `extrato_lojas/{autoId}` (compartilhada)

| Campo | |
|---|---|
| `nome` | livre, com acentos (`ASSAÍ`, `METRÔ`) |
| `nomeNormalizado` | sem acento; único entre as lojas |
| `categoria` | `mercado`, `saude`, `transporte`, `lazer`, `variedades`, `educacao`, `internet` ou `null` |
| `padroes` | `[{ tipo: "prefixo" \| "contem", texto }]`, com o texto normalizado como o estabelecimento |
| `criadoPor`, `criadoEm`, `atualizadoPor`, `atualizadoEm` | |

As categorias são fixas no código ([src/categorias.js](../src/categorias.js)).

### Ignorado — `extrato_ignorados/{ESTABELECIMENTO}` (compartilhado)

`{ ignoradoPor, em }`. Serve para compras avulsas, como nomes de pessoas ou lugares visitados
uma vez, que não precisam de loja e não devem aparecer nas sugestões.

## Importação

`POST /importacoes/previa` mostra o resultado sem gravar; `POST /importacoes` grava, numa transação.

1. **Cartão**: `ACCTID`. Na primeira vez, o cartão é criado com o nome tirado do arquivo.
2. **Competência**: a informada pelo usuário; senão a do nome do arquivo; senão o mês seguinte
   ao da compra mais antiga que não é parcela. Com os ciclos atuais (fechamento por volta do
   dia 10), essa regra acerta tanto a fatura aberta quanto as fechadas do banco antigo.
3. **Situação**: o nome do arquivo decide (`Próxima_Fatura` é aberta; mês no nome é fechada).
   Sem isso, decide o `LEDGERBAL` (0,00 é aberta).
4. **Linhas**: PGTO vira o `pagamento` da fatura do mês anterior, se ela existir. As demais
   linhas viram compras com o id calculado.
5. **Comparação com o banco**:
   - compra nova é criada, já com a loja reconhecida;
   - compra existente nesta fatura não é tocada (descrição e loja escolhidas são preservadas);
   - compra existente em **outra** fatura do cartão é **movida** se o arquivo é de fatura fechada,
     porque a fechada é a palavra final; na aberta, fica onde está e é apenas listada;
   - compras da fatura que vieram de OFX e não estão no arquivo são **ausentes** (por exemplo,
     um estorno que sumiu entre a aberta e a fechada). Só são removidas com `removerAusentes: true`.
6. **Conferência** (fatura fechada): `totalBanco` comparado com a soma das compras da fatura.
7. O arquivo da fatura aberta é **recusado** se a fatura já foi importada fechada.
8. **Conta corrente** (OFX sem `CREDITCARDMSGSRSV1`) é recusada: está fora do escopo.

## Lojas

### Reconhecimento

Cada padrão é comparado com o `estabelecimento` da compra:

- **prefixo** (padrão): o estabelecimento começa com o texto. `AMERICANAS` reconhece
  `AMERICANASF485BA`, `AMERICANASSA` e qualquer filial futura.
- **contém**: o estabelecimento contém o texto. `99RIDE` reconhece `DL99RIDE` e
  `PG99L2L99RIDE`. Exige 3 caracteres; o prefixo exige 2 (`99`).
- **Parcelas**: o nome vem cortado em 13 colunas. Ali também vale o contrário: o padrão
  começar com o estabelecimento (`ENCANTOCOLCH` é reconhecido pelo padrão `ENCANTOCOLCHOES`).
- **Desempate**: vence o padrão mais longo; empatados, o prefixo vence o "contém".
- Um padrão idêntico não pode estar em duas lojas.

A loja fica gravada na compra (`lojaId`). Quando lojas, padrões ou ignorados mudam, a API
recalcula **só as compras que podem ser afetadas**, em todos os usuários
([src/servicos/reprocessar.js](../src/servicos/reprocessar.js)):

| Mudança | Compras relidas |
|---|---|
| padrão de prefixo novo ou alterado | estabelecimento começando com o padrão (consulta por intervalo) e parcelas cujo nome cortado é o começo do padrão |
| padrão "contém" | as pendentes (sem loja) |
| loja alterada, excluída ou juntada | as daquela loja |
| estabelecimento ignorado ou devolvido | as daquele estabelecimento |

### Sugestões e coerência

`GET /lojas/sugestoes` agrupa as compras pendentes do usuário. Para cada grupo, sugere:

- **Nome**: tira o intermediador de pagamento (`MP*`, `PG *`, `EC *`, `DL*`…), separa palavras
  coladas (`BrunaRoupas` vira `BRUNA ROUPAS`) e remove do fim as palavras com número e os
  sufixos de empresa. Exemplos: `AMERICANAS F485BA` vira `AMERICANAS`; `CIA DOS CALCADOS F25EA`
  vira `CIA DOS CALCADOS`; `RIACHUELO 093` e `RIACHUELO FILIAL037` viram um grupo só, `RIACHUELO`.
- **Padrão**: o nome normalizado, se o estabelecimento começa com ele; senão, o estabelecimento.
- **Categoria**: por palavras-chave (`DROGA` é saúde, `SUPERMERC` é mercado…).
- **Lojas parecidas**: lojas com alguma palavra de 4 ou mais letras em comum
  (`SORVETES PRESTIGIO` com `SORVETERIA PRESTIGIO`).
- **"Adicionar à loja X"** em vez de "nova", quando:
  - o nome sugerido é o de uma loja existente; ou
  - o estabelecimento usa um intermediador que só uma loja usa. Ex.: `IFD*NOVO RESTAURANTE`
    vira um acréscimo à IFOOD com o padrão `IFD`. Intermediadores usados por várias lojas,
    como `MP*`, ficam de fora.

O usuário sempre tem a palavra final:

- **O nome é livre.** Ao criar a loja a partir de uma compra (`POST /lojas` com `estabelecimento`,
  sem `padroes`), o padrão segue o nome escolhido. Ex.: o usuário troca `CIA` por
  `CIA DOS CALCADOS` e o padrão vira `CIADOSCALCADOS`.
- **Ver antes de salvar.** `POST /lojas/previa` mostra o que os padrões vão reconhecer, quais
  compras seriam tiradas de outras lojas e quais deixariam a loja.
- **Nada duplicado.** Nome repetido devolve `409` com o `lojaId` existente, para o front-end
  oferecer "acrescentar o padrão a ela". Padrão de outra loja também devolve `409`.
- **Juntar lojas.** `POST /lojas/:id/juntar` junta duas lojas: padrões e compras vão para a
  que fica, inclusive as escolhas manuais.
- **Escolher à mão.** `PATCH /compras/:id { lojaId }` escolhe a loja de uma compra; `lojaId: null`
  devolve a compra ao reconhecimento automático.

## Migração do Supabase

[scripts/migrar-supabase.js](../scripts/migrar-supabase.js). Simulação feita em 21/11/2026:

- 1 usuário com dados (os outros 6 não tinham compras e ficam de fora; `--todos-usuarios` os inclui).
- 1.652 compras e 27 faturas: as 16 antigas misturavam os dois cartões e foram separadas
  (15 do Visa e 12 do Elo). A "MARÇO 2026" estava vazia.
- 93 linhas de `loja` viram 45 lojas (agrupadas por `nome_fantasia`). Elas reconhecem 1.201
  compras; 451 ficam para as sugestões.
- **Categoria**: nenhuma compra antiga tinha categoria sem loja ou diferente da loja, então
  derivar a categoria da loja não perde nada.
- **Senhas**: os hashes bcrypt (`$2b$`) são copiados como estão.

## Pendências e limitações

- **Fatura aberta que fechou**: falta comparar, com arquivos reais, a exportação "Próxima_Fatura"
  com a fechada do mesmo mês. Pontos a conferir:
  - a data de cada compra é a mesma nas duas;
  - as 23 primeiras colunas do MEMO são iguais.

  Se a data mudar, a importação da fechada mostra as compras da aberta como "ausentes" e as da
  fechada como novas, e a conferência acusa. Nesse caso, o plano é casar as compras da aberta
  por cartão, valor, estabelecimento e parcela, aceitando alguns dias de diferença na data.
- **Padrão "contém"** só alcança as compras pendentes quando é criado. Ele não tira compras
  de outras lojas que já existiam.
- **Totais da fatura de origem**: ao mover uma compra, o `inicio` e o `fim` da fatura de onde
  ela saiu não são recalculados; só os totais.
- **Cache de lojas**: cada instância da API guarda as lojas por até 1 minuto. Uma alteração
  feita por outra instância pode levar esse tempo para aparecer.
