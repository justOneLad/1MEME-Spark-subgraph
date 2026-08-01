import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  LockCreated,
  LockEdited,
  LockDescriptionChanged,
  Withdrawn,
  LockExtended,
  LockTransferred,
  LockRenounced,
  FeeUpdated,
  FeesCollected,
} from "../generated/OneCoinLocker/OneCoinLocker";
import { Locker, Lock, LockWithdrawal, LockTransfer, LockActivity } from "../generated/schema";
import { ZERO_BI, eventId } from "./helpers";

// Ported from timedbase/OneMEMELaunchpad-Subgraph (src/locker.ts) — a
// general-purpose BSC token/LP locker, unrelated to 1MEME Spark itself.
// See schema.graphql's "OneCoinLocker (BSC)" section for context.

function recordActivity(
  txHash: Bytes,
  logIndex: BigInt,
  lockId: Bytes,
  action: string,
  timestamp: BigInt,
  blockNumber: BigInt
): LockActivity {
  let activity = new LockActivity(txHash.concatI32(logIndex.toI32()));
  activity.lock = lockId;
  activity.action = action;
  activity.timestamp = timestamp;
  activity.blockNumber = blockNumber;
  activity.txHash = txHash;
  return activity;
}

function getOrCreateLocker(address: Address): Locker {
  let locker = Locker.load(address);
  if (locker == null) {
    locker = new Locker(address);
    locker.totalLocks = ZERO_BI;
    locker.activeLocks = ZERO_BI;
    locker.fee = ZERO_BI;
    locker.totalFeesCollected = ZERO_BI;
    locker.save();
  }
  return locker as Locker;
}

function buildLockId(lockerAddress: Address, id: BigInt): Bytes {
  return lockerAddress.concatI32(id.toI32());
}

export function handleLockCreated(event: LockCreated): void {
  let locker = getOrCreateLocker(event.address);

  let id = buildLockId(event.address, event.params.lockId);
  let lock = new Lock(id);
  lock.locker = event.address;
  lock.lockId = event.params.lockId;
  lock.owner = event.params.owner;
  lock.token = event.params.token;
  lock.amount = event.params.amount;
  lock.withdrawn = ZERO_BI;
  lock.lockDate = event.block.timestamp;
  lock.startTime = event.params.startTime;
  lock.endTime = event.params.endTime;
  lock.lockType = event.params.lockType == 0 ? "Cliff" : "Linear";
  lock.isLP = event.params.isLP;
  lock.description = "";
  lock.renounced = false;
  lock.createdAtTimestamp = event.block.timestamp;
  lock.createdAtBlockNumber = event.block.number;
  lock.txHash = event.transaction.hash;
  lock.save();

  locker.totalLocks = locker.totalLocks.plus(BigInt.fromI32(1));
  locker.activeLocks = locker.activeLocks.plus(BigInt.fromI32(1));
  locker.save();

  recordActivity(event.transaction.hash, event.logIndex, id, "CREATED", event.block.timestamp, event.block.number).save();
}

export function handleLockEdited(event: LockEdited): void {
  let id = buildLockId(event.address, event.params.lockId);
  let lock = Lock.load(id);
  if (lock == null) return;

  lock.amount = event.params.newAmount;
  lock.endTime = event.params.newEndTime;
  lock.save();

  let activity = recordActivity(event.transaction.hash, event.logIndex, id, "EDITED", event.block.timestamp, event.block.number);
  activity.newAmount = event.params.newAmount;
  activity.newEndTime = event.params.newEndTime;
  activity.save();
}

export function handleLockDescriptionChanged(event: LockDescriptionChanged): void {
  let id = buildLockId(event.address, event.params.lockId);
  let lock = Lock.load(id);
  if (lock == null) return;

  lock.description = event.params.description;
  lock.save();

  let activity = recordActivity(event.transaction.hash, event.logIndex, id, "DESCRIPTION_CHANGED", event.block.timestamp, event.block.number);
  activity.description = event.params.description;
  activity.save();
}

export function handleWithdrawn(event: Withdrawn): void {
  let id = buildLockId(event.address, event.params.lockId);
  let lock = Lock.load(id);
  if (lock == null) return;

  lock.withdrawn = lock.withdrawn.plus(event.params.amount);
  lock.save();

  let withdrawal = new LockWithdrawal(eventId(event));
  withdrawal.lock = id;
  withdrawal.owner = event.params.owner;
  withdrawal.amount = event.params.amount;
  withdrawal.nativeFee = event.params.nativeFee;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.blockNumber = event.block.number;
  withdrawal.txHash = event.transaction.hash;
  withdrawal.save();

  let activity = recordActivity(event.transaction.hash, event.logIndex, id, "WITHDRAWN", event.block.timestamp, event.block.number);
  activity.withdrawnAmount = event.params.amount;
  activity.nativeFee = event.params.nativeFee;
  activity.save();

  if (lock.withdrawn.ge(lock.amount)) {
    let locker = getOrCreateLocker(event.address);
    locker.activeLocks = locker.activeLocks.minus(BigInt.fromI32(1));
    locker.save();
  }
}

export function handleLockExtended(event: LockExtended): void {
  let id = buildLockId(event.address, event.params.lockId);
  let lock = Lock.load(id);
  if (lock == null) return;

  lock.endTime = event.params.newEndTime;
  lock.save();

  let activity = recordActivity(event.transaction.hash, event.logIndex, id, "EXTENDED", event.block.timestamp, event.block.number);
  activity.newEndTime = event.params.newEndTime;
  activity.save();
}

export function handleLockTransferred(event: LockTransferred): void {
  let id = buildLockId(event.address, event.params.lockId);
  let lock = Lock.load(id);
  if (lock == null) return;

  lock.owner = event.params.to;
  lock.save();

  let transfer = new LockTransfer(eventId(event));
  transfer.lock = id;
  transfer.from = event.params.from;
  transfer.to = event.params.to;
  transfer.timestamp = event.block.timestamp;
  transfer.blockNumber = event.block.number;
  transfer.txHash = event.transaction.hash;
  transfer.save();

  let activity = recordActivity(event.transaction.hash, event.logIndex, id, "TRANSFERRED", event.block.timestamp, event.block.number);
  activity.from = event.params.from;
  activity.to = event.params.to;
  activity.save();
}

export function handleLockRenounced(event: LockRenounced): void {
  let id = buildLockId(event.address, event.params.lockId);
  let lock = Lock.load(id);
  if (lock == null) return;

  lock.owner = null;
  lock.renounced = true;
  lock.save();

  recordActivity(event.transaction.hash, event.logIndex, id, "RENOUNCED", event.block.timestamp, event.block.number).save();

  let locker = getOrCreateLocker(event.address);
  locker.activeLocks = locker.activeLocks.minus(BigInt.fromI32(1));
  locker.save();
}

export function handleFeeUpdated(event: FeeUpdated): void {
  let locker = getOrCreateLocker(event.address);
  locker.fee = event.params.newFee;
  locker.save();
}

export function handleFeesCollected(event: FeesCollected): void {
  let locker = getOrCreateLocker(event.address);
  locker.totalFeesCollected = locker.totalFeesCollected.plus(event.params.amount);
  locker.save();
}
