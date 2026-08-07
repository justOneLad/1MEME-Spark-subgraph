import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  CampaignCreated,
  Claimed,
  Swept,
  FeeWalletSet,
  CampaignFeeSet,
  MerkleDistributor as MerkleDistributorContract,
} from "../generated/MerkleDistributor/MerkleDistributor";
import { MerkleDistributor, Campaign, Claim } from "../generated/schema";
import { ZERO_BI, ZERO_ADDRESS, eventId } from "./helpers";

function getOrCreateDistributor(address: Address, event: ethereum.Event): MerkleDistributor {
  let distributor = MerkleDistributor.load(address);
  if (distributor == null) {
    distributor = new MerkleDistributor(address);
    let contract = MerkleDistributorContract.bind(address);

    let owner = contract.try_owner();
    distributor.owner = owner.reverted ? ZERO_ADDRESS : owner.value;

    let feeWallet = contract.try_feeWallet();
    distributor.feeWallet = feeWallet.reverted ? ZERO_ADDRESS : feeWallet.value;

    let campaignFee = contract.try_campaignFee();
    distributor.campaignFee = campaignFee.reverted ? ZERO_BI : campaignFee.value;

    distributor.campaignCount = ZERO_BI;
    distributor.createdAtBlock = event.block.number;
    distributor.createdAtTimestamp = event.block.timestamp;
  }
  distributor.updatedAtBlock = event.block.number;
  distributor.updatedAtTimestamp = event.block.timestamp;
  return distributor as MerkleDistributor;
}

/** campaignId is only unique per distributor instance, so key on both. */
function campaignEntityId(distributor: Bytes, campaignId: BigInt): Bytes {
  return distributor.concatI32(campaignId.toI32());
}

export function handleCampaignCreated(event: CampaignCreated): void {
  let distributor = getOrCreateDistributor(event.address, event);
  distributor.campaignCount = distributor.campaignCount.plus(BigInt.fromI32(1));
  distributor.save();

  let campaign = new Campaign(campaignEntityId(event.address, event.params.campaignId));
  campaign.distributor = distributor.id;
  campaign.campaignId = event.params.campaignId;
  campaign.creator = event.params.creator;
  campaign.token = event.params.token;
  campaign.merkleRoot = event.params.merkleRoot;
  campaign.totalAmount = event.params.amount;
  campaign.remaining = event.params.amount;
  campaign.deadline = event.params.deadline;
  campaign.swept = false;
  campaign.sweptTo = null;
  campaign.sweptAmount = null;
  campaign.createdAtBlock = event.block.number;
  campaign.createdAtTimestamp = event.block.timestamp;
  campaign.createdAtTx = event.transaction.hash;
  campaign.claimCount = ZERO_BI;
  campaign.save();
}

export function handleClaimed(event: Claimed): void {
  let campaign = Campaign.load(campaignEntityId(event.address, event.params.campaignId));
  if (campaign == null) return;

  campaign.remaining = campaign.remaining.minus(event.params.amount);
  campaign.claimCount = campaign.claimCount.plus(BigInt.fromI32(1));
  campaign.save();

  let claim = new Claim(eventId(event));
  claim.campaign = campaign.id;
  claim.claimIndex = event.params.index;
  claim.account = event.params.account;
  claim.caller = event.transaction.from;
  claim.amount = event.params.amount;
  claim.blockNumber = event.block.number;
  claim.timestamp = event.block.timestamp;
  claim.txHash = event.transaction.hash;
  claim.save();
}

export function handleSwept(event: Swept): void {
  let campaign = Campaign.load(campaignEntityId(event.address, event.params.campaignId));
  if (campaign == null) return;

  campaign.swept = true;
  campaign.sweptTo = event.params.to;
  campaign.sweptAmount = event.params.amount;
  campaign.remaining = ZERO_BI;
  campaign.save();
}

export function handleFeeWalletSet(event: FeeWalletSet): void {
  let distributor = getOrCreateDistributor(event.address, event);
  distributor.feeWallet = event.params.wallet;
  distributor.save();
}

export function handleCampaignFeeSet(event: CampaignFeeSet): void {
  let distributor = getOrCreateDistributor(event.address, event);
  distributor.campaignFee = event.params.fee;
  distributor.save();
}
