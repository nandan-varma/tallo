// The Worker runs `node:async_hooks` under nodejs_compat. The API's types are the Workers types only (no @types/node),
// so this declares the one class the meter uses: AsyncLocalStorage, which carries a request's cost (see meter.ts).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
