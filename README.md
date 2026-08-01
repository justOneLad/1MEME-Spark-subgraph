# 1MEME-Spark-subgraph

A subgraph indexing the [1MEME Spark V2](https://github.com/justOneLad/1MEME-Spark) deployment
on BNB Smart Chain (chain ID `56`), per
[Deployment.md](https://github.com/justOneLad/1MEME-Spark/blob/main/Deployment.md).

## What it indexes

Fixed data sources (the active, non-deprecated contracts from `Deployment.md`):

| Contract | Address | Start block |
|---|---|---|
| `SparkLauncherV2` | `0xcD5B9F286cd5A2cE2fBe160bAfc018a1159d5c77` | 113277608 |
| `SparkLocker` | `0x01245e814bbc3A1DC3b24924FB0E4E3b6863105B` | 113277603 |
| `SparkHookV4` | `0x8baB0D3049B6d5D17B36d3263786Fe587A9D00C4` | 113278869 |
| `SparkHookInfinity` | `0xad220d84F318Ca4941D07af5AF244f081Cb849A8` | 113278027 |
| `SparkBurner` | `0x34480Bcd62D0bed99E2782cCAaF90c31A7fB475E` | 113278035 |

**Buy/sell activity** is captured via `callHandlers` on `SparkHookV4.afterSwap` /
`SparkHookInfinity.afterSwap`, not from an event — neither hook emits one per swap. This works
because the hook address is baked into the pool's identity (part of the poolId), so Uniswap v4 /
PancakeSwap Infinity invoke it on *every* swap against that pool with no way to bypass it — unlike
scraping the shared, chain-wide `PoolManager`/`CLPoolManager` `Swap` event (which fires for every
pool on the whole DEX, not just Spark's), this is naturally scoped to just these two contracts.
The `delta` argument passed into `afterSwap` is unpacked as a Uniswap v4 `BalanceDelta`
(`int128 amount0 << 128 | uint128 amount1`, verified against
[Uniswap/v4-core](https://github.com/Uniswap/v4-core/blob/main/src/types/BalanceDelta.sol) and
matching the hook's own decode logic) to get the signed BNB/token deltas, and poolId is recomputed
by re-encoding the call's raw `key` argument with `ethereum.encode` + `keccak256` — the same
`keccak256(abi.encode(poolKey))` scheme `SparkLauncherV2`/the hooks use on-chain (see
[Uniswap/v4-core](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol) and
[pancakeswap/infinity-core](https://github.com/pancakeswap/infinity-core/blob/main/src/types/PoolId.sol)),
so it matches `Pool.id` exactly. **Call handlers need a trace-capable RPC** (Parity-style
`trace_filter`/`trace_block`) — supported by The Graph Studio and most archive nodes, but not by
every lightweight/public RPC endpoint; confirm your target indexer supports it before deploying.

Plus a `SparkToken` template: every `TokenLaunched` event dynamically spawns a new data source at
the launched token's clone address, so each meme token's own `Transfer`/ownership/metadata events
are indexed too.

The deprecated/abandoned contracts listed in `Deployment.md` (the first-attempt `SparkHookV4`,
`SparkToken` impl, `SparkLocker`, and `SparkLauncherV2`, plus the one-time `HookV4Factory` helper)
are intentionally **not** indexed.

### OneCoinLocker (unrelated to Spark)

Also included, at the user's request: `OneCoinLocker` (`0x6C6e9740753d9F6C1E5D61C8bc0f34E37590f6C5`,
BSC, `startBlock: 100627321`) — a general-purpose token/LP locker that has nothing to do with
1MEME Spark. Its ABI, entities (`Locker`, `Lock`, `LockWithdrawal`, `LockTransfer`,
`LockActivity`) and mapping (`src/onecoin-locker.ts`) are ported from
[timedbase/OneMEMELaunchpad-Subgraph](https://github.com/timedbase/OneMEMELaunchpad-Subgraph),
which uses this same contract as a standalone locking utility outside its own launch flow. It's a
fully independent data source — no entity here links to any `Token`/`Pool`/`Launcher` above.

## Entities

- `Launcher`, `Dex` — launcher config and registered DEXes (Uniswap v4 / PancakeSwap Infinity)
- `Token` — one per launched meme token, with name/symbol/decimals/totalSupply/metaURI resolved
  via `eth_call` at launch time (these aren't emitted as event data)
- `Pool` — the hook-side pool registration (anti-sandwich / max-buy / fee state) for each token,
  created unconditionally on every successful launch, plus running swap/volume aggregates
  (`swapCount`, `buyCount`, `sellCount`, `totalVolumeNative`, `totalVolumeToken`,
  `totalHookFeeTaken`)
- `Swap` — one row per buy or sell against a Spark pool, with signed BNB/token deltas, the
  hook's fee cut on that swap, the immediate caller (`sender`, often a router) and the
  originating wallet (`origin`, `tx.from`)
- `LockerPosition`, `LockerFeeClaim` — the permanent LP-NFT record in `SparkLocker` and its
  70/30 creator/platform fee claims
- `HookFeeClaim` — the hook's own 2% native-BNB sell fee claims (70/30 creator/platform split)
- `CTOApplication` — community-takeover applications/approvals/rejections across the locker and
  both hooks
- `Burn` — `SparkBurner` calls that claim a token's fees, swap 95% into the token, burn it, and
  pay the caller 5%
- `TokenHolder`, `TokenTransfer` — per-token balances and transfer log (see caveat below)
- `SparkStats` — a single global counters row (`id: "1"`), including `totalSwaps`/`totalBuys`/
  `totalSells`/`totalVolumeNative` across every Spark pool
- `Locker`, `Lock`, `LockWithdrawal`, `LockTransfer`, `LockActivity` — OneCoinLocker (see above;
  unrelated to the Spark entities)

### Known caveat: launch-time token transfers

The `SparkToken` template data source is only created while handling `TokenLaunched`, which fires
at the very end of the `launch()` transaction — after the initial 1B mint, the LP-seeding
transfer, and any instant-buy transfer already happened earlier in that same transaction. Dynamic
data sources can't retroactively index events from earlier in the same block, so those specific
transfers won't appear in `TokenHolder`/`TokenTransfer`. `Token.totalSupply` is unaffected since
it's read directly from the contract via `eth_call`, not derived by summing transfers. This is the
same well-known limitation every factory+template subgraph (e.g. Uniswap) has to live with.

### Pool coverage

`SparkLauncherV2.launch()` unconditionally calls `registerPool` on the token's hook
(`_setupAndRegister` reverts the whole transaction otherwise), so every token that successfully
launches always gets exactly one `Pool` row, created in the same transaction as the launch —
before either hook's `startBlock` could possibly miss it, since both hooks were deployed (per
`Deployment.md`) before the first `addDex` call that could have made a launch succeed.

## Usage

```bash
npm install
npm run codegen
npm run build
```

To deploy, point `graph deploy`/`graph create` at your target (The Graph Studio, a self-hosted
`graph-node`, or another indexer) with network `bsc`.
