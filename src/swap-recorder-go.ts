import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { PoolGo, SwapGo } from "../generated/schema";
import { ZERO_BI, ZERO_ADDRESS, SWAP_SIDE_BUY, SWAP_SIDE_SELL, getOrCreateStats } from "./helpers";

const TWO_POW_128 = BigInt.fromI32(1).leftShift(128);
const TWO_POW_127 = BigInt.fromI32(1).leftShift(127);

/**
 * Unpacks a Uniswap v4-style BalanceDelta: an int256 where the upper 128 bits
 * are amount0 (as a signed int128) and the lower 128 bits are amount1 (as a
 * signed int128) — see
 * https://github.com/Uniswap/v4-core/blob/main/src/types/BalanceDelta.sol
 * and SparkGoHookV4/SparkGoHookInfinity's own `afterSwap`, which decodes the same
 * way (`int128(delta >> 128)` / `int128(delta)`).
 */
export function unpackBalanceDelta(delta: BigInt): BigInt[] {
  let amount0 = delta.rightShift(128); // arithmetic shift — already a valid signed int128
  let remainder = delta.minus(amount0.leftShift(128)); // unsigned, in [0, 2^128)
  let amount1 = remainder.ge(TWO_POW_127) ? remainder.minus(TWO_POW_128) : remainder;
  return [amount0, amount1];
}

/**
 * Shared by both hooks' afterSwap call handlers. Every swap against a Spark
 * pool passes through here exactly once (the hook is baked into the pool's
 * identity), so — unlike scraping the DEX-wide PoolManager/CLPoolManager Swap
 * event — there's no need to filter out unrelated pools: PoolGo.load(poolId)
 * only returns null if this hook was somehow reused by a pool nobody ever
 * registered through SparkGoLauncher, which shouldn't happen in practice but
 * is guarded against anyway.
 *
 * Unlike the pre-rebuild SparkLauncherV2 (always native-BNB-quoted, currency0 hardcoded),
 * SparkGo pools can have the quote currency on either side — pool.tokenIsCurrency0 (read via
 * eth_call at PoolRegistered time) is what actually determines buy/sell side and volume here.
 */
export function recordSwap(
  block: ethereum.Block,
  transactionHash: Bytes,
  poolId: Bytes,
  sender: Address,
  origin: Address,
  delta: BigInt,
  hookFeeTaken: BigInt
): void {
  let pool = PoolGo.load(poolId);
  if (pool == null) return;

  let unpacked = unpackBalanceDelta(delta);
  let amount0 = unpacked[0];
  let amount1 = unpacked[1];

  let quoteDelta = pool.tokenIsCurrency0 ? amount1 : amount0;
  let tokenDelta = pool.tokenIsCurrency0 ? amount0 : amount1;

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
  pool.totalHookFeeTaken = pool.totalHookFeeTaken.plus(hookFeeTaken);
  pool.lastSwapBlock = block.number;
  pool.lastSwapTimestamp = block.timestamp;
  pool.save();

  // Calls (unlike logs) have no log index, so the id is disambiguated with
  // this pool's own running swap count instead.
  let id = transactionHash.concat(poolId).concatI32(pool.swapCount.toI32());

  let swap = new SwapGo(id);
  swap.pool = pool.id;
  swap.token = pool.token;
  swap.protocol = pool.protocol;
  swap.side = isBuy ? SWAP_SIDE_BUY : SWAP_SIDE_SELL;
  swap.sender = sender;
  swap.origin = origin;
  swap.amount0 = amount0;
  swap.amount1 = amount1;
  swap.quoteAmount = quoteAmount;
  swap.tokenAmount = tokenAmount;
  swap.hookFeeTaken = hookFeeTaken;
  swap.blockNumber = block.number;
  swap.timestamp = block.timestamp;
  swap.txHash = transactionHash;
  swap.save();

  let stats = getOrCreateStats();
  stats.totalSwaps = stats.totalSwaps.plus(BigInt.fromI32(1));
  if (isBuy) {
    stats.totalBuys = stats.totalBuys.plus(BigInt.fromI32(1));
  } else {
    stats.totalSells = stats.totalSells.plus(BigInt.fromI32(1));
  }
  // pool.quoteToken is the QuoteTokenGo id, i.e. the raw quote currency address — only fold
  // into the global native-BNB counter when this pool is actually native-quoted (see the
  // SparkStats comment in schema.graphql for why non-native volume can't be summed in here).
  if (Address.fromBytes(pool.quoteToken).equals(ZERO_ADDRESS)) {
    stats.totalVolumeNative = stats.totalVolumeNative.plus(quoteAmount);
  }
  stats.save();
}
