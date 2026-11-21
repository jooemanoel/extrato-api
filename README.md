# extrato-api

API em Express para o app **Extrato**: controle dos gastos do cartão de crédito a partir das
faturas OFX do Banco do Brasil. Substitui o extrato-api-express (Postgres no Supabase, que
hibernava após dias sem uso). Os dados ficam no Firestore, acessado só pelo servidor.

O modelo de dados e as regras de importação e de lojas estão em [docs/MODELAGEM.md](docs/MODELAGEM.md).

## O que mudou em relação ao extrato-api-express

| Antes | Agora |
|---|---|
| Supabase hibernava sem uso | Firestore (mesmo projeto do Listas) + função na Vercel |
| A fatura era criada à mão e escolhida antes de importar | O arquivo diz o cartão, a competência e se a fatura está aberta ou fechada |
| "Apagar compras anteriores da fatura", marcado por padrão: reimportar perdia as categorias | Importação só acrescenta; a fatura aberta pode ser importada quantas vezes quiser |
| Chave `(fitid, descricao)`: o FITID é a posição da linha no arquivo e a descrição era editável | Id calculado de cartão, data, valor, estabelecimento, parcela e ocorrência |
| Faturas misturavam os dois cartões | Uma fatura por cartão e mês |
| Lojas e categorias atualizadas à mão no banco | Lojas compartilhadas com padrões, sugestões automáticas e categoria vinda da loja |
| Editar ou apagar compra e fatura não conferia o dono | Tudo fica sob o usuário do token |
| JWT sem validade | Validade configurável (`JWT_EXPIRES_IN`) |

## Comandos

```bash
npm install
npm run dev:memoria   # sem credenciais: dados em memória (bom para testar o front-end)
npm run dev           # com o Firestore (precisa do .env)
npm test              # testes de domínio e de ponta a ponta (repositório em memória)
npm run segredo       # gera um valor para JWT_SECRET
npm run migrar        # simula a migração do Supabase (--gravar para aplicar)
```

## Rotas

Todas recebem e devolvem JSON. Erros vêm como `{ "erro": "mensagem", "detalhes"?: {...} }`.
Todas as rotas, menos `/auth/cadastro`, `/auth/login` e `/categorias`, exigem `Authorization: Bearer <token>`.
Valores são centavos inteiros com o sinal do OFX (negativo = gasto); datas de compra são `AAAA-MM-DD`.

| Método | Caminho | Corpo | Resposta |
|---|---|---|---|
| POST | `/auth/cadastro` | `{ nome, senha }` | `201 { token, usuario }` |
| POST | `/auth/login` | `{ nome, senha }` | `{ token, usuario }` |
| GET | `/auth/eu` | — | `{ usuario }` |
| GET | `/categorias` | — | `[{ id, nome, icone }]` |
| GET | `/cartoes` | — | `[cartão]` |
| PATCH | `/cartoes/:id` | `{ nome }` | `cartão` |
| GET | `/faturas` | — | `[fatura]` (competência mais recente primeiro) |
| GET | `/faturas/:id` | — | `{ fatura, compras }` |
| DELETE | `/faturas/:id` | — | `204` (apaga também as compras) |
| POST | `/importacoes/previa` | `{ nomeArquivo, conteudo, competencia?, removerAusentes? }` | resumo, sem gravar |
| POST | `/importacoes` | idem | `201` resumo |
| POST | `/compras` | `{ faturaId, data, valor, descricao }` | `201 compra` (manual) |
| PATCH | `/compras/:id` | `{ descricao?, lojaId?, data?, valor? }` | `compra` |
| DELETE | `/compras/:id` | — | `204` |
| GET | `/lojas` | — | `[loja]` |
| GET | `/lojas/sugestoes` | — | `[sugestão]` |
| POST | `/lojas/previa` | `{ padroes, lojaId? }` | `{ captura, tomadasDeOutrasLojas, perdidas, conflitos }` |
| POST | `/lojas` | `{ nome, categoria, padroes? , estabelecimento?, nomeEstabelecimento? }` | `201 { loja, comprasAtualizadas }` |
| PATCH | `/lojas/:id` | `{ nome?, categoria?, padroes? }` | `{ loja, comprasAtualizadas }` |
| DELETE | `/lojas/:id` | — | `{ comprasAtualizadas }` |
| POST | `/lojas/:id/juntar` | `{ origemId }` | `{ loja, comprasAtualizadas }` |
| GET | `/ignorados` | — | `[{ estabelecimento, ignoradoPor, em }]` |
| POST | `/ignorados` | `{ estabelecimento }` | `201` |
| DELETE | `/ignorados/:estabelecimento` | — | `{ comprasAtualizadas }` |

