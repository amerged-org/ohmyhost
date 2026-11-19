import { randomFillSync } from "node:crypto";

export interface EntropySource {
  fill(target: Uint8Array): void;
}

export class SystemEntropy implements EntropySource {
  fill(target: Uint8Array): void {
    randomFillSync(target);
  }
}

export class DeterministicEntropy implements EntropySource {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError("Entropy seed must be a safe integer");
    }
    this.#state = seed >>> 0 || 0x6d2b79f5;
  }

  fill(target: Uint8Array): void {
    for (let index = 0; index < target.length; index += 1) {
      let value = this.#state;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      this.#state = value >>> 0;
      target[index] = this.#state & 0xff;
    }
  }
}
