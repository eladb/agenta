// Sandbox provider abstraction. Two concrete implementations:
//   - docker.ts — local Docker container, current default for dev.
//   - fly.ts    — per-thread Fly machine, used when SANDBOX_PROVIDER=fly.
//
// The public API (runBash / readFile / writeFile / …) is provider-agnostic:
// callers ask the configured provider for an endpoint (baseUrl + headers)
// and then make plain fetch() calls. The provider owns lifecycle + routing.

export type SandboxEndpoint = {
  baseUrl: string;
  // Headers that must be present on every request to this endpoint. At
  // minimum: Authorization. Fly adds fly-force-instance-id so requests land
  // on the right machine instead of being round-robined across the app.
  headers: Record<string, string>;
};

export type SandboxProvider = {
  // Human-readable name, used in logs.
  name: string;
  // Idempotent: ensures the thread has a running sandbox ready for HTTP
  // calls. Blocks until /health responds.
  ensure(threadKey: string): Promise<void>;
  // Synchronous, cheap. True iff `ensure` has succeeded in this process for
  // this thread (and removeContainer hasn't been called since). Used by the
  // turn loop to decide whether to show the "provisioning workspace…" UI
  // before a sandbox-touching tool runs.
  isReady(threadKey: string): boolean;
  // Returns baseUrl + auth/routing headers for the thread's sandbox. Called
  // before every HTTP request — providers may re-resolve underlying details
  // (e.g. docker re-reads the host port because Docker Desktop can restart
  // the container).
  getEndpoint(threadKey: string): Promise<SandboxEndpoint>;
  // Tear down the thread's sandbox. No-op if missing.
  remove(threadKey: string): Promise<void>;
  // Wipe every sandbox this provider owns. Used by tests and by the
  // (rarely called) `killAllSandboxContainers` re-export. Not on the runtime
  // hot path: routine cleanup is `/delete` per thread; boot-time cleanup is
  // `reapOrphanSandboxes`.
  killAll(): Promise<void>;
  // Returns the provider-native identifiers of every sandbox this provider
  // currently owns (containers for docker, machines for fly). Used by the
  // boot-time orphan reap to find sandboxes with no matching session.json.
  listAll(): Promise<Array<{ id: string }>>;
  // Destroy a sandbox by its provider-native id (the same id `listAll`
  // returns). Used by the orphan reap when the threadKey is no longer known
  // — `remove(threadKey)` is the user-facing tear-down.
  destroyById(id: string): Promise<void>;
};
