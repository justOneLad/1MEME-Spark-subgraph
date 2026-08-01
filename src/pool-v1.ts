import { BigInt } from "@graphprotocol/graph-ts";
import { Swap } from "../generated/templates/SparkV1Pool/UniswapV3Pool";
import { PoolV1, SwapV1 } from "../generated/schema";
import { ZERO_BI, SWAP_SIDE_BUY, SWAP_SIDE_SELL, eventId, getOrCreateStats } from "./helpers";

/**
 * Fires on every swap against this one pool — the template is instantiated at the pool's
 * exact address (see handleTokenLaunched in launcher-v1.ts), so unlike scraping the DEX-wide
 * V3 Factory, this is naturally scoped to just this Spark pool.
 */
export function handleSwap(event: Swap): void {
  let pool = PoolV1.load(event.address);
  if (pool == null) return;

  let quoteDelta = pool.quoteIsToken0 ? event.params.amount0 : event.params.amount1;
  let tokenDelta = pool.quoteIsToken0 ? event.params.amount1 : event.params.amount0;
  let isBuy = quoteDelta.gt(ZERO_BI);
  let quoteAmount = quoteDelta.lt(ZERO_BI) ? quoteDelta.neg() : quoteDelta;
  let tokenAmount = tokenDelta.lt(ZERO_BI) ? tokenDelta.neg() : tokenDelta;

  pool.swapCount = pool.swapCount.plus(BigInt.fromI32(1));
  if (isBuy) {
    pool.buyCount = pool.buyCount.plus(BigInt.fromI32(1));
  } else {
    pool.sellCount = pool.sellCount.plus(BigInt.fromI32(1));
  }
  pool.totalVolumeQuote = pool.totalVolumeQuote.plus(quoteAmount);
  pool.totalVolumeToken = pool.totalVolumeToken.plus(tokenAmount);
  pool.lastSwapBlock = event.block.number;
  pool.lastSwapTimestamp = event.block.timestamp;
  pool.save();

  let swap = new SwapV1(eventId(event));
  swap.pool = pool.id;
  swap.token = pool.token;
  swap.quoteToken = pool.quoteToken;
  swap.side = isBuy ? SWAP_SIDE_BUY : SWAP_SIDE_SELL;
  swap.sender = event.params.sender;
  swap.recipient = event.params.recipient;
  swap.origin = event.transaction.from;
  swap.amount0 = event.params.amount0;
  swap.amount1 = event.params.amount1;
  swap.quoteAmount = quoteAmount;
  swap.tokenAmount = tokenAmount;
  swap.sqrtPriceX96 = event.params.sqrtPriceX96;
  swap.tick = event.params.tick;
  swap.blockNumber = event.block.number;
  swap.timestamp = event.block.timestamp;
  swap.txHash = event.transaction.hash;
  swap.save();

  // Deliberately not touching stats.totalVolumeNative — see the SparkStats comment in
  // schema.graphql for why V1's quote-token volume can't be summed into that field.
  let stats = getOrCreateStats();
  stats.totalSwaps = stats.totalSwaps.plus(BigInt.fromI32(1));
  if (isBuy) {
    stats.totalBuys = stats.totalBuys.plus(BigInt.fromI32(1));
  } else {
    stats.totalSells = stats.totalSells.plus(BigInt.fromI32(1));
  }
  stats.save();
}
