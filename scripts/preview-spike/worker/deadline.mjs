/* global AbortController, setTimeout, clearTimeout */
export class PhaseDeadline extends Error {
  constructor() {
    super("phase_deadline");
  }
}

export async function bounded(work, ms) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PhaseDeadline());
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
