import { BigInt } from "@graphprotocol/graph-ts";
import { Burned } from "../generated/SparkBurner/SparkBurner";
import { Burn } from "../generated/schema";
import { eventId, getOrCreateStats } from "./helpers";

export function handleBurned(event: Burned): void {
  let burn = new Burn(eventId(event));
  burn.token = event.params.token;
  burn.caller = event.params.caller;
  burn.nativeIn = event.params.nativeIn;
  burn.callerReward = event.params.callerReward;
  burn.tokenBurned = event.params.tokenBurned;
  burn.blockNumber = event.block.number;
  burn.timestamp = event.block.timestamp;
  burn.txHash = event.transaction.hash;
  burn.save();

  let stats = getOrCreateStats();
  stats.burns = stats.burns.plus(BigInt.fromI32(1));
  stats.totalNativeBurnedIn = stats.totalNativeBurnedIn.plus(event.params.nativeIn);
  stats.totalCallerRewardsPaid = stats.totalCallerRewardsPaid.plus(
    event.params.callerReward
  );
  stats.totalTokensBurned = stats.totalTokensBurned.plus(event.params.tokenBurned);
  stats.save();
}
