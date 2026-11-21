// Acesso ao Firestore pelo SDK de administrador (firebase-admin), que só roda no servidor.
// As regras do Firestore bloqueiam todo acesso direto do navegador.
//
// Estrutura (detalhes em docs/MODELAGEM.md):
//   extrato_usuarios/{NOME}                     { nome, senhaHash, criadoEm }
//   extrato_usuarios/{NOME}/cartoes/{id}        { nome, numero, criadoEm }
//   extrato_usuarios/{NOME}/faturas/{id}        { cartaoId, competencia, situacao, totais, pagamento, importacoes }
//   extrato_usuarios/{NOME}/compras/{id}        { cartaoId, faturaId, data, valor, estabelecimento, lojaId, ... }
//   extrato_lojas/{id}                          { nome, nomeNormalizado, categoria, padroes } (compartilhadas)
//   extrato_ignorados/{estabelecimento}         { ignoradoPor, em } (compartilhados)
//
// Datas são gravadas como texto ISO ("2026-11-21T12:00:00.000Z") e datas de compra como "AAAA-MM-DD".
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { ErroHttp } from "../validacao.js";
import { normalizar } from "../dominio/estabelecimento.js";

export const COLECAO_USUARIOS = "extrato_usuarios";
export const COLECAO_LOJAS = "extrato_lojas";
export const COLECAO_IGNORADOS = "extrato_ignorados";

// Limite de escritas numa transação do Firestore (500), com folga.
const MAXIMO_ESCRITAS = 480;
// Consultas "in" aceitam até 30 valores.
const LOTE_IN = 30;
// As lojas são lidas a cada importação e listagem; um cache curto poupa leituras.
// Escritas feitas nesta instância limpam o cache; as de outra instância aparecem em até 1 minuto.
const VALIDADE_CACHE_LOJAS = 60_000;

export function conectarFirestore() {
  if (!getApps().length) {
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
    initializeApp({
      projectId: FIREBASE_PROJECT_ID,
      // Sem a chave nas variáveis, usa GOOGLE_APPLICATION_CREDENTIALS (arquivo JSON local).
      credential: FIREBASE_PRIVATE_KEY
        ? cert({
            projectId: FIREBASE_PROJECT_ID,
            clientEmail: FIREBASE_CLIENT_EMAIL,
            // Na Vercel e no .env as quebras de linha chegam como "\n" literal.
            privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          })
        : applicationDefault(),
    });
  }
  return getFirestore();
}

const comId = (snap) => ({ ...snap.data(), id: snap.id });
const porDataDesc = (a, b) => b.data.localeCompare(a.data) || a.id.localeCompare(b.id);

function emLotes(lista, tamanho) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

