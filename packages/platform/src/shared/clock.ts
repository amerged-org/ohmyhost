export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  readonly #timestamp: number;

  constructor(value: Date | string | number) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("Fixed clock requires a valid date");
    }
    this.#timestamp = timestamp;
  }

  now(): Date {
    return new Date(this.#timestamp);
  }
}
