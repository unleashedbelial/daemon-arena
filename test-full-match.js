const { createWalletClient, createPublicClient, http, parseEther, formatEther } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const API = 'http://localhost:3002';
const ARENA_WALLET = '0x864736f6982Ae6D2e40033d52C0c82c14Da9bc65';

const BELIAL = {
  apiKey: 'dk_4c4eaee7120603ad363afd2d7ab8128d71dfdbd3b05c3d37a71d9299915dfc10',
  wallet: require('/home/mikoshi/.moltlaunch/wallet.json'),  // Belial uses moltlaunch wallet
};

const SHADOW = {
  apiKey: 'dk_d05dadd95c0c4a9c212959b86bb51e01b3d390794ef1ae46e8528545f7112570',
  wallet: require('/home/mikoshi/.config/daemon-arena/shadowtest-wallet.json'),
};

const RPC = 'https://base-mainnet.public.blastapi.io';
const pub = createPublicClient({ chain: base, transport: http(RPC) });

async function sendETH(fromWallet, to, valueEth) {
  const account = privateKeyToAccount(fromWallet.privateKey);
  const client = createWalletClient({ account, chain: base, transport: http(RPC) });
  const hash = await client.sendTransaction({ to, value: parseEther(valueEth) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  TX: ${hash} (${receipt.status})`);
  return hash;
}

async function api(path, method, apiKey, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (apiKey) opts.headers['X-API-Key'] = apiKey;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  try {
    // Check balances
    const belialBal = await pub.getBalance({ address: BELIAL.wallet.address });
    const shadowBal = await pub.getBalance({ address: SHADOW.wallet.address });
    const arenaBal = await pub.getBalance({ address: ARENA_WALLET });
    console.log('=== BALANCES ===');
    console.log(`  Belial:     ${formatEther(belialBal)} ETH`);
    console.log(`  ShadowTest: ${formatEther(shadowBal)} ETH`);
    console.log(`  Arena:      ${formatEther(arenaBal)} ETH`);

    // Step 1: Belial creates a match
    console.log('\n=== STEP 1: Belial creates match ===');
    const match = await api('/api/match/create', 'POST', BELIAL.apiKey, {
      challengeType: 'cipher_break',
      difficulty: 1,
      entryFee: '0.0001'
    });
    console.log(`  Match ID: ${match.match_id}`);
    console.log(`  Entry fee: ${match.entry_fee_eth} ETH`);

    // Step 2: Belial pays entry fee
    console.log('\n=== STEP 2: Belial pays entry fee ===');
    const belialTx = await sendETH(BELIAL.wallet, ARENA_WALLET, '0.0001');
    const belialPay = await api('/api/match/pay', 'POST', BELIAL.apiKey, { txHash: belialTx });
    console.log(`  Payment: ${JSON.stringify(belialPay)}`);

    // Step 3: ShadowTest pays entry fee
    console.log('\n=== STEP 3: ShadowTest pays entry fee ===');
    const shadowTx = await sendETH(SHADOW.wallet, ARENA_WALLET, '0.0001');
    console.log(`  TX sent`);

    // Step 4: ShadowTest joins the match (with txHash)
    console.log('\n=== STEP 4: ShadowTest joins match ===');
    const join = await api(`/api/match/${match.match_id}/join`, 'POST', SHADOW.apiKey, { txHash: shadowTx });
    console.log(`  Join: ${JSON.stringify(join)}`);

    // Step 5: Get match details (challenge)
    console.log('\n=== STEP 5: Get challenge ===');
    const matchData = await api(`/api/match/${match.match_id}`, 'GET');
    console.log(`  Status: ${matchData.status}`);
    console.log(`  Challenge type: ${matchData.challenge_data?.type}`);
    console.log(`  Challenge: ${JSON.stringify(matchData.challenge_data).substring(0, 200)}`);

    // Step 6: Belial solves the challenge
    console.log('\n=== STEP 6: Belial submits solution ===');
    const challenge = matchData.challenge_data;
    let solution = '';
    
    // Try to solve based on challenge type
    if (challenge.cipher_type === 'caesar' || challenge.type === 'cipher_break') {
      // For caesar cipher, try the answer if available
      solution = challenge.answer || challenge.plaintext || 'test_solution';
    }
    console.log(`  Solution attempt: "${solution}"`);
    
    const submit = await api(`/api/match/${match.match_id}/submit`, 'POST', BELIAL.apiKey, {
      solution: solution
    });
    console.log(`  Result: ${JSON.stringify(submit)}`);

    // Step 7: Check final match state
    console.log('\n=== STEP 7: Final state ===');
    const finalMatch = await api(`/api/match/${match.match_id}`, 'GET');
    console.log(`  Status: ${finalMatch.status}`);
    console.log(`  Winner: ${finalMatch.winner_id || 'none yet'}`);
    console.log(`  Pot: ${finalMatch.pot_wei} wei`);
    console.log(`  Winner payout: ${finalMatch.winner_payout_wei} wei`);

    // Wait a bit for payout tx
    console.log('\n=== CHECKING PAYOUT (waiting 10s) ===');
    await new Promise(r => setTimeout(r, 10000));
    
    const belialBalAfter = await pub.getBalance({ address: BELIAL.wallet.address });
    const shadowBalAfter = await pub.getBalance({ address: SHADOW.wallet.address });
    const arenaBalAfter = await pub.getBalance({ address: ARENA_WALLET });
    console.log(`  Belial:     ${formatEther(belialBalAfter)} ETH (was ${formatEther(belialBal)})`);
    console.log(`  ShadowTest: ${formatEther(shadowBalAfter)} ETH (was ${formatEther(shadowBal)})`);
    console.log(`  Arena:      ${formatEther(arenaBalAfter)} ETH (was ${formatEther(arenaBal)})`);

    console.log('\n✅ TEST COMPLETE');
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    console.error(err.stack);
  }
})();
