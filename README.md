# 1MEME-Spark-subgraph

A subgraph indexing both active [1MEME Spark](https://github.com/justOneLad/1MEME-Spark)
launcher families — **SparkLauncher** (V1) and **SparkGo** — per
[Deployment.md](https://github.com/justOneLad/1MEME-Spark/blob/main/Deployment.md). Both are
upgradeable UUPS proxies and currency-general (arbitrary quote tokens, not just native BNB),
sharing a multi-hop fallback routing engine (`common/SparkRouting.sol`) for instant-buy.

Deployed on two chains, each as its own **separate subgraph** — a single subgraph deployment
can't span multiple chains, so BSC and Ethereum are entirely independent manifests/deployments
sharing the same `schema.graphql` and mapping code (`src/*.ts`), since the underlying contracts
are identical across chains — only addresses, block numbers, and (for Ethereum) DEX availability
differ:

| Chain | Manifest | Studio slug |
|---|---|---|
| BSC (chain `56`) | `subgraph.yaml` | `1-spark` |
| Ethereum mainnet (chain `1`) | `subgraph.ethereum.yaml` | `1-spark-eth` |

The rest of this document describes the BSC deployment in detail; see "Ethereum mainnet
deployment" below for what differs.

## What it indexes

### SparkGo

The hook-gated Uniswap v4 / PancakeSwap Infinity launcher family — renamed from
`SparkLauncherV2` and rebuilt as an upgradeable proxy in the same currency-general rework as
SparkLauncher below.

| Contract | Address | Start block |
|---|---|---|
| `SparkGoLauncher` (proxy) | `0xC0d33846D04F5Ce0a34AEecE9b6462433EBC8f7C` | 113583462 |
| `SparkLocker` (SparkGo's instance) | `0x01245e814bbc3A1DC3b24924FB0E4E3b6863105B` | 113583466 |
| `SparkGoHookV4` | `0xdF3f8b41a55fb8737D653d6bc7467095e48700c4` | 113583474 |
| `SparkGoHookInfinity` | `0x8E273c882267f034ACE21dA677dBF0c0eB305B82` | 113583482 |
| `SparkGoBurner` | `0xC99fD815f5C0a5dCf2B6cA36A38AbbB5cF4e4c10` | 113583491 |

`SparkLocker` here predates SparkGo (it was originally paired with the now-superseded
`SparkLauncherV2`) but is reused, repointed via `setLauncher`. Its `startBlock` is set to that
repoint transaction, not the locker's original deploy block, so the 2 real tokens launched
through the superseded `SparkLauncherV2` are cleanly excluded — see "Superseded contracts" below.

**Buy/sell activity** is captured via `callHandlers` on `SparkGoHookV4.afterSwap` /
`SparkGoHookInfinity.afterSwap`, not from an event — neither hook emits one per swap. This works
because the hook address is baked into the pool's identity (part of the poolId), so Uniswap v4 /
PancakeSwap Infinity invoke it on *every* swap against that pool with no way to bypass it — unlike
scraping the shared, chain-wide `PoolManager`/`CLPoolManager` `Swap` event (which fires for every
pool on the whole DEX, not just Spark's), this is naturally scoped to just these two contracts.
The `delta` argument passed into `afterSwap` is unpacked as a Uniswap v4 `BalanceDelta`
(`int128 amount0 << 128 | uint128 amount1`, verified against
[Uniswap/v4-core](https://github.com/Uniswap/v4-core/blob/main/src/types/BalanceDelta.sol) and
matching the hook's own decode logic) to get the signed currency0/currency1 deltas, and poolId is
recomputed by re-encoding the call's raw `key` argument with `ethereum.encode` + `keccak256` — the
same `keccak256(abi.encode(poolKey))` scheme `SparkGoLauncher`/the hooks use on-chain (see
[Uniswap/v4-core](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol) and
[pancakeswap/infinity-core](https://github.com/pancakeswap/infinity-core/blob/main/src/types/PoolId.sol)),
so it matches `PoolGo.id` exactly. **Call handlers need a trace-capable RPC** (Parity-style
`trace_filter`/`trace_block`) — supported by The Graph Studio and most archive nodes, but not by
every lightweight/public RPC endpoint; confirm your target indexer supports it before deploying.

**Currency-general, unlike the superseded `SparkLauncherV2`.** The old launcher always paired
the token against native BNB as `currency0`; SparkGo pools can have the quote currency on
*either* side (`currency0` is whichever of `(quoteToken, token)` sorts lower). `PoolGo` reads
`quoteToken`/`tokenIsCurrency0` via `eth_call` against the hook's own `pools()` getter at
registration time, and `swap-recorder-go.ts` uses that (not a hardcoded `amount0`) to derive
buy/sell side and volume. Since SparkGo pools can be quoted in WBNB, USDT, USDC, USD1 or
Ondo-tokenized stocks (AAPL/NVDA/TSLA/SPCX), `PoolGo`/`SwapGo` use `quoteAmount`/
`totalVolumeQuote` rather than "native", and that volume is only folded into the global
`SparkStats.totalVolumeNative` when the specific pool is actually native-BNB-quoted — see the
`SparkStats` schema comment.

Plus a `SparkTokenGo` template: every `TokenLaunched` event dynamically spawns a new data source
at the launched token's clone address, so each meme token's own `Transfer`/ownership/metadata
events are indexed too.

**Instant-buy routing** (`common/SparkRouting.sol`, shared with SparkLauncher below) is also
indexed: `RoutesSet` updates `QuoteTokenGo.routeCount` (the owner-configured fallback route list
for that quote token), `RouteSucceeded` records a `RouteSuccessGo` row for each leg-1 (native BNB
-> quote token) fallback route that actually executed during a launch's instant-buy, and
`InstantBuySkipped` sets `TokenGo.instantBuySkipped`/`instantBuySkippedRefundWei` when every
fallback route failed and the extra native BNB was refunded instead.

### SparkLauncher (V1)

Deployed *after* the original SparkGo (then `SparkLauncherV2`), specifically to fix a
tradability gap: hooked v4/Infinity pools use a custom hook and a `fee: 0` pool key that neither
DEX's frontend discovers or routes through by default, and most trading bots don't support
hooked v4/Infinity pools at all. SparkLauncher (`spark/SparkLauncherUpgradeable.sol`) seeds
liquidity into plain Uniswap V3 / PancakeSwap V3 pools instead, using the standard fee-tier
system, so pools are found and routable everywhere V3 already works. It was currency-general
(WBNB plus USDT/USDC/USD1/AAPL/NVDA/TSLA/SPCX, each with its own `marketCapRef`) from its first
non-upgradeable version, and was later rebuilt as an upgradeable proxy in the same pass that
rebuilt `SparkLauncherV2` into SparkGo.

| Contract | Address | Start block |
|---|---|---|
| `SparkLauncher` (proxy) | `0xC10b8647B7d0d88B77C0A9FfAD5C7C17564B1973` | 113582648 |
| `SparkLocker` (SparkLauncher's instance) | `0xA69B4B4003483E7Ca27DDf1bE8cBC7e723afcF86` | 113379804 |

`SparkLocker` and the `SparkToken` implementation are the same, byte-identical contracts SparkGo
uses (verified via BscScan's bytecode-match auto-detection per `Deployment.md`) — SparkLauncher
just uses its own separate locker instance, since `SparkLocker.launcher` is a single mutable
address and a shared locker would have retired one launcher family's ability to register new
positions. Because SparkLauncher's data model genuinely differs from SparkGo's (no hook, a plain
V3 pool instead of a hook-computed `poolId`), it gets its own parallel set of entities
(`LauncherV1`, `DexV1`, `QuoteToken`, `TokenV1`, `TokenHolderV1`, `TokenTransferV1`,
`LockerPositionV1`, `LockerFeeClaimV1`, `PoolV1`, `SwapV1`) plus `SparkTokenV1` and `SparkV1Pool`
templates, rather than reusing the SparkGo entities above — see the schema comments in
`schema.graphql` for the full reasoning. `CTOApplication` is shared across both families (and
both SparkGo hooks) since it was already built to be source-polymorphic.

**Swap tracking works differently here than for SparkGo.** SparkGo captures buy/sell activity via
a call handler on the hook's own `afterSwap` (see above), which works because the hook is baked
into the pool's identity. SparkLauncher pools have no hook — they're plain Uniswap V3 /
PancakeSwap V3 pools, whose `Swap` event fires for every pool on the whole DEX, not just Spark's.
Instead, a `SparkV1Pool` template is instantiated at each token's specific pool address (emitted
directly in `TokenLaunched`), so it only ever indexes that one pool's `Swap` events — the same
technique Uniswap's own subgraph uses for per-pool tracking. `PoolV1`/`SwapV1` volume also isn't
folded into `SparkStats.totalVolumeNative` for the same non-native-quote reason as SparkGo.
`SparkStats.totalSwaps`/`totalBuys`/`totalSells` (pure counts) do include this family's activity.

Instant-buy routing is indexed the same way as SparkGo above: `RoutesSet` updates
`QuoteToken.routeCount`, `RouteSucceeded` records a `RouteSuccess` row per successful fallback
route, and `InstantBuySkipped` sets `TokenV1.instantBuySkipped`/`instantBuySkippedRefundWei`.

### Superseded contracts (not indexed)

Per `Deployment.md`'s "Superseded / abandoned addresses" section, none of these are indexed:

- The original **non-upgradeable** `SparkLauncher` (`0x1Bfc2A7d68A115B29906537D9E836A1799ebd3C4`)
  — confirmed via an earlier deployment of this subgraph to have **0 real launches** before being
  replaced by the upgradeable proxy above, so it's excluded the same way this project already
  excludes other zero-activity abandoned attempts.
- The original `SparkLauncherV2` (`0xcD5B9F286cd5A2cE2fBe160bAfc018a1159d5c77`) and its
  `SparkHookV4`/`SparkHookInfinity`/`SparkBurner` — had **2 real historical launches**, but per
  explicit direction this subgraph cuts over to SparkGo entirely rather than keeping them as
  legacy/historical data; those 2 tokens are not represented in this subgraph.
- Two earlier abandoned SparkLauncher (V1) broadcast attempts (`0x35E7...`, `0xaBF5...`, plus
  their paired lockers/token impls) — 0 real launches.

### MerkleDistributor (unrelated to any Spark launcher)

Per `Deployment.md`'s "Distributors" section: `distributor/MerkleDistributor.sol`, a standalone,
protocol-agnostic, UUPS-upgradeable claim-based distributor — anyone can open a campaign against
a token (or native currency) with a Merkle root committing to `(index, account, amount)`
allocations, funding it in the same transaction; each recipient (or anyone claiming on their
behalf — funds always go to the committed `account`) submits a proof to claim, and the campaign's
own `creator` can sweep any unclaimed remainder after its deadline. Live on both chains as
separate deployments of the same contract:

| Chain | Proxy address | Start block |
|---|---|---|
| BSC | `0x20ED1b487dd2A172D5ba0ED33562370142Cc338b` | 114470000 (estimated, see below) |
| Ethereum | `0xcB3ccF9f74c08A70b2B1bf7c111391d158D18B1c` | 25700654 (confirmed via Etherscan) |

The Ethereum block came from Etherscan's `getcontractcreation` API. `Deployment.md` doesn't list
block numbers for this contract on either chain, and BSC isn't covered by the available
Etherscan API key's plan, and public BSC RPCs refuse archive calls (`eth_getCode`/`eth_getLogs`
over historical ranges) without a paid key — so the BSC start block is an estimate: the
Ethereum deploy's UTC timestamp correlated against BSC block headers (which don't need archive
state, unlike `eth_getCode`), then padded back further for safety. Worth tightening if you ever
get archive RPC access.

### OneCoinLocker (unrelated to Spark)

Also included, at the user's request: `OneCoinLocker` — a general-purpose token/LP locker that
has nothing to do with 1MEME Spark, live on both chains as separate deployments (BSC
`0x6C6e9740753d9F6C1E5D61C8bc0f34E37590f6C5` at `startBlock: 100627321`; Ethereum
`0xD7F53605d58057D8f96337dF606638c3e79B9867` at `startBlock: 25182671`). Its ABI, entities
(`Locker`, `Lock`, `LockWithdrawal`, `LockTransfer`, `LockActivity`) and mapping
(`src/onecoin-locker.ts`) are ported from
[timedbase/OneMEMELaunchpad-Subgraph](https://github.com/timedbase/OneMEMELaunchpad-Subgraph),
which uses this same contract as a standalone locking utility outside its own launch flow (the
Ethereum address/block came from that repo's own `subgraph.ethereum.yaml`). It's a fully
independent data source — no entity here links to any Spark entity above.

## Entities

### SparkGo

- `LauncherGo`, `DexGo` — launcher config and registered DEXes (Uniswap v4 / PancakeSwap Infinity)
- `QuoteTokenGo` — a registered quote token (native BNB, address `0x0`, is always registered;
  plus whatever ERC-20s the owner adds) with its own `marketCapRef` and `routeCount`
- `RouteSuccessGo` — one row per successful leg-1 fallback route execution during an instant-buy
- `TokenGo` — one per launched meme token, with name/symbol/decimals/totalSupply/metaURI resolved
  via `eth_call` at launch time (these aren't emitted as event data), plus `instantBuySkipped`/
  `instantBuySkippedRefundWei` if its instant-buy leg failed and was refunded
- `PoolGo` — the hook-side pool registration (anti-sandwich / max-buy / fee state) for each token,
  created unconditionally on every successful launch, plus running swap/volume aggregates
  (`swapCount`, `buyCount`, `sellCount`, `totalVolumeQuote`, `totalVolumeToken`,
  `totalHookFeeTaken`)
- `SwapGo` — one row per buy or sell against a SparkGo pool, with signed currency0/currency1
  deltas, the hook's fee cut on that swap, the immediate caller (`sender`, often a router) and
  the originating wallet (`origin`, `tx.from`)
- `LockerPositionGo`, `LockerFeeClaimGo` — the permanent LP-NFT record in `SparkLocker` and its
  70/30 creator/platform fee claims
- `HookFeeClaimGo` — the hook's own 2% sell-side fee claims (70/30 creator/platform split)
- `BurnGo` — `SparkGoBurner` calls that claim a token's fees, swap 95% into the token, burn it,
  and pay the caller 5%
- `TokenHolderGo`, `TokenTransferGo` — per-token balances and transfer log (see caveat below)

### SparkLauncher (V1)

- `LauncherV1`, `DexV1` — launcher config and registered DEXes (Uniswap V3 / PancakeSwap V3)
- `QuoteToken` — a registered quote token with its own `marketCapRef`, `wethPairFee` and
  `routeCount`
- `RouteSuccess` — one row per successful leg-1 fallback route execution during an instant-buy
- `TokenV1` — one per launched meme token, same `eth_call`-resolved name/symbol/decimals/
  totalSupply/metaURI as `TokenGo`, plus `instantBuySkipped`/`instantBuySkippedRefundWei` if its
  instant-buy leg failed and was refunded
- `PoolV1` — the plain Uniswap V3 / PancakeSwap V3 pool seeded at launch, with running
  swap/volume aggregates (`swapCount`, `buyCount`, `sellCount`, `totalVolumeQuote`,
  `totalVolumeToken`), tracked via a per-pool `SparkV1Pool` template (see caveat below)
- `SwapV1` — one row per buy or sell against a `PoolV1`, captured from the pool's own `Swap` event
- `LockerPositionV1`, `LockerFeeClaimV1` — the permanent LP-NFT record in SparkLauncher's
  separate `SparkLocker` instance and its fee claims
- `TokenHolderV1`, `TokenTransferV1` — per-token balances and transfer log (see caveat below)

### MerkleDistributor (unrelated to Spark; separate deployment per chain)

- `MerkleDistributor` — one row per deployed distributor contract, with `owner`/`feeWallet`/
  `campaignFee` config
- `Campaign` — one per `createCampaign` call, tracking `remaining` balance, `deadline`, and
  sweep status
- `Claim` — one per successful `claim`, capturing both the committed `account` (where funds go)
  and the `caller` (`tx.from`, since anyone can claim on someone else's behalf)

### Shared across both families

- `CTOApplication` — community-takeover applications/approvals/rejections across both locker
  instances and both SparkGo hooks
- `SparkStats` — a single global counters row (`id: "1"`), including `totalSwaps`/`totalBuys`/
  `totalSells` across every Spark pool in both families
- `Locker`, `Lock`, `LockWithdrawal`, `LockTransfer`, `LockActivity` — OneCoinLocker (see above;
  unrelated to the Spark entities)

### Known caveat: launch-time token transfers

The `SparkTokenGo`/`SparkTokenV1` template data sources are only created while handling
`TokenLaunched`, which fires at the very end of the `launch()` transaction — after the initial 1B
mint, the LP-seeding transfer, and any instant-buy transfer already happened earlier in that same
transaction. Dynamic data sources can't retroactively index events from earlier in the same
block, so those specific transfers won't appear in `TokenHolderGo`/`TokenTransferGo` (or their V1
counterparts). `totalSupply` is unaffected on either family since it's read directly from the
contract via `eth_call`, not derived by summing transfers. This is the same well-known limitation
every factory+template subgraph (e.g. Uniswap) has to live with.

### Pool coverage

`SparkGoLauncher.launch()` unconditionally calls `registerPool` on the token's hook
(`_setupAndRegister` reverts the whole transaction otherwise), so every token that successfully
launches always gets exactly one `PoolGo` row, created in the same transaction as the launch.

SparkLauncher (V1) has no hook, so `PoolV1` is created directly in `handleTokenLaunched` (from
`launcher-v1.ts`) instead of from a separate registration event, and a `SparkV1Pool` template is
spawned at that exact pool address in the same handler to pick up its `Swap` events going
forward. One consequence of the template approach: any swap in the *same transaction* as the
launch (e.g. an instant-buy) fires before the template exists yet, so — like the launch-time
token transfer caveat above — it won't produce a `SwapV1` row, even though `PoolV1` itself is
always created. `Mint`/`Burn` on the pool aren't tracked; SparkLauncher liquidity is seeded once
at launch and permanently held by `SparkLocker`, so no ongoing LP position changes are expected
there (a third party could still mint a separate, unlocked position directly against the pool,
but that's not part of Spark's own liquidity and isn't tracked here).

## Ethereum mainnet deployment

`subgraph.ethereum.yaml` indexes the same two launcher families, freshly deployed on Ethereum
(chain `1`) — nothing pre-existed there to reuse, unlike BSC, so `SparkToken` and both
`SparkLocker`s are fresh instances too. Every data source name matches its BSC counterpart
exactly (`SparkLauncherV1`, `SparkLockerV1`, `SparkGoLauncher`, `SparkLockerGo`, `SparkGoHookV4`,
`SparkGoBurner`, plus the `SparkTokenV1`/`SparkV1Pool`/`SparkTokenGo` templates), which is what
lets `src/*.ts` be reused completely unmodified — `graph codegen`/`graph build` just regenerate
identical bindings against different addresses.

| Contract | Address | Start block |
|---|---|---|
| `SparkLauncher` (proxy) | `0x1010B4593376A5eEc045F9A706F615ed8417f541` | 25676015 |
| `SparkLocker` (SparkLauncher's instance) | `0x2C238982945d5bE37dc6cFDFDD0c942458326C32` | 25676013 |
| `SparkGoLauncher` (proxy) | `0x1655d6d3D2A6a29cf17bC151eDeA50A14A5DC918` | 25676033 |
| `SparkLocker` (SparkGo's instance) | `0x541b04c5389E540bcc875EA14F699E539f96F76A` | 25676031 |
| `SparkGoHookV4` | `0x49706386e0Fb729D24947a57f50097Ac578e80c4` | 25676036 |
| `SparkGoBurner` | `0x125Fd8e0BC3cfbe913C65bB2Ba93d7eA9372982c` | 25676038 |
| `OneCoinLocker` | `0xD7F53605d58057D8f96337dF606638c3e79B9867` | 25182671 |

Start blocks were looked up via Blockscout (Etherscan V1's API is deprecated and V2 needs a key),
since `Deployment.md` doesn't list them for this chain. `OneCoinLocker` here is a *different*
deployment of the same contract from
[timedbase/OneMEMELaunchpad-Subgraph](https://github.com/timedbase/OneMEMELaunchpad-Subgraph)'s
own `subgraph.ethereum.yaml` (its ABI is byte-identical to the BSC one already used here) — again
unrelated to Spark, included at the user's request for parity with the BSC deployment.

**No `SparkGoHookInfinity` on Ethereum** — PancakeSwap Infinity has no Ethereum deployment, so
SparkGo only registers Uniswap v4 here (`Deployment.md`). Consequently there's no
`SparkGoHookInfinity` data source in `subgraph.ethereum.yaml`; every `PoolGo`/`SwapGo` row on
this chain will always have `protocol: UNISWAP_V4`. Everything else — currency-general
quote-token handling (Ethereum's USDT/USDC are 6-decimal, unlike BSC's 18-decimal versions, but
nothing in the schema/mappings hardcodes decimals so this needs no code changes), routing
tracking, CTO flow, burns — works identically to BSC.

```bash
npm run codegen:ethereum
npm run build:ethereum
npm run deploy:ethereum   # graph deploy 1-spark-eth subgraph.ethereum.yaml
```

## Usage

```bash
npm install
npm run codegen
npm run build
```

To deploy, point `graph deploy`/`graph create` at your target (The Graph Studio, a self-hosted
`graph-node`, or another indexer). The BSC manifest (`subgraph.yaml`, the default) targets
network `bsc`; `subgraph.ethereum.yaml` targets network `mainnet`.
