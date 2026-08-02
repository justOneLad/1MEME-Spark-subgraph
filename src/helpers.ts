import { BigInt, Bytes, ethereum, Address } from "@graphprotocol/graph-ts";
import { SparkStats } from "../generated/schema";

export const ZERO_BI = BigInt.fromI32(0);
export const ZERO_ADDRESS = Address.fromString(
  "0x0000000000000000000000000000000000000000"
);

export const PROTOCOL_UNISWAP_V4 = "UNISWAP_V4";
export const PROTOCOL_PANCAKE_INFINITY = "PANCAKE_INFINITY";

export const CTO_SOURCE_LOCKER_GO = "LOCKER_GO";
export const CTO_SOURCE_HOOK_V4_GO = "HOOK_V4_GO";
export const CTO_SOURCE_HOOK_INFINITY_GO = "HOOK_INFINITY_GO";
export const CTO_SOURCE_LOCKER_V1 = "LOCKER_V1";

export const SWAP_SIDE_BUY = "BUY";
export const SWAP_SIDE_SELL = "SELL";

export function protocolToString(protocol: i32): string {
  if (protocol == 0) return PROTOCOL_UNISWAP_V4;
  return PROTOCOL_PANCAKE_INFINITY;
}

/** Deterministic, unique id for a single event log: txHash + logIndex. */
export function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

export function getOrCreateStats(): SparkStats {
  let stats = SparkStats.load("1");
  if (stats == null) {
    stats = new SparkStats("1");
    stats.tokensLaunched = ZERO_BI;
    stats.dexCount = ZERO_BI;
    stats.lockerFeeClaims = ZERO_BI;
    stats.hookFeeClaims = ZERO_BI;
    stats.burns = ZERO_BI;
    stats.totalNativeBurnedIn = ZERO_BI;
    stats.totalCallerRewardsPaid = ZERO_BI;
    stats.totalTokensBurned = ZERO_BI;
    stats.ctoApplications = ZERO_BI;
    stats.ctoApprovals = ZERO_BI;
    stats.ctoRejections = ZERO_BI;
    stats.totalSwaps = ZERO_BI;
    stats.totalBuys = ZERO_BI;
    stats.totalSells = ZERO_BI;
    stats.totalVolumeNative = ZERO_BI;
  }
  return stats as SparkStats;
}
