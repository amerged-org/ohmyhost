/** The part of the D1 binding the store depends on; a Miniflare D1 and a production D1 both satisfy it. */
export interface D1Meta {
  readonly changes: number;
}

export interface D1Result<Row = Record<string, unknown>> {
  readonly results: Row[];
  readonly success: boolean;
  readonly meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
