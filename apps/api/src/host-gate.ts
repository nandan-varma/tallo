import { DurableObject } from "cloudflare:workers";
import { reserveSlot } from "@tallo/collect";

/**
 * One Durable Object per outbound host (keyed by hostname). It holds the time the host is next free
 * and hands out start slots, so every invocation that talks to a tenant host shares one gap. The
 * state is one number; it lives in the object's SQLite-backed storage so a restart keeps it.
 */
export class HostGate extends DurableObject {
  async reserve(gapMs: number): Promise<number> {
    const nextFreeAt = (await this.ctx.storage.get<number>("nextFreeAt")) ?? 0;
    const slot = reserveSlot(nextFreeAt, Date.now(), gapMs);
    await this.ctx.storage.put("nextFreeAt", slot.nextFreeAt);
    return slot.waitMs;
  }
}
