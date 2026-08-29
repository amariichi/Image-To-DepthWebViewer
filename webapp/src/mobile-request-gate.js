export function createLatestRequestGate() {
  let generation = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      return { generation, signal: controller.signal };
    },
    isCurrent(candidate) {
      return candidate === generation && !controller?.signal.aborted;
    },
    cancel() {
      controller?.abort();
      controller = null;
      generation += 1;
    },
    generation() {
      return generation;
    },
  };
}
