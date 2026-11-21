import type { Platform, SourceConfig } from "@tallo/contracts";
import { ashby } from "./ashby/index.ts";
import { greenhouse } from "./greenhouse/index.ts";
import { lever } from "./lever/index.ts";
import { oraclecloud } from "./oraclecloud/index.ts";
import { personio } from "./personio/index.ts";
import { recruitee } from "./recruitee/index.ts";
import { smartrecruiters } from "./smartrecruiters/index.ts";
import { workable } from "./workable/index.ts";
import { workday } from "./workday/index.ts";

/** Register a platform here once; nothing else needs to change. */
export const platforms: Record<string, Platform> = Object.fromEntries(
  [
    greenhouse,
    lever,
    ashby,
    smartrecruiters,
    workday,
    oraclecloud,
    personio,
    workable,
    recruitee,
  ].map((p) => [p.id, p]),
);

export function platformFor(source: SourceConfig): Platform {
  const platform = platforms[source.platform];
  if (!platform) throw new Error(`Unknown platform: ${source.platform}`);
  platform.validate(source);
  return platform;
}

export const allowedHosts = (): string[] => Object.values(platforms).flatMap((p) => p.hosts);

export * from "./kit.ts";
export {
  ashby,
  greenhouse,
  lever,
  oraclecloud,
  personio,
  recruitee,
  smartrecruiters,
  workable,
  workday,
};
