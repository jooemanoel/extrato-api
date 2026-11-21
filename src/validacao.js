// Regras dos dados recebidos. Tudo que vem do cliente passa por aqui antes de chegar ao banco.
import { categoriaValida } from "./categorias.js";
import { normalizar, TAMANHO_MINIMO_PADRAO } from "./dominio/estabelecimento.js";

export class ErroHttp extends Error {
  constructor(status, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

export const LIMITES = {
  nomeUsuario: { min: 3, max: 40 },
  senha: { min: 6, max: 64 }, // bcrypt só considera os primeiros 72 bytes
  nomeCartao: 60,
  nomeLoja: 60,
  padroesPorLoja: 50,
  textoPadrao: 40,
  descricao: 80,
  arquivo: 1_000_000, // caracteres; uma fatura grande tem ~25 KB
  valorMaximo: 100_000_000, // centavos (R$ 1 milhão)
};

/**
 * Mesmo formato do app antigo: maiúsculas, sem acentos, só letras e espaços.
 * O resultado também é o id do documento do usuário.
 */
export function normalizarNomeUsuario(valor) {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Nomes exibidos (lojas, cartões): espaços aparados e em maiúsculas, acentos preservados. */
export function normalizarTexto(valor) {
  return String(valor ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function texto(corpo, campo) {
  const valor = corpo?.[campo];
  if (typeof valor !== "string") throw new ErroHttp(400, `Campo "${campo}" é obrigatório`);
  return valor;
}

const presente = (corpo, campo) => corpo != null && Object.hasOwn(corpo, campo);

export function validarCredenciais(corpo, { cadastro = false } = {}) {
  const nome = normalizarNomeUsuario(texto(corpo, "nome"));
  const senha = texto(corpo, "senha");

  if (!nome) throw new ErroHttp(400, "Informe o nome de usuário");
  if (!senha) throw new ErroHttp(400, "Informe a senha");
  if (senha.length > LIMITES.senha.max) {
    throw new ErroHttp(400, `A senha deve ter no máximo ${LIMITES.senha.max} caracteres`);
  }

  // As regras de tamanho mínimo valem só no cadastro: no login, basta conferir a senha.
  if (cadastro) {
    const { min, max } = LIMITES.nomeUsuario;
    if (nome.length < min || nome.length > max) {
      throw new ErroHttp(400, `O nome deve ter entre ${min} e ${max} letras`);
    }
    if (senha.length < LIMITES.senha.min) {
      throw new ErroHttp(400, `A senha deve ter pelo menos ${LIMITES.senha.min} caracteres`);
    }
  }
  return { nome, senha };
}

export function validarNome(corpo, maximo, campo = "nome") {
  const nome = normalizarTexto(texto(corpo, campo));
  if (!nome) throw new ErroHttp(400, "Informe o nome");
  if (nome.length > maximo) throw new ErroHttp(400, `O nome deve ter no máximo ${maximo} caracteres`);
  return nome;
}

// ---------- Importação ----------

const COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validarImportacao(corpo) {
  const conteudo = texto(corpo, "conteudo");
  if (!conteudo.trim()) throw new ErroHttp(400, "O arquivo está vazio");
  if (conteudo.length > LIMITES.arquivo) throw new ErroHttp(413, "Arquivo grande demais");

  const nomeArquivo = typeof corpo.nomeArquivo === "string" ? corpo.nomeArquivo.slice(0, 200) : "";

  let competencia = null;
  if (corpo.competencia != null) {
    if (typeof corpo.competencia !== "string" || !COMPETENCIA.test(corpo.competencia)) {
      throw new ErroHttp(400, 'Campo "competencia" deve estar no formato AAAA-MM');
    }
    competencia = corpo.competencia;
  }

  if (corpo.removerAusentes != null && typeof corpo.removerAusentes !== "boolean") {
    throw new ErroHttp(400, 'Campo "removerAusentes" deve ser true ou false');
  }
  return { conteudo, nomeArquivo, competencia, removerAusentes: corpo.removerAusentes === true };
}

// ---------- Compras ----------

const DATA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validarValor(valor) {
  if (!Number.isInteger(valor) || valor === 0 || Math.abs(valor) > LIMITES.valorMaximo) {
    throw new ErroHttp(400, 'Campo "valor" deve ser um número inteiro de centavos, diferente de zero');
  }
  return valor;
}

function validarData(valor) {
  if (typeof valor !== "string" || !DATA.test(valor)) {
    throw new ErroHttp(400, 'Campo "data" deve estar no formato AAAA-MM-DD');
  }
  return valor;
}

function validarDescricao(valor, { obrigatoria = false } = {}) {
  if (valor === null && !obrigatoria) return null;
  if (typeof valor !== "string") throw new ErroHttp(400, 'Campo "descricao" inválido');
  const descricao = normalizarTexto(valor);
  if (!descricao) {
    if (obrigatoria) throw new ErroHttp(400, "Informe a descrição");
    return null;
  }
  if (descricao.length > LIMITES.descricao) {
    throw new ErroHttp(400, `A descrição deve ter no máximo ${LIMITES.descricao} caracteres`);
  }
  return descricao;
}

/** Compra digitada à mão (sem OFX). Valor negativo = gasto, positivo = estorno/crédito (como no OFX). */
export function validarNovaCompra(corpo) {
  return {
    faturaId: texto(corpo, "faturaId"),
    data: validarData(corpo.data),
    valor: validarValor(corpo.valor),
    descricao: validarDescricao(corpo.descricao, { obrigatoria: true }),
  };
}

/** Alteração de compra: só os campos presentes. `data` e `valor` só valem para compras manuais (a rota confere). */
export function validarAlteracaoCompra(corpo) {
  const campos = {};
  if (presente(corpo, "descricao")) campos.descricao = validarDescricao(corpo.descricao);
  if (presente(corpo, "lojaId")) {
    if (corpo.lojaId !== null && (typeof corpo.lojaId !== "string" || !corpo.lojaId)) {
      throw new ErroHttp(400, 'Campo "lojaId" deve ser o id de uma loja ou null');
    }
    campos.lojaId = corpo.lojaId;
  }
  if (presente(corpo, "data")) campos.data = validarData(corpo.data);
  if (presente(corpo, "valor")) campos.valor = validarValor(corpo.valor);
  if (Object.keys(campos).length === 0) throw new ErroHttp(400, "Nada para alterar");
  return campos;
}

// ---------- Lojas ----------

export function validarCategoria(valor) {
  if (valor === null) return null;
  if (typeof valor !== "string" || !categoriaValida(valor)) throw new ErroHttp(400, "Categoria inválida");
  return valor;
}

export function validarPadrao(p) {
  if (!p || typeof p !== "object") throw new ErroHttp(400, "Padrão inválido");
  const tipo = p.tipo ?? "prefixo";
  if (tipo !== "prefixo" && tipo !== "contem") throw new ErroHttp(400, 'O tipo do padrão deve ser "prefixo" ou "contem"');
  if (typeof p.texto !== "string") throw new ErroHttp(400, "Informe o texto do padrão");
  const textoPadrao = normalizar(p.texto);
  const minimo = TAMANHO_MINIMO_PADRAO[tipo];
  if (textoPadrao.length < minimo) {
    throw new ErroHttp(400, `O padrão "${p.texto}" precisa de pelo menos ${minimo} letras ou números`);
  }
  if (textoPadrao.length > LIMITES.textoPadrao) throw new ErroHttp(400, "Padrão longo demais");
  return { tipo, texto: textoPadrao };
}

export function validarPadroes(lista) {
  if (!Array.isArray(lista)) throw new ErroHttp(400, 'Campo "padroes" deve ser uma lista');
  if (lista.length > LIMITES.padroesPorLoja) throw new ErroHttp(400, `No máximo ${LIMITES.padroesPorLoja} padrões por loja`);
  const vistos = new Set();
  return lista.map(validarPadrao).filter((p) => {
    const chave = `${p.tipo}:${p.texto}`;
    return !vistos.has(chave) && vistos.add(chave);
  });
}

/**
 * Nova loja: { nome, categoria, padroes? , estabelecimento? }.
 * Sem `padroes`, o padrão sai do `estabelecimento` da compra de onde a loja foi criada
 * (a rota usa sugerirPadrao, que respeita o nome que o usuário escolheu).
 */
export function validarNovaLoja(corpo) {
  const nome = validarNome(corpo, LIMITES.nomeLoja);
  const categoria = validarCategoria(corpo.categoria ?? null);
  const padroes = presente(corpo, "padroes") ? validarPadroes(corpo.padroes) : null;
  const estabelecimento = typeof corpo.estabelecimento === "string" ? normalizar(corpo.estabelecimento) : null;
  if (!padroes?.length && !estabelecimento) {
    throw new ErroHttp(400, 'Informe "padroes" ou o "estabelecimento" de uma compra');
  }
  return { nome, categoria, padroes, estabelecimento };
}

export function validarAlteracaoLoja(corpo) {
  const campos = {};
  if (presente(corpo, "nome")) campos.nome = validarNome(corpo, LIMITES.nomeLoja);
  if (presente(corpo, "categoria")) campos.categoria = validarCategoria(corpo.categoria);
  if (presente(corpo, "padroes")) {
    campos.padroes = validarPadroes(corpo.padroes);
    if (campos.padroes.length === 0) throw new ErroHttp(400, "A loja precisa de pelo menos um padrão");
  }
  if (Object.keys(campos).length === 0) throw new ErroHttp(400, "Nada para alterar");
  return campos;
}

export function validarEstabelecimento(valor) {
  const estabelecimento = normalizar(valor);
  if (!estabelecimento) throw new ErroHttp(400, "Estabelecimento inválido");
  return estabelecimento;
}
