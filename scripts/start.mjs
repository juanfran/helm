const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const host = process.env.HOST ?? "127.0.0.1";

if (!loopbackHosts.has(host) && process.env.HELM_UNSAFE_ALLOW_REMOTE !== "1") {
  throw new Error(
    "Refusing to expose Helm outside this machine. Set HELM_UNSAFE_ALLOW_REMOTE=1 to acknowledge the risk.",
  );
}

process.env.HOST = host;

await import("../.output/server/index.mjs");
