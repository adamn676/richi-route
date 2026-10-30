// The address search running in the browser (search/wasm, built for WebAssembly): asked with the same requests as the
// search server ("/api/?q=…", "/reverse?lat=…"), it gives the same answers, without a network.

interface Exports {
  memory: WebAssembly.Memory;
  buffer(length: number): number;
  answer_at(): number;
  load(length: number): number;
  ask(length: number): number;
}

export interface OfflineSearch {
  // Photon's JSON for a request, or null for one it does not know.
  ask(request: string): unknown;
  // The memory it holds, in bytes.
  memory(): number;
}

export async function startOfflineSearch(module: BufferSource, index: Uint8Array): Promise<OfflineSearch> {
  const { instance } = await WebAssembly.instantiate(module, {});
  const search = instance.exports as unknown as Exports;
  // the module's memory may grow with each call, so its view is taken after the call
  const put = (bytes: Uint8Array) => {
    const at = search.buffer(bytes.length);
    new Uint8Array(search.memory.buffer, at, bytes.length).set(bytes);
  };
  put(index);
  if (!search.load(index.length)) throw new Error('Die Adressdaten sind beschädigt oder veraltet.');
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  return {
    ask(request) {
      const bytes = encoder.encode(request);
      put(bytes);
      const length = search.ask(bytes.length);
      if (length === 0xffffffff) return null;
      const at = search.answer_at();
      return JSON.parse(decoder.decode(new Uint8Array(search.memory.buffer, at, length)));
    },
    memory: () => search.memory.buffer.byteLength,
  };
}
