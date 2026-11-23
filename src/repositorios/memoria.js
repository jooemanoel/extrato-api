// Repositório em memória, com a mesma interface do Firestore.
// Usado nos testes e em "npm run dev:memoria" (testar o front-end sem credenciais).
// Os dados somem quando o processo termina.
import { randomBytes } from "node:crypto";
import { ErroHttp } from "../validacao.js";
import { normalizar } from "../dominio/estabelecimento.js";

const copiar = (valor) => structuredClone(valor);
const porDataDesc = (a, b) => b.data.localeCompare(a.data) || a.id.localeCompare(b.id);
const novoId = () => randomBytes(15).toString("base64url").replace(/[-_]/g, "x").slice(0, 20);

// Relógio que nunca repete nem volta: duas gravações no mesmo milissegundo (comum nos testes)
// ganham horários diferentes, como aconteceria no Firestore real com requisições separadas.
let ultimoInstante = 0;
function agora() {
  ultimoInstante = Math.max(Date.now(), ultimoInstante + 1);
  return new Date(ultimoInstante).toISOString();
}

export function criarRepositorioMemoria() {
  const usuarios = new Map(); // id -> { id, nome, senhaHash, criadoEm }
  const dados = new Map(); // usuarioId -> { cartoes, faturas, compras } (Maps)
  const lojas = new Map(); // id -> loja
  const ignorados = new Map(); // estabelecimento -> { estabelecimento, ignoradoPor, em }
  const exclusoesDeLojas = []; // [{ tipo: "loja", id, em }]

  const doUsuario = (id) => {
    if (!dados.has(id)) dados.set(id, { cartoes: new Map(), faturas: new Map(), compras: new Map(), exclusoes: [] });
    return dados.get(id);
  };

  /** Soma `valor` e `quantidade` ao total de uma fatura (equivale ao FieldValue.increment). */
  const incrementar = (u, faturaId, valor, quantidade) => {
    const fatura = doUsuario(u).faturas.get(faturaId);
    if (!fatura) return;
    fatura.totalCompras = (fatura.totalCompras ?? 0) + valor;
    fatura.quantidade = (fatura.quantidade ?? 0) + quantidade;
    fatura.atualizadoEm = agora();
  };
  const marcarExclusao = (lista, tipo, id) => lista.push({ tipo, id, em: agora() });
  const desde = (lista, campo, instante) => lista.filter((x) => !instante || (x[campo] && x[campo] > instante)).map(copiar);

  const nomeEmUso = (nome, excetoId) =>
    [...lojas.values()].some((l) => l.id !== excetoId && l.nomeNormalizado === normalizar(nome));

  return {
    // ---------- usuários ----------
    async buscarUsuario(id) {
      return usuarios.has(id) ? copiar(usuarios.get(id)) : null;
    },
    async criarUsuario({ id, nome, senhaHash }) {
      if (usuarios.has(id)) return false;
      usuarios.set(id, { id, nome, senhaHash, criadoEm: new Date().toISOString() });
      return true;
    },
    async listarUsuarioIds() {
      return [...usuarios.keys()];
    },

    // ---------- cartões ----------
    async listarCartoes(u) {
      return [...doUsuario(u).cartoes.values()].sort((a, b) => a.nome.localeCompare(b.nome)).map(copiar);
    },
    async alterarCartao(u, id, campos) {
      const cartao = doUsuario(u).cartoes.get(id);
      if (!cartao) return null;
      Object.assign(cartao, campos, { atualizadoEm: agora() });
      return copiar(cartao);
    },

    // ---------- faturas ----------
    async listarFaturas(u) {
      return [...doUsuario(u).faturas.values()]
        .sort((a, b) => b.competencia.localeCompare(a.competencia) || a.cartaoId.localeCompare(b.cartaoId))
        .map(copiar);
    },
    async buscarFatura(u, id) {
      const fatura = doUsuario(u).faturas.get(id);
      return fatura ? copiar(fatura) : null;
    },
    async excluirFatura(u, id) {
      const { faturas, compras, exclusoes } = doUsuario(u);
      if (!faturas.delete(id)) return false;
      for (const [cid, c] of compras) if (c.faturaId === id) compras.delete(cid);
      marcarExclusao(exclusoes, "fatura", id);
      return true;
    },

    // ---------- compras ----------
    async listarComprasDaFatura(u, faturaId) {
      return [...doUsuario(u).compras.values()].filter((c) => c.faturaId === faturaId).sort(porDataDesc).map(copiar);
    },
    async buscarCompra(u, id) {
      const compra = doUsuario(u).compras.get(id);
      return compra ? copiar(compra) : null;
    },
    async criarCompra(u, compra) {
      const { faturas, compras } = doUsuario(u);
      if (compra.id && compras.has(compra.id)) return copiar(compras.get(compra.id));
      if (!faturas.has(compra.faturaId)) return null;
      const nova = { ...copiar(compra), id: compra.id ?? novoId(), atualizadoEm: agora() };
      compras.set(nova.id, nova);
      incrementar(u, nova.faturaId, nova.valor, 1);
      return copiar(nova);
    },
    async alterarCompra(u, id, alterar) {
      const { compras } = doUsuario(u);
      const atual = compras.get(id);
      if (!atual) return null;
      const nova = { ...atual, ...alterar(copiar(atual)), atualizadoEm: agora() };
      compras.set(id, nova);
      incrementar(u, nova.faturaId, nova.valor - atual.valor, 0);
      return copiar(nova);
    },
    async excluirCompra(u, id) {
      const { compras, exclusoes } = doUsuario(u);
      const atual = compras.get(id);
      if (!atual) return null;
      compras.delete(id);
      marcarExclusao(exclusoes, "compra", id);
      incrementar(u, atual.faturaId, -atual.valor, -1);
      return copiar(atual);
    },
    async comprasPendentes(u) {
      return [...doUsuario(u).compras.values()].filter((c) => c.pendente).map(copiar);
    },
    async contarPendentes(u) {
      return [...doUsuario(u).compras.values()].filter((c) => c.pendente).length;
    },
    async comprasPorLoja(u, lojaId) {
      return [...doUsuario(u).compras.values()].filter((c) => c.lojaId === lojaId).map(copiar);
    },
    async comprasPorPrefixo(u, prefixo) {
      return [...doUsuario(u).compras.values()].filter((c) => c.estabelecimento.startsWith(prefixo)).map(copiar);
    },
    async comprasPorEstabelecimentos(u, lista) {
      const alvo = new Set(lista);
      return [...doUsuario(u).compras.values()].filter((c) => alvo.has(c.estabelecimento)).map(copiar);
    },
    async atualizarCompras(u, mudancas) {
      const { compras } = doUsuario(u);
      for (const { id, ...campos } of mudancas) {
        if (compras.has(id)) Object.assign(compras.get(id), copiar(campos), { atualizadoEm: agora() });
      }
    },

    // ---------- importação ----------
    async importar(u, chaves, planejar, { gravar }) {
      const d = doUsuario(u);
      const existentes = new Map();
      for (const id of chaves.compraIds) if (d.compras.has(id)) existentes.set(id, copiar(d.compras.get(id)));
      const plano = planejar({
        cartao: d.cartoes.has(chaves.cartaoId) ? copiar(d.cartoes.get(chaves.cartaoId)) : null,
        fatura: d.faturas.has(chaves.faturaId) ? copiar(d.faturas.get(chaves.faturaId)) : null,
        faturaAnterior: d.faturas.has(chaves.faturaAnteriorId) ? copiar(d.faturas.get(chaves.faturaAnteriorId)) : null,
        existentes,
        daFatura: [...d.compras.values()].filter((c) => c.faturaId === chaves.faturaId).map(copiar),
      });
      if (!gravar) return plano;

      const e = plano.escritas;
      if (e.cartao) d.cartoes.set(e.cartao.id, { ...copiar(e.cartao), atualizadoEm: agora() });
      for (const { id } of e.remover) {
        d.compras.delete(id);
        marcarExclusao(d.exclusoes, "compra", id);
      }
      for (const m of e.mover) {
        Object.assign(d.compras.get(m.id), { faturaId: m.faturaId, atualizadoEm: agora() });
        incrementar(u, m.deFaturaId, -m.valor, -1);
      }
      for (const c of e.criar) d.compras.set(c.id, { ...copiar(c), atualizadoEm: agora() });
      d.faturas.set(e.fatura.id, { ...copiar(e.fatura), atualizadoEm: agora() });
      if (e.pagamento) {
        Object.assign(d.faturas.get(e.pagamento.faturaId), { pagamento: copiar(e.pagamento.pagamento), atualizadoEm: agora() });
      }
      return plano;
    },

    // ---------- lojas (compartilhadas) ----------
    async listarLojas() {
      return [...lojas.values()].sort((a, b) => a.nome.localeCompare(b.nome)).map(copiar);
    },
    async buscarLoja(id) {
      return lojas.has(id) ? copiar(lojas.get(id)) : null;
    },
    async criarLoja(loja) {
      if (nomeEmUso(loja.nome)) return null;
      const nova = { ...copiar(loja), id: novoId(), nomeNormalizado: normalizar(loja.nome), atualizadoEm: agora() };
      lojas.set(nova.id, nova);
      return copiar(nova);
    },
    async alterarLoja(id, alterar) {
      const atual = lojas.get(id);
      if (!atual) return null;
      const nova = { ...atual, ...alterar(copiar(atual)) };
      if (nomeEmUso(nova.nome, id)) throw new ErroHttp(409, `Já existe uma loja chamada ${nova.nome}`);
      nova.nomeNormalizado = normalizar(nova.nome);
      nova.atualizadoEm = agora();
      lojas.set(id, nova);
      return copiar(nova);
    },
    async excluirLoja(id) {
      const atual = lojas.get(id);
      if (!atual) return null;
      lojas.delete(id);
      marcarExclusao(exclusoesDeLojas, "loja", id);
      return copiar(atual);
    },

    // ---------- sincronização com o aparelho ----------
    async mudancas(u, instante = null) {
      const d = doUsuario(u);
      return {
        cartoes: desde([...d.cartoes.values()], "atualizadoEm", instante),
        faturas: desde([...d.faturas.values()], "atualizadoEm", instante),
        compras: desde([...d.compras.values()], "atualizadoEm", instante),
        lojas: desde([...lojas.values()], "atualizadoEm", instante),
        exclusoes: instante ? desde([...d.exclusoes, ...exclusoesDeLojas], "em", instante) : [],
      };
    },

    // ---------- estabelecimentos ignorados (compartilhados) ----------
    async listarIgnorados() {
      return [...ignorados.values()].map(copiar);
    },
    async ignorar(registro) {
      if (ignorados.has(registro.estabelecimento)) return false;
      ignorados.set(registro.estabelecimento, copiar(registro));
      return true;
    },
    async desfazerIgnorado(estabelecimento) {
      return ignorados.delete(estabelecimento);
    },
  };
}
