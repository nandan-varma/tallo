import type { Platform, SourceConfig } from "@tallo/contracts";
import { amazon } from "./amazon/index.ts";
import { apple } from "./apple/index.ts";
import { ashby } from "./ashby/index.ts";
import { bamboohr } from "./bamboohr/index.ts";
import { google } from "./google/index.ts";
import { greenhouse } from "./greenhouse/index.ts";
import { icims } from "./icims/index.ts";
import { jobvite } from "./jobvite/index.ts";
import { lever } from "./lever/index.ts";
import { meta } from "./meta/index.ts";
import { netflix } from "./netflix/index.ts";
import { oraclecloud } from "./oraclecloud/index.ts";
import { personio } from "./personio/index.ts";
import { recruitee } from "./recruitee/index.ts";
import { smartrecruiters } from "./smartrecruiters/index.ts";
import { teamtailor } from "./teamtailor/index.ts";
import { workable } from "./workable/index.ts";
import { workday } from "./workday/index.ts";

/** Register a platform here once; nothing else needs to change. */
export const platforms: Record<string, Platform> = Object.fromEntries(
  [
    amazon,
    jobvite,
    icims,
    greenhouse,
    lever,
    ashby,
    smartrecruiters,
    workday,
    oraclecloud,
    netflix,
    personio,
    workable,
    recruitee,
    teamtailor,
    bamboohr,
    google,
    apple,
    meta,
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
  amazon,
  apple,
  ashby,
  bamboohr,
  google,
  greenhouse,
  icims,
  jobvite,
  lever,
  meta,
  netflix,
  oraclecloud,
  personio,
  recruitee,
  smartrecruiters,
  teamtailor,
  workable,
  workday,
};
