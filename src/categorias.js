// Categorias fixas. A categoria de uma compra é sempre a da loja dela
// (decisão de negócio: uma loja que vende de tudo, como a Americanas, fica numa categoria só).

export const CATEGORIAS = [
  { id: "mercado", nome: "MERCADO", icone: "shopping_cart" },
  { id: "restaurante", nome: "RESTAURANTE", icone: "restaurant" },
  { id: "saude", nome: "SAÚDE", icone: "local_hospital" },
  { id: "transporte", nome: "TRANSPORTE", icone: "directions_bus" },
  { id: "lazer", nome: "LAZER", icone: "mood" },
  { id: "variedades", nome: "VARIEDADES", icone: "shopping_bag" },
  { id: "educacao", nome: "EDUCAÇÃO", icone: "school" },
  { id: "internet", nome: "INTERNET", icone: "wifi" },
];

const IDS = new Set(CATEGORIAS.map((c) => c.id));

export const categoriaValida = (id) => IDS.has(id);
