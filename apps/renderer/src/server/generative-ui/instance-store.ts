import { randomBytes, randomUUID } from "node:crypto";
import type { CompiledGeneratedUiArtifact, TrustedGenerationSource } from "@ai-browser/contracts";

/**
 * Server-held state for one mounted generated view.
 *
 * There is no command channel and no capability table any more: a generated
 * view is display-only, so the only things worth holding are the artifact
 * it runs, the display-safe props it is handed, and whether it has actually
 * sent its ready handshake. That last one is what `ui.generate` waits on
 * before it is allowed to answer `ready`.
 */

/** Display-safe props. Contains no URL the sandbox could fetch and no server identifier. */
export type GeneratedViewDisplayProps = Readonly<{
  goal: string;
  sources: readonly Readonly<Record<string, unknown>>[];
  coverage: Readonly<Record<string, unknown>>;
}>;

export type GeneratedUiInstance = Readonly<{
  instanceId: string;
  /** The opaque reference the conversation model is given. Never an artifact id or a URL. */
  viewRef: string;
  ownerId: string;
  artifact: CompiledGeneratedUiArtifact;
  implementationPromptDigest: string;
  inputDigest: string;
  revision: number;
  expiresAt: number;
  displayProps: GeneratedViewDisplayProps;
  preservedStateKeys: readonly string[];
}>;

/**
 * Derives the props the sandbox is handed. This is display-safe trusted
 * source metadata plus bounded coverage numbers -- there is no plan-derived
 * record, fact, media, or collection data, and nothing describing policy,
 * limits, or constraints for the generated component to reinterpret.
 */
export function displayPropsForSources(input: {
  goal: string;
  trustedSources: readonly TrustedGenerationSource[];
  requestedSourceCount: number;
  note?: string | null;
}): GeneratedViewDisplayProps {
  return Object.freeze({
    goal: input.goal,
    sources: input.trustedSources.map((source) =>
      Object.freeze({
        id: source.sourceId,
        title: source.title,
        origin: source.origin,
        finalUrl: source.finalUrl,
        retrievedAt: source.retrievedAt,
        captureStatus: source.captureStatus,
      }),
    ),
    coverage: Object.freeze({
      requestedSources: input.requestedSourceCount,
      capturedSources: input.trustedSources.length,
      note: input.note ?? null,
    }),
  });
}

function mintViewRef(): string {
  return `uiv_${randomBytes(24).toString("base64url")}`;
}

export class GeneratedUiInstanceStore {
  private readonly instances = new Map<string, GeneratedUiInstance>();
  /** Pending ready handshakes, keyed by instance id. */
  private readonly readiness = new Map<string, { resolve: () => void; promise: Promise<void>; settled: boolean }>();

  constructor(private readonly now: () => number = Date.now, private readonly createId: () => string = randomUUID) {}

  register(input: Omit<GeneratedUiInstance, "instanceId" | "revision" | "viewRef">): GeneratedUiInstance {
    const instance = Object.freeze({ ...input, instanceId: this.createId(), viewRef: mintViewRef(), revision: 0 });
    this.instances.set(instance.instanceId, instance);
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.readiness.set(instance.instanceId, { resolve, promise, settled: false });
    return instance;
  }

  get(instanceId: string, ownerId: string): GeneratedUiInstance | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.ownerId !== ownerId) return undefined;
    if (instance.expiresAt <= this.now()) {
      this.destroy(instanceId, ownerId);
      return undefined;
    }
    return instance;
  }

  /**
   * Records a valid, instance-bound ready handshake. Every field the
   * surface reported is checked against server-held state first -- a
   * forged or stale handshake for another instance, another owner, another
   * artifact, or another plan resolves nothing.
   */
  markReady(input: { instanceId: string; ownerId: string; artifactId: string; implementationPromptDigest: string; revision: number }): boolean {
    const instance = this.get(input.instanceId, input.ownerId);
    if (!instance) return false;
    if (
      instance.artifact.artifactId !== input.artifactId ||
      instance.implementationPromptDigest !== input.implementationPromptDigest ||
      instance.revision !== input.revision
    ) {
      return false;
    }
    const pending = this.readiness.get(input.instanceId);
    if (!pending) return false;
    if (pending.settled) return true;
    pending.settled = true;
    pending.resolve();
    return true;
  }

  /**
   * Waits for that handshake. Registration, artifact load start, and model
   * success are explicitly *not* readiness -- only this resolves.
   */
  async waitForReady(input: { instanceId: string; signal: AbortSignal }): Promise<boolean> {
    const pending = this.readiness.get(input.instanceId);
    if (!pending) return false;
    if (pending.settled) return true;
    let onAbort: (() => void) | undefined;
    try {
      const raced = await Promise.race([
        // `destroy` also resolves this promise, so readiness is read from the
        // flag rather than from the promise settling: a torn-down surface
        // returns promptly *and* reports not-ready.
        pending.promise.then(() => pending.settled),
        new Promise<false>((resolve) => {
          onAbort = () => resolve(false);
          input.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return raced;
    } finally {
      if (onAbort) input.signal.removeEventListener("abort", onAbort);
    }
  }

  destroy(instanceId: string, ownerId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance && instance.ownerId !== ownerId) return;
    this.instances.delete(instanceId);
    const pending = this.readiness.get(instanceId);
    // Resolving a destroyed instance's waiter is what turns a hung surface
    // into a prompt `render_failed` instead of a stalled turn.
    pending?.resolve();
    this.readiness.delete(instanceId);
  }
}

export const generatedUiInstances = new GeneratedUiInstanceStore();
