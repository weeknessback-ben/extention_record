// Stands in for `wxt/browser` in the server bundle: lib/ imports it, but only extension code calls it.
export const browser: never = new Proxy({} as never, {
  get() {
    throw new Error('Browser extension APIs are not available on the server');
  },
});
