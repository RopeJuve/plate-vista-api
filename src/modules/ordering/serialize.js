const idOf = (value) => (value == null ? null : String(value));

const iso = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

export const serializeOrder = (order) => {
  const source = order?.toObject ? order.toObject() : order;
  return {
    _id: idOf(source._id),
    restaurantId: idOf(source.restaurantId),
    sessionId: idOf(source.sessionId),
    tableId: idOf(source.tableId),
    clientOrderId: source.clientOrderId,
    status: source.status,
    rev: source.rev ?? 1,
    items: (source.items || []).map((item) => ({
      productId: idOf(item.productId),
      title: item.title,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents,
      notes: item.notes || "",
      station: item.station || "kitchen",
    })),
    totalCents: source.totalCents,
    createdAt: iso(source.createdAt),
    updatedAt: iso(source.updatedAt),
  };
};

export const serializeSession = (session, tableNumber = null) => {
  const source = session?.toObject ? session.toObject() : session;
  return {
    _id: idOf(source._id),
    tableId: idOf(source.tableId),
    tableNumber: tableNumber ?? source.tableNumber ?? null,
    status: source.status,
    openedAt: iso(source.openedAt),
    closedAt: iso(source.closedAt),
  };
};
