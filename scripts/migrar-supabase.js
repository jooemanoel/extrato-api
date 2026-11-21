// Copia os dados do Extrato antigo (Postgres no Supabase) para o Firestore.
//
// Antes (Supabase):
//   usuario(codigo_usuario, nome_usuario, senha_usuario bcrypt)
//   fatura(codigo_fatura, nome_fatura "JANEIRO 2025", datas, codigo_usuario)   <- misturava os dois cartões
//   compra(fitid, descricao_compra = MEMO do OFX, data, valor em centavos, codigo_categoria_compra, codigo_fatura)
//   loja(nome_loja = MEMO ou começo dele, nome_fantasia, codigo_categoria_compra)
// Depois: estrutura descrita em docs/MODELAGEM.md.
//
// Regras:
//   - Só migra usuários que têm compras (os demais eram contas de teste). --todos-usuarios inclui todos.
//   - Cada fatura antiga é separada por cartão (os dígitos do cartão estão no FITID).
//     A competência vem do nome ("MARÇO 2025" -> 2025-03); o período é recalculado das compras.
//   - Lojas: as linhas com o mesmo nome_fantasia viram uma loja; cada nome_loja vira um padrão
//     de prefixo (as 23 colunas do estabelecimento, normalizadas). Se a loja já existir no
//     Firestore (mesmo nome), os padrões novos são acrescentados.
//   - A categoria das compras não é copiada: ela passa a vir da loja. No banco antigo nenhuma
//     compra tinha categoria diferente da loja, então nada se perde.
//   - Os ids das compras seguem a mesma regra da importação: importar de novo um OFX antigo não duplica nada.
//   - Nada é apagado no Supabase. Usuário que já existe no Firestore é pulado (pode rodar de novo).
//
// Uso:
//   npm run migrar                     -> só mostra o que seria feito
//   npm run migrar -- --gravar         -> grava no Firestore
// Variáveis: SUPABASE_DATABASE_URL e, para gravar, as do Firebase (veja .env.example).
import postgres from "postgres";
import { categoriaPorCodigoAntigo } from "../src/categorias.js";
import { interpretarMemo, normalizar } from "../src/dominio/estabelecimento.js";
import { baseDoId, idDaFatura, resumirCompras } from "../src/dominio/importacao.js";
import { situacaoDaLoja } from "../src/dominio/lojas.js";
import { idDoCartao } from "../src/dominio/ofx.js";
import { normalizarNomeUsuario, normalizarTexto } from "../src/validacao.js";

const gravar = process.argv.includes("--gravar");
const todosUsuarios = process.argv.includes("--todos-usuarios");
const ORIGEM = "migração do Supabase";

const MESES = {
  JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6,
  JULHO: 7, AGOSTO: 8, SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12,
};

function competenciaDoNome(nomeFatura) {
  const texto = String(nomeFatura ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
  const m = texto.match(/^([A-Z]+) (\d{4})$/);
  if (!m || !MESES[m[1]]) return null;
  return `${m[2]}-${String(MESES[m[1]]).padStart(2, "0")}`;
}

const padraoDoNomeLoja = (nomeLoja) => normalizar(nomeLoja.length > 23 ? nomeLoja.slice(0, 23) : nomeLoja);

// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) {
  console.error("Defina SUPABASE_DATABASE_URL (string de conexão do Postgres do Supabase).");
  process.exit(1);
}
const sql = postgres(url, { ssl: "require", max: 1 });