export function criarRepositorioFirestore(db = conectarFirestore()) {
  const usuarios = db.collection(COLECAO_USUARIOS);
  const colLojas = db.collection(COLECAO_LOJAS);
  const colIgnorados = db.collection(COLECAO_IGNORADOS);
  const cartoes = (u) => usuarios.doc(u).collection("cartoes");
  const faturas = (u) => usuarios.doc(u).collection("faturas");
  const compras = (u) => usuarios.doc(u).collection("compras");

  let cacheLojas = null; // { em, lojas }
  const limparCache = () => {
    cacheLojas = null;
  };

  const incremento = (valor, quantidade) => ({
    totalCompras: FieldValue.increment(valor),
    quantidade: FieldValue.increment(quantidade),
  });

  /** Grava em lotes de até 500 operações (fora de transação). */
  async function gravarEmLotes(operacoes) {
    for (const lote of emLotes(operacoes, MAXIMO_ESCRITAS)) {
      const batch = db.batch();
      for (const op of lote) op(batch);
      await batch.commit();
    }
  }

  return {
    // ---------- usuários ----------
    async buscarUsuario(id) {
      const snap = await usuarios.doc(id).get();
      return snap.exists ? comId(snap) : null;
    },

    /** Cria o usuário; devolve false se o nome já existir (create() é atômico). */
    async criarUsuario({ id, nome, senhaHash }) {
      try {
        await usuarios.doc(id).create({ nome, senhaHash, criadoEm: new Date().toISOString() });
        return true;
      } catch (erro) {
        if (erro.code === 6) return false; // ALREADY_EXISTS
        throw erro;
      }
    },

    async listarUsuarioIds() {
      const snap = await usuarios.select().get();
      return snap.docs.map((d) => d.id);
    },

    // ---------- cartões ----------
    async listarCartoes(u) {
      const snap = await cartoes(u).get();
      return snap.docs.map(comId).sort((a, b) => a.nome.localeCompare(b.nome));
    },

    async alterarCartao(u, id, campos) {
      const ref = cartoes(u).doc(id);
      return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return null;
        t.update(ref, campos);
        return { ...comId(snap), ...campos };
      });
    },

    // ---------- faturas ----------
    async listarFaturas(u) {
      const snap = await faturas(u).get();
      return snap.docs
        .map(comId)
        .sort((a, b) => b.competencia.localeCompare(a.competencia) || a.cartaoId.localeCompare(b.cartaoId));
    },

    async buscarFatura(u, id) {
      const snap = await faturas(u).doc(id).get();
      return snap.exists ? comId(snap) : null;
    },

    async excluirFatura(u, id) {
      const ref = faturas(u).doc(id);
      if (!(await ref.get()).exists) return false;
      const doFatura = await compras(u).where("faturaId", "==", id).select().get();
      await gravarEmLotes([...doFatura.docs.map((d) => (b) => b.delete(d.ref)), (b) => b.delete(ref)]);
      return true;
    },

    // ---------- compras ----------
    async listarComprasDaFatura(u, faturaId) {
      const snap = await compras(u).where("faturaId", "==", faturaId).get();
      return snap.docs.map(comId).sort(porDataDesc);
    },

    async buscarCompra(u, id) {
      const snap = await compras(u).doc(id).get();
      return snap.exists ? comId(snap) : null;
    },

    /** Compra manual: id gerado pelo Firestore; soma no total da fatura. null se a fatura não existe. */
    async criarCompra(u, compra) {
      const refFatura = faturas(u).doc(compra.faturaId);
      const ref = compras(u).doc();
      return db.runTransaction(async (t) => {
        if (!(await t.get(refFatura)).exists) return null;
        const { id, ...dados } = compra;
        t.create(ref, dados);
        t.update(refFatura, incremento(compra.valor, 1));
        return { ...dados, id: ref.id };
      });
    },

    /** `alterar(atual)` devolve os campos novos. Ajusta o total da fatura se o valor mudou. */
    async alterarCompra(u, id, alterar) {
      const ref = compras(u).doc(id);
      return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return null;
        const atual = comId(snap);
        const campos = alterar(structuredClone(atual));
        const nova = { ...atual, ...campos };
        t.update(ref, campos);
        if (nova.valor !== atual.valor) {
          t.update(faturas(u).doc(atual.faturaId), incremento(nova.valor - atual.valor, 0));
        }
        return nova;
      });
    },

    async excluirCompra(u, id) {
      const ref = compras(u).doc(id);
      return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return null;
        const atual = comId(snap);
        const refFatura = faturas(u).doc(atual.faturaId);
        const fatura = await t.get(refFatura);
        t.delete(ref);
        if (fatura.exists) t.update(refFatura, incremento(-atual.valor, -1));
        return atual;
      });
    },

    async comprasPendentes(u) {
      const snap = await compras(u).where("pendente", "==", true).get();
      return snap.docs.map(comId);
    },

    async comprasPorLoja(u, lojaId) {
      const snap = await compras(u).where("lojaId", "==", lojaId).get();
      return snap.docs.map(comId);
    },

    /** Compras cujo estabelecimento começa com `prefixo` (intervalo no índice automático). */
    async comprasPorPrefixo(u, prefixo) {
      const snap = await compras(u)
        .where("estabelecimento", ">=", prefixo)
        .where("estabelecimento", "<", `${prefixo}`)
        .get();
      return snap.docs.map(comId);
    },

    async comprasPorEstabelecimentos(u, lista) {
      const resultado = [];
      for (const lote of emLotes([...new Set(lista)], LOTE_IN)) {
        const snap = await compras(u).where("estabelecimento", "in", lote).get();
        resultado.push(...snap.docs.map(comId));
      }
      return resultado;
    },

    async atualizarCompras(u, mudancas) {
      await gravarEmLotes(
        mudancas.map(({ id, ...campos }) => (b) => b.update(compras(u).doc(id), campos))
      );
    },

    // ---------- importação ----------
    /**
     * Lê cartão, fatura, fatura anterior, as compras do arquivo que já existem e as compras
     * da fatura; chama `planejar` e, com `gravar`, aplica o plano numa transação
     * (duas importações simultâneas do mesmo arquivo não duplicam nada).
     */
    async importar(u, chaves, planejar, { gravar }) {
      const executar = async (t) => {
        const ler = (alvo) => (t ? t.get(alvo) : alvo.get());
        const lerVarios = async (refs) => {
          if (!refs.length) return [];
          return t ? t.getAll(...refs) : db.getAll(...refs);
        };

        const [cartao, fatura, faturaAnterior] = await lerVarios([
          cartoes(u).doc(chaves.cartaoId),
          faturas(u).doc(chaves.faturaId),
          faturas(u).doc(chaves.faturaAnteriorId),
        ]);
        const snaps = await lerVarios(chaves.compraIds.map((id) => compras(u).doc(id)));
        const existentes = new Map(snaps.filter((s) => s.exists).map((s) => [s.id, comId(s)]));
        const daFatura = (await ler(compras(u).where("faturaId", "==", chaves.faturaId))).docs.map(comId);

        const plano = planejar({
          cartao: cartao.exists ? comId(cartao) : null,
          fatura: fatura.exists ? comId(fatura) : null,
          faturaAnterior: faturaAnterior.exists ? comId(faturaAnterior) : null,
          existentes,
          daFatura,
        });
        if (!t) return plano;

        const e = plano.escritas;
        const decrementos = new Map(); // faturaId -> { valor, quantidade } das compras movidas
        for (const m of e.mover) {
          const d = decrementos.get(m.deFaturaId) ?? { valor: 0, quantidade: 0 };
          d.valor -= m.valor;
          d.quantidade -= 1;
          decrementos.set(m.deFaturaId, d);
        }
        const escritas = 1 + e.criar.length + e.mover.length + e.remover.length + decrementos.size + (e.cartao ? 1 : 0) + (e.pagamento ? 1 : 0);
        if (escritas > MAXIMO_ESCRITAS) {
          throw new ErroHttp(413, `Arquivo grande demais para uma importação (${escritas} alterações; máximo ${MAXIMO_ESCRITAS})`);
        }

        if (e.cartao) {
          const { id, ...dados } = e.cartao;
          t.set(cartoes(u).doc(id), dados, { merge: true });
        }
        for (const { id } of e.remover) t.delete(compras(u).doc(id));
        for (const m of e.mover) t.update(compras(u).doc(m.id), { faturaId: m.faturaId });
        for (const [faturaId, d] of decrementos) {
          t.update(faturas(u).doc(faturaId), incremento(d.valor, d.quantidade));
        }
        for (const { id, ...dados } of e.criar) t.create(compras(u).doc(id), dados);
        const { id: faturaId, ...dadosFatura } = e.fatura;
        t.set(faturas(u).doc(faturaId), dadosFatura);
        if (e.pagamento) t.update(faturas(u).doc(e.pagamento.faturaId), { pagamento: e.pagamento.pagamento });
        return plano;
      };

      return gravar ? db.runTransaction(executar) : executar(null);
    },

    // ---------- lojas (compartilhadas) ----------
    async listarLojas() {
      if (cacheLojas && Date.now() - cacheLojas.em < VALIDADE_CACHE_LOJAS) return structuredClone(cacheLojas.lojas);
      const snap = await colLojas.get();
      const lista = snap.docs.map(comId).sort((a, b) => a.nome.localeCompare(b.nome));
      cacheLojas = { em: Date.now(), lojas: lista };
      return structuredClone(lista);
    },

    async buscarLoja(id) {
      const snap = await colLojas.doc(id).get();
      return snap.exists ? comId(snap) : null;
    },

    /** Cria a loja; null se o nome (sem acento, maiúsculas) já estiver em uso. */
    async criarLoja(loja) {
      const nomeNormalizado = normalizar(loja.nome);
      const ref = colLojas.doc();
      const criada = await db.runTransaction(async (t) => {
        const iguais = await t.get(colLojas.where("nomeNormalizado", "==", nomeNormalizado).limit(1));
        if (!iguais.empty) return null;
        const { id, ...dados } = { ...loja, nomeNormalizado };
        t.create(ref, dados);
        return { ...dados, id: ref.id };
      });
      limparCache();
      return criada;
    },

    async alterarLoja(id, alterar) {
      const ref = colLojas.doc(id);
      const alterada = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return null;
        const atual = comId(snap);
        const nova = { ...atual, ...alterar(structuredClone(atual)) };
        nova.nomeNormalizado = normalizar(nova.nome);
        if (nova.nomeNormalizado !== atual.nomeNormalizado) {
          const iguais = await t.get(colLojas.where("nomeNormalizado", "==", nova.nomeNormalizado).limit(2));
          if (iguais.docs.some((d) => d.id !== id)) throw new ErroHttp(409, `Já existe uma loja chamada ${nova.nome}`);
        }
        const { id: _, ...dados } = nova;
        t.set(ref, dados);
        return nova;
      });
      limparCache();
      return alterada;
    },

    async excluirLoja(id) {
      const ref = colLojas.doc(id);
      const excluida = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return null;
        t.delete(ref);
        return comId(snap);
      });
      limparCache();
      return excluida;
    },

    // ---------- estabelecimentos ignorados (compartilhados) ----------
    async listarIgnorados() {
      const snap = await colIgnorados.get();
      return snap.docs.map((d) => ({ ...d.data(), estabelecimento: d.id }));
    },

    async ignorar({ estabelecimento, ...dados }) {
      try {
        await colIgnorados.doc(estabelecimento).create(dados);
        return true;
      } catch (erro) {
        if (erro.code === 6) return false; // ALREADY_EXISTS
        throw erro;
      }
    },

    async desfazerIgnorado(estabelecimento) {
      const ref = colIgnorados.doc(estabelecimento);
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    },
  };
}
