# Helm

Helm is a local control plane for one developer and many coding agents. It keeps work discoverable, claimable, reviewable, and auditable through a human interface and MCP.

The project is in its foundation phase. Product behavior is specified in [docs/product.md](docs/product.md).

## Run locally

Requirements: Node.js 22.12+ and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Production build

```sh
pnpm build
pnpm start
```

`./start.sh` builds first when needed, then starts the local server.

## Checks

```sh
pnpm check
pnpm build
```

See [docs/architecture.md](docs/architecture.md) for system boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before changing the project.