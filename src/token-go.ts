import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  Transfer,
  OwnershipTransferred,
  MetaURISet,
} from "../generated/templates/SparkTokenGo/SparkToken";
import { TokenGo, TokenHolderGo, TokenTransferGo } from "../generated/schema";
import { ZERO_BI, ZERO_ADDRESS, eventId } from "./helpers";

// NOTE: the SparkTokenGo template data source is only instantiated when the
// launcher's TokenLaunched event is handled, which fires at the very end of
// the launch() transaction — after the initial mint, LP-seeding transfer and
// any instant-buy transfer have already happened earlier in that same
// transaction. Dynamic data sources can't retroactively index events from
// earlier in the same block, so those launch-time transfers are not reflected
// in TokenHolderGo/TokenTransferGo/holderCount below (TokenGo.totalSupply is read
// directly from the contract via eth_call instead, so it is always correct).
// Everything from the first post-launch transfer onward is indexed normally.

function getOrCreateHolder(token: Bytes, holder: Bytes): TokenHolderGo {
  let id = token.concat(holder);
  let existing = TokenHolderGo.load(id);
  if (existing != null) return existing as TokenHolderGo;
  let created = new TokenHolderGo(id);
  created.token = token;
  created.holder = holder;
  created.balance = ZERO_BI;
  return created;
}

export function handleTransfer(event: Transfer): void {
  let token = TokenGo.load(event.address);
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

  let transfer = new TokenTransferGo(eventId(event));
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
  let token = TokenGo.load(event.address);
  if (token == null) return;

  let isRenounce = event.params.newOwner.equals(ZERO_ADDRESS);
  token.currentOwner = isRenounce ? null : event.params.newOwner;
  token.renounced = isRenounce;
  token.save();
}

export function handleMetaURISet(event: MetaURISet): void {
  let token = TokenGo.load(event.address);
  if (token == null) return;

  token.metaURI = event.params.uri;
  token.save();
}
