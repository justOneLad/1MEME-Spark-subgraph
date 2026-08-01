import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  Transfer,
  OwnershipTransferred,
  MetaURISet,
} from "../generated/templates/SparkTokenV1/SparkToken";
import { TokenV1, TokenHolderV1, TokenTransferV1 } from "../generated/schema";
import { ZERO_BI, ZERO_ADDRESS, eventId } from "./helpers";

// Same launch-time caveat as src/token.ts: the SparkTokenV1 template is only instantiated
// while handling TokenLaunched, so transfers earlier in that same transaction (mint,
// LP-seeding, instant-buy) aren't reflected here. TokenV1.totalSupply is read directly via
// eth_call in src/launcher-v1.ts instead, so it's unaffected.

function getOrCreateHolder(token: Bytes, holder: Bytes): TokenHolderV1 {
  let id = token.concat(holder);
  let existing = TokenHolderV1.load(id);
  if (existing != null) return existing as TokenHolderV1;
  let created = new TokenHolderV1(id);
  created.token = token;
  created.holder = holder;
  created.balance = ZERO_BI;
  return created;
}

export function handleTransfer(event: Transfer): void {
  let token = TokenV1.load(event.address);
  if (token == null) return;

  let value = event.params.value;
  let isMint = event.params.from.equals(ZERO_ADDRESS);
  let isBurn = event.params.to.equals(ZERO_ADDRESS);

  if (!isMint) {
    let from = getOrCreateHolder(event.address, event.params.from);
    let wasHolder = from.balance.gt(ZERO_BI);
    from.balance = from.balance.minus(value);
    from.save();
    if (wasHolder && from.balance.le(ZERO_BI)) {
      token.holderCount = token.holderCount.minus(BigInt.fromI32(1));
    }
  }

  if (!isBurn) {
    let to = getOrCreateHolder(event.address, event.params.to);
    let wasHolder = to.balance.gt(ZERO_BI);
    to.balance = to.balance.plus(value);
    to.save();
    if (!wasHolder && to.balance.gt(ZERO_BI)) {
      token.holderCount = token.holderCount.plus(BigInt.fromI32(1));
    }
  }

  token.transferCount = token.transferCount.plus(BigInt.fromI32(1));
  token.save();

  let transfer = new TokenTransferV1(eventId(event));
  transfer.token = event.address;
  transfer.from = event.params.from;
  transfer.to = event.params.to;
  transfer.value = value;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.txHash = event.transaction.hash;
  transfer.save();
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  let token = TokenV1.load(event.address);
  if (token == null) return;

  let isRenounce = event.params.newOwner.equals(ZERO_ADDRESS);
  token.currentOwner = isRenounce ? null : event.params.newOwner;
  token.renounced = isRenounce;
  token.save();
}

export function handleMetaURISet(event: MetaURISet): void {
  let token = TokenV1.load(event.address);
  if (token == null) return;

  token.metaURI = event.params.uri;
  token.save();
}
