// Formato das compras nas respostas: a loja e a categoria vêm resolvidas.
// A categoria não é gravada na compra: é sempre a da loja (mudar a categoria da loja muda todas).

export function apresentadorDeCompras(lojas) {
  const porId = new Map(lojas.map((l) => [l.id, l]));
  return (compra) => {
    const loja = compra.lojaId ? porId.get(compra.lojaId) : null;
    return {
      ...compra,
      loja: loja ? { id: loja.id, nome: loja.nome } : null,
      categoria: loja?.categoria ?? null,
    };
  };
}