### Importação

O front-end lê o arquivo como texto **windows-1252** (é como o BB grava) e envia o nome original:

```js
const conteudo = new TextDecoder("windows-1252").decode(await arquivo.arrayBuffer());
await api.post("/importacoes/previa", { nomeArquivo: arquivo.name, conteudo });
```

O resumo traz:

- `cartao`, `fatura` (com `origemCompetencia`: `informada`, `arquivo` ou `datas`) e `lancamentos`;
- `novas`, `existentes`, `movidas`, `emOutraFatura` e `ausentes`;
- `pagamento` (da fatura anterior) e `conferencia` (fatura fechada: `{ totalBanco, totalCompras, confere, diferenca }`).

A tela de importação mostra a prévia e deixa corrigir a `competencia` antes de confirmar.
Se houver `ausentes`, oferece `removerAusentes`.

### Sugestões de loja

Cada sugestão traz:

- `tipo`: `nova` ou `adicionar`. Em `adicionar`, traz também o `lojaId` da loja existente;
- `nome`, `padrao` e `categoria`;
- `quantidade`, `total`, `estabelecimentos` e `exemplos`;
- `parecidas`: lojas com nome parecido.

Fluxo esperado:

1. O usuário corrige o nome e, se quiser, o padrão.
2. `POST /lojas/previa` mostra o que vai ser reconhecido.
3. `POST /lojas`, ou `PATCH /lojas/:id` com o padrão acrescentado, aplica.
4. Compras avulsas vão para `POST /ignorados`.

## Configuração

1. **Conta de serviço**: a mesma do listas-api (projeto `testebd-80d9e`). Copie
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY` do `.env` de lá.
2. `cp .env.example .env`, preencha, e gere o `JWT_SECRET` com `npm run segredo`. Ele deve ser
   **diferente** do usado no listas-api: o `issuer` dos tokens já impede misturar os dois, e
   segredos diferentes são uma segunda barreira.
3. As regras do Firestore são publicadas pelo listas-api (`npm run regras` lá) e já fecham o
   projeto inteiro para o navegador. Não há regras próprias aqui.

## Deploy na Vercel

1. Importe o repositório na Vercel. O `vercel.json` fixa `"framework": null`.
2. Em *Settings → Environment Variables*, cadastre `JWT_SECRET`, `JWT_EXPIRES_IN`,
   `CORS_ORIGINS`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY`.

## Migração do Supabase

```bash
npm run migrar              # mostra o que seria migrado (funciona sem o Firebase configurado)
npm run migrar -- --gravar  # grava no Firestore
```

Precisa de `SUPABASE_DATABASE_URL` no `.env`. Nada é apagado no Supabase. Usuário que já
existe no Firestore é pulado, então o script pode rodar de novo. Regras completas em
[docs/MODELAGEM.md](docs/MODELAGEM.md#migração-do-supabase).

## Estrutura

```
api/index.js                    entrada da função na Vercel
src/app.js                      Express: CORS, JSON, rotas, tratamento de erros
src/config.js                   variáveis de ambiente
src/autenticacao.js             bcrypt e JWT
src/validacao.js                normalização e limites dos dados recebidos
src/categorias.js               categorias fixas
src/dominio/ofx.js              leitura do OFX do BB
src/dominio/estabelecimento.js  interpretação do MEMO e normalização
src/dominio/importacao.js       competência, ids das compras e plano da importação
src/dominio/lojas.js            reconhecimento, sugestões de nome/padrão/categoria
src/servicos/reprocessar.js     recalcula a loja das compras afetadas por uma mudança
src/servicos/apresentar.js      compras com loja e categoria resolvidas
src/routes/                     /auth, /cartoes, /faturas, /compras, /importacoes, /lojas, /ignorados
src/repositorios/firestore.js   acesso ao Firestore (firebase-admin)
src/repositorios/memoria.js     mesma interface, em memória (testes e dev:memoria)
scripts/migrar-supabase.js
test/                           testes (OFX sintéticos: arquivos reais não entram no repositório)
docs/MODELAGEM.md               modelo de dados e regras de negócio
```

## Limitações conhecidas

- **Sair não invalida o token** no servidor; para derrubar todas as sessões, troque o `JWT_SECRET`.
- **Limite de tentativas de login**: é por instância da função, não global.
- **Mudança de padrão de loja**: relê as compras de todos os usuários afetadas por ela.
  Com poucos usuários, isso custa pouco; com muitos, precisaria de outra estratégia.
- **Comparação aberta x fechada**: falta testar com arquivos reais (veja as pendências em MODELAGEM.md).
