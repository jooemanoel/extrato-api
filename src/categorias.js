// Categorias fixas. A categoria de uma compra é sempre a da loja dela
// (decisão de negócio: uma loja que vende de tudo, como a Americanas, fica numa categoria só).
// O código numérico é o do Supabase antigo, usado só na migração.

export const CATEGORIAS = [
  { id: "mercado", nome: "MERCADO", icone: "shopping_cart", codigoAntigo: 1 },
  { id: "saude", nome: "SAÚDE", icone: "local_hospital", codigoAntigo: 2 },
  { id: "transporte", nome: "TRANSPORTE", icone: "directions_bus", codigoAntigo: 3 },
  { id: "lazer", nome: "LAZER", icone: "mood", codigoAntigo: 4 },
  { id: "variedades", nome: "VARIEDADES", icone: "shopping_bag", codigoAntigo: 5 },
  { id: "educacao", nome: "EDUCAÇÃO", icone: "school", codigoAntigo: 6 },
  { id: "internet", nome: "INTERNET", icone: "wifi", codigoAntigo: 7 },
];

const IDS = new Set(CATEGORIAS.map((c) => c.id));

export const categoriaValida = (id) => IDS.has(id);

export const categoriaPorCodigoAntigo = (codigo) =>
  CATEGORIAS.find((c) => c.codigoAntigo === codigo)?.id ?? null;
