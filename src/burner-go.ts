import { BigInt } from "@graphprotocol/graph-ts";
import { Burned } from "../generated/SparkGoBurner/SparkGoBurner";
import { BurnGo } from "../generated/schema";
import { ZERO_ADDRESS, eventId, getOrCreateStats } from "./helpers";

export function handleBurned(event: Burned): void {
  let burn = new BurnGo(eventId(event));
  burn.token = event.params.token;
  burn.quoteCurrency = event.params.quoteCurrency;
  burn.caller = event.params.caller;
  burn.quoteIn = event.params.quoteIn;
  burn.callerReward = event.params.callerReward;
  burn.tokenBurned = event.params.tokenBurned;
  burn.blockNumber = event.block.number;
  burn.timestamp = event.block.timestamp;
  burn.txHash = event.transaction.hash;
  burn.save();

  let stats = getOrCreateStats();
  stats.burns = stats.burns.plus(BigInt.fromI32(1));
  stats.totalTokensBurned = stats.totalTokensBurned.plus(event.params.tokenBurned);
  // totalNativeBurnedIn/totalCallerRewardsPaid are native-BNB-only — see the SparkStats
  // comment in schema.graphql for why non-native-quoted burns can't be summed in here.
  if (event.params.quoteCurrency.equals(ZERO_ADDRESS)) {
    stats.totalNativeBurnedIn = stats.totalNativeBurnedIn.plus(event.params.quoteIn);
    stats.totalCallerRewardsPaid = stats.totalCallerRewardsPaid.plus(event.params.callerReward);
  }
  stats.save();
}