const firebaseConfigurado = Boolean(process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (gravar && !firebaseConfigurado) {
  console.error("Para gravar, configure as variáveis do Firebase (veja .env.example).");
  process.exit(1);
}
let db = null;
let fs = null;
if (firebaseConfigurado) {
  fs = await import("../src/repositorios/firestore.js");
  db = fs.conectarFirestore();
}

console.log(gravar ? "MODO GRAVAÇÃO\n" : "Simulação (nada será gravado). Use --gravar para aplicar.\n");
if (!db) console.log("(Firebase não configurado: a simulação considera o Firestore vazio)\n");

const agora = new Date().toISOString();
const avisos = [];

// ---------- Lojas ----------

const linhasLoja = await sql`select nome_loja, nome_fantasia, codigo_categoria_compra from loja order by codigo_loja`;
const existentes = db ? (await db.collection(fs.COLECAO_LOJAS).get()).docs.map((d) => ({ ...d.data(), id: d.id })) : [];
const lojas = existentes.map((l) => ({ ...l, padroes: [...l.padroes], alterada: false, nova: false }));
const donoDoPadrao = new Map(lojas.flatMap((l) => l.padroes.map((p) => [`${p.tipo}:${p.texto}`, l])));

for (const linha of linhasLoja) {
  const nome = normalizarTexto(linha.nome_fantasia || linha.nome_loja);
  const padrao = { tipo: "prefixo", texto: padraoDoNomeLoja(linha.nome_loja) };
  if (padrao.texto.length < 2) {
    avisos.push(`loja "${linha.nome_loja}": padrão curto demais, ignorado`);
    continue;
  }
  let loja = lojas.find((l) => normalizar(l.nome) === normalizar(nome));
  if (!loja) {
    loja = {
      id: db ? db.collection(fs.COLECAO_LOJAS).doc().id : `simulada-${lojas.length + 1}`,
      nome,
      categoria: categoriaPorCodigoAntigo(linha.codigo_categoria_compra),
      padroes: [],
      criadoPor: ORIGEM,
      criadoEm: agora,
      atualizadoPor: ORIGEM,
      atualizadoEm: agora,
      nova: true,
      alterada: true,
    };
    lojas.push(loja);
  }
  const chave = `${padrao.tipo}:${padrao.texto}`;
  const dono = donoDoPadrao.get(chave);
  if (dono && dono !== loja) {
    avisos.push(`padrão ${padrao.texto} (${linha.nome_loja.trim()}) já pertence à loja ${dono.nome}; mantido lá`);
    continue;
  }
  if (!dono) {
    loja.padroes.push(padrao);
    loja.alterada = true;
    donoDoPadrao.set(chave, loja);
  }
  const categoria = categoriaPorCodigoAntigo(linha.codigo_categoria_compra);
  if (loja.nova && categoria && loja.categoria && categoria !== loja.categoria) {
    avisos.push(`loja ${nome}: linhas com categorias diferentes (${loja.categoria} x ${categoria}); ficou ${loja.categoria}`);
  }
}

const lojasNovas = lojas.filter((l) => l.nova);
const lojasAlteradas = lojas.filter((l) => l.alterada && !l.nova);
console.log(`Lojas: ${linhasLoja.length} linhas -> ${lojasNovas.length} lojas novas` +
  (lojasAlteradas.length ? `, ${lojasAlteradas.length} existentes com padrões novos` : ""));

const ignorados = new Set(db ? (await db.collection(fs.COLECAO_IGNORADOS).get()).docs.map((d) => d.id) : []);

// ---------- Usuários ----------

const usuarios = await sql`
  select u.codigo_usuario, u.nome_usuario, u.senha_usuario,
         (select count(*)::int from compra c where c.codigo_usuario = u.codigo_usuario) as compras
  from usuario u order by u.codigo_usuario`;

const planos = [];
for (const u of usuarios) {
  const id = normalizarNomeUsuario(u.nome_usuario);
  if (!id) {
    avisos.push(`usuário ${u.codigo_usuario}: nome vazio após normalizar, ignorado`);
    continue;
  }
  if (!u.compras && !todosUsuarios) {
    console.log(`- usuário ${u.codigo_usuario}: sem compras, ignorado (use --todos-usuarios para incluir)`);
    continue;
  }
  if (db && (await db.collection(fs.COLECAO_USUARIOS).doc(id).get()).exists) {
    console.log(`- ${id}: já existe no Firestore, pulado`);
    continue;
  }

  const faturasAntigas = new Map(
    (await sql`select codigo_fatura, nome_fatura from fatura where codigo_usuario = ${u.codigo_usuario}`).map((f) => [
      f.codigo_fatura,
      f,
    ])
  );
  const linhas = await sql`
    select fitid, descricao_compra, to_char(data_compra, 'YYYY-MM-DD') as data, valor_compra, codigo_fatura
    from compra where codigo_usuario = ${u.codigo_usuario}
    order by codigo_fatura, fitid`;

  const contagem = new Map();
  const compras = [];
  for (const l of linhas) {
    const antiga = faturasAntigas.get(l.codigo_fatura);
    const competencia = antiga && competenciaDoNome(antiga.nome_fatura);
    if (!competencia) {
      avisos.push(`${id}: compra ${l.fitid} sem fatura válida (codigo_fatura ${l.codigo_fatura}), ignorada`);
      continue;
    }
    const digitos = String(l.fitid).slice(8, 24);
    if (!/^\d{16}$/.test(digitos)) {
      avisos.push(`${id}: FITID ${l.fitid} fora do padrão do BB, compra ignorada`);
      continue;
    }
    const cartaoId = idDoCartao(digitos);
    const memo = l.descricao_compra;
    const base = { cartaoId, data: l.data, valor: l.valor_compra, ...interpretarMemo(memo) };
    const chave = baseDoId(base);
    const n = (contagem.get(chave) ?? 0) + 1;
    contagem.set(chave, n);

    const compra = {
      id: `${chave}_${n}`,
      ...base,
      faturaId: idDaFatura(cartaoId, competencia),
      tipo: l.valor_compra < 0 ? "compra" : "estorno",
      memo,
      fitid: l.fitid,
      descricao: null,
      origem: "ofx",
      criadoEm: agora,
    };
    compras.push({ ...compra, ...situacaoDaLoja(compra, lojas, ignorados) });
  }

  const porFatura = new Map();
  for (const c of compras) porFatura.set(c.faturaId, [...(porFatura.get(c.faturaId) ?? []), c]);
  const faturas = [...porFatura].map(([faturaId, lista]) => {
    const [cartaoId, competencia] = faturaId.split("_");
    return {
      id: faturaId,
      cartaoId,
      competencia,
      situacao: "fechada",
      totalBanco: null,
      ...resumirCompras(lista),
      pagamento: null,
      importacoes: [{ em: agora, arquivo: ORIGEM, situacao: "fechada", novas: lista.length, existentes: 0, movidas: 0, ausentes: 0, removidas: 0 }],
      criadoEm: agora,
      atualizadoEm: agora,
    };
  });
  const cartoes = [...new Set(compras.map((c) => c.cartaoId))].map((cid) => {
    const amostra = linhas.find((l) => idDoCartao(String(l.fitid).slice(8, 24)) === cid);
    return { id: cid, nome: `CARTÃO FINAL ${cid.slice(-4)}`, numero: String(amostra.fitid).slice(8, 24), criadoEm: agora };
  });

  const vazias = [...faturasAntigas.values()].filter((f) => !linhas.some((l) => l.codigo_fatura === f.codigo_fatura));
  for (const f of vazias) avisos.push(`${id}: fatura "${f.nome_fatura}" sem compras, não migrada`);

  const comLoja = compras.filter((c) => c.lojaId).length;
  console.log(`+ ${id}: ${compras.length} compras, ${faturas.length} faturas, ${cartoes.length} cartão(ões); ${comLoja} compras reconhecidas por loja, ${compras.length - comLoja} sem loja`);
  for (const c of cartoes) {
    const doCartao = faturas.filter((f) => f.cartaoId === c.id).map((f) => f.competencia).sort();
    console.log(`    ${c.id}: ${doCartao.length} faturas (${doCartao[0]} a ${doCartao.at(-1)})`);
  }
  planos.push({ id, usuario: { nome: id, senhaHash: u.senha_usuario, criadoEm: agora }, cartoes, faturas, compras });
}

if (avisos.length) {
  console.log(`\nAvisos (${avisos.length}):`);
  for (const a of avisos.slice(0, 40)) console.log(`  ! ${a}`);
  if (avisos.length > 40) console.log(`  ... e mais ${avisos.length - 40}`);
}

// ---------- Gravação ----------

if (gravar) {
  const operacoes = [];
  const semControle = ({ nova, alterada, id, ...dados }) => ({ ...dados, nomeNormalizado: normalizar(dados.nome) });
  for (const l of [...lojasNovas, ...lojasAlteradas]) {
    operacoes.push((b) => b.set(db.collection(fs.COLECAO_LOJAS).doc(l.id), semControle(l)));
  }
  for (const p of planos) {
    const usuario = db.collection(fs.COLECAO_USUARIOS).doc(p.id);
    for (const { id, ...c } of p.cartoes) operacoes.push((b) => b.set(usuario.collection("cartoes").doc(id), c));
    for (const { id, ...f } of p.faturas) operacoes.push((b) => b.set(usuario.collection("faturas").doc(id), f));
    for (const { id, ...c } of p.compras) operacoes.push((b) => b.set(usuario.collection("compras").doc(id), c));
  }
  // Os documentos dos usuários vão por último: se algo falhar no meio, rodar de novo refaz tudo
  // (as escritas acima são idempotentes) e o usuário só "existe" quando os dados dele estão completos.
  for (const p of planos) operacoes.push((b) => b.set(db.collection(fs.COLECAO_USUARIOS).doc(p.id), p.usuario));

  for (let i = 0; i < operacoes.length; i += 400) {
    const batch = db.batch();
    for (const op of operacoes.slice(i, i + 400)) op(batch);
    await batch.commit();
    console.log(`gravadas ${Math.min(i + 400, operacoes.length)}/${operacoes.length} operações`);
  }
  console.log("\nMigração concluída.");
}

await sql.end();
