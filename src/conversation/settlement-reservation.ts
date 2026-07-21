type SettlementKind = "success" | "cancellation" | "failure" | "cancellation_failure";

const settlementPriority: Readonly<Record<SettlementKind, number>> = {
  success: 0,
  failure: 1,
  cancellation: 2,
  cancellation_failure: 3
};

interface PendingSettlement {
  readonly kind: SettlementKind;
  readonly publish: () => void;
}

interface SettlementReservation {
  depth: number;
  pending?: PendingSettlement;
}

const reservations = new WeakMap<object, SettlementReservation>();

interface CancellationCompletion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  completed: boolean;
}

const cancellationCompletions = new WeakMap<object, CancellationCompletion>();
const cancellationFailureHandlers = new WeakMap<object, (error: unknown) => void>();

function cancellationCompletion(conversation: object): CancellationCompletion {
  const existing = cancellationCompletions.get(conversation);
  if (existing !== undefined) {
    return existing;
  }

  const deferred = Promise.withResolvers<undefined>();
  const created: CancellationCompletion = {
    promise: deferred.promise,
    resolve: () => {
      deferred.resolve(undefined);
    },
    completed: false
  };
  cancellationCompletions.set(conversation, created);
  return created;
}

export function observeConversationCancellationCompletion(
  conversation: object
): Promise<void> {
  return cancellationCompletion(conversation).promise;
}

export function markConversationCancellationComplete(conversation: object): void {
  const completion = cancellationCompletion(conversation);
  if (completion.completed) {
    return;
  }
  completion.completed = true;
  completion.resolve();
}

export function registerConversationCancellationFailureHandler(
  conversation: object,
  handler: (error: unknown) => void
): void {
  cancellationFailureHandlers.set(conversation, handler);
}

export function reportConversationCancellationFailure(
  conversation: object,
  error: unknown
): boolean {
  const handler = cancellationFailureHandlers.get(conversation);
  if (handler === undefined) {
    return false;
  }
  handler(error);
  return true;
}

export function reserveConversationSettlement(conversation: object): () => void {
  const reservation = reservations.get(conversation) ?? { depth: 0 };
  reservation.depth += 1;
  reservations.set(conversation, reservation);
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    reservation.depth -= 1;
    if (reservation.depth > 0) {
      return;
    }

    reservations.delete(conversation);
    const pending = reservation.pending;
    delete reservation.pending;
    pending?.publish();
  };
}

export function isConversationSettlementReserved(conversation: object): boolean {
  return reservations.has(conversation);
}

export function deferConversationSettlement(
  conversation: object,
  kind: SettlementKind,
  publish: () => void
): boolean {
  const reservation = reservations.get(conversation);
  if (reservation === undefined) {
    return false;
  }

  if (
    reservation.pending === undefined ||
    settlementPriority[kind] > settlementPriority[reservation.pending.kind]
  ) {
    reservation.pending = { kind, publish };
  }
  return true;
}
