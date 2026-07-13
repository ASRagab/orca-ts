const reservations = new WeakMap<object, symbol>();

export function reserveConversationSettlement(conversation: object): () => void {
  const token = Symbol("conversation settlement reservation");
  reservations.set(conversation, token);
  return () => {
    if (reservations.get(conversation) === token) {
      reservations.delete(conversation);
    }
  };
}

export function isConversationSettlementReserved(conversation: object): boolean {
  return reservations.has(conversation);
}
