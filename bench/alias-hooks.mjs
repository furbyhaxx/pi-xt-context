// Resolve the two pi packages to the vitest stubs so the benchmark can drive
// index.ts under plain node (pi aliases them at runtime; node cannot).
const STUBS = {
  "@earendil-works/pi-tui": new URL("../test/pi-tui-stub.ts", import.meta.url).href,
  "@earendil-works/pi-coding-agent": new URL(
    "../test/pi-coding-agent-stub.ts",
    import.meta.url,
  ).href,
};

export function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
