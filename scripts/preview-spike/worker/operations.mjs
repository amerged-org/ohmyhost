/* global crypto */
const PREFIX = "operation/";

export class EditRejected extends Error {
  constructor() {
    super("edit_rejected");
  }
}

/** A record without a returned backup identity is never proof that no object was created. */
export class OperationJournal {
  constructor(storage) {
    this.storage = storage;
    this.active = new Set();
  }

  async entries() {
    return [...(await this.storage.list({ prefix: PREFIX })).values()];
  }

  async begin(kind, fields = {}) {
    if (kind !== "backup-delete" && (await this.entries()).length >= 128)
      throw new Error("operation_journal_full");
    const operation = {
      id: crypto.randomUUID(),
      kind,
      state: "intent",
      at: new Date().toISOString(),
      ...fields,
    };
    await this.put(operation);
    this.active.add(operation.id);
    return operation;
  }

  async put(operation) {
    await this.storage.put(`${PREFIX}${operation.id}`, operation);
  }

  async finish(operation, state, fields = {}) {
    const next = { ...operation, ...fields, state };
    try {
      await this.put(next);
    } finally {
      this.active.delete(operation.id);
    }
    return next;
  }

  async blocking() {
    return (await this.entries()).filter(
      (entry) =>
        entry.kind !== "backup-delete" &&
        ((entry.kind === "backup-create" && entry.state === "created") ||
          entry.state === "unknown" ||
          (entry.state === "intent" && !this.active.has(entry.id))),
    );
  }

  async assertSettled() {
    if ((await this.blocking()).length) throw new Error("operation_reconciliation_required");
  }

  async summary() {
    return (await this.entries()).map(
      ({ id, kind, state, at, name, path, generation, record }) => ({
        id,
        kind,
        state,
        at,
        ...(name ? { name } : {}),
        ...(path ? { path } : {}),
        ...(generation === undefined ? {} : { generation }),
        ...(record ? { recordId: record.id } : {}),
      }),
    );
  }
}
