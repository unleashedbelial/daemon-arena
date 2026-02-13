const { createPublicClient, http, parseAbi, verifyMessage } = require('viem');
const { base } = require('viem/chains');
const crypto = require('crypto');

// ERC-8004 Identity Registry on Base
const ERC8004_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const RPC_URL = process.env.BASE_RPC_URL || 'https://base-mainnet.public.blastapi.io';

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL)
});

// Store pending challenges (nonce -> { wallet, tokenId, expires })
const pendingChallenges = new Map();

// Clean expired challenges every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [nonce, data] of pendingChallenges) {
    if (now > data.expires) pendingChallenges.delete(nonce);
  }
}, 5 * 60 * 1000);

/**
 * Step 1: Generate a challenge for the agent to sign
 */
function generateChallenge(wallet, tokenId) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const message = `DAEMON ARENA REGISTRATION\n\nWallet: ${wallet}\nERC-8004 Token ID: ${tokenId}\nNonce: ${nonce}`;

  pendingChallenges.set(nonce, {
    wallet: wallet.toLowerCase(),
    tokenId: parseInt(tokenId),
    message,
    expires: Date.now() + 5 * 60 * 1000 // 5 min expiry
  });

  return { nonce, message };
}

/**
 * Step 2: Verify signature + onchain ownership
 */
async function verifyRegistration(nonce, signature) {
  // Check challenge exists and hasn't expired
  const challenge = pendingChallenges.get(nonce);
  if (!challenge) {
    throw new Error('Invalid or expired challenge nonce');
  }

  if (Date.now() > challenge.expires) {
    pendingChallenges.delete(nonce);
    throw new Error('Challenge expired');
  }

  // Verify signature
  const valid = await verifyMessage({
    address: challenge.wallet,
    message: challenge.message,
    signature
  });

  if (!valid) {
    throw new Error('Invalid signature');
  }

  // Verify onchain: ownerOf(tokenId) == wallet
  try {
    const owner = await client.readContract({
      address: ERC8004_REGISTRY,
      abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
      functionName: 'ownerOf',
      args: [BigInt(challenge.tokenId)]
    });

    if (owner.toLowerCase() !== challenge.wallet) {
      throw new Error(`Wallet ${challenge.wallet} does not own ERC-8004 token #${challenge.tokenId}. Owner is ${owner}`);
    }
  } catch (e) {
    if (e.message.includes('does not own')) throw e;
    throw new Error(`Failed to verify ERC-8004 ownership onchain: ${e.message}`);
  }

  // Clean up used challenge
  pendingChallenges.delete(nonce);

  return {
    verified: true,
    wallet: challenge.wallet,
    tokenId: challenge.tokenId
  };
}

/**
 * Get agent's onchain identity info
 */
async function getIdentityInfo(tokenId) {
  try {
    const owner = await client.readContract({
      address: ERC8004_REGISTRY,
      abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
      functionName: 'ownerOf',
      args: [BigInt(tokenId)]
    });
    return { exists: true, owner, tokenId };
  } catch (e) {
    return { exists: false, tokenId };
  }
}

module.exports = { generateChallenge, verifyRegistration, getIdentityInfo };
