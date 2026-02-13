const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const DaemonDB = require('./database');
const ChallengeGenerator = require('./challenges');
const { generateChallenge: generateAuthChallenge, verifyRegistration, getIdentityInfo } = require('./erc8004');
const { createPublicClient, createWalletClient, http, parseEther, formatEther } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

// Payment Configuration
const ARENA_WALLET = '0x864736f6982Ae6D2e40033d52C0c82c14Da9bc65';
const ENTRY_FEE_ETH = '0.0001'; // 0.0001 ETH per match entry
const ENTRY_FEE_WEI = parseEther(ENTRY_FEE_ETH).toString();
const BASE_RPC = 'https://base-mainnet.public.blastapi.io';

// Initialize viem client for Base mainnet
const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC),
});

// Arena wallet for sending payouts
const ARENA_PRIVATE_KEY = require(path.join(process.env.HOME, '.config/daemon-arena/wallet.json')).privateKey;
const arenaAccount = privateKeyToAccount(ARENA_PRIVATE_KEY);
const walletClient = createWalletClient({
  account: arenaAccount,
  chain: base,
  transport: http(BASE_RPC),
});

// Send payout to winner
async function sendPayout(matchId, winnerWallet, payoutWei) {
  try {
    console.log(`[PAYOUT] Sending ${formatEther(BigInt(payoutWei))} ETH to ${winnerWallet} for match ${matchId}`);
    const hash = await walletClient.sendTransaction({
      to: winnerWallet,
      value: BigInt(payoutWei),
    });
    console.log(`[PAYOUT] TX sent: ${hash}`);
    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[PAYOUT] Confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
    return { hash, status: receipt.status };
  } catch (error) {
    console.error(`[PAYOUT] Failed for match ${matchId}:`, error.message);
    return { error: error.message };
  }
}

const app = express();
const port = 3002;

// Initialize database and challenge generator
const db = new DaemonDB();
const challengeGen = new ChallengeGenerator();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public', { etag: false, maxAge: 0 }));

// SSE connections for real-time updates
const sseClients = new Set();
const recentEvents = []; // Store last 20 events for new clients
const MAX_RECENT_EVENTS = 20;

// Utility function to broadcast SSE events
function broadcastSSE(event, data) {
  const eventObj = { event, data, timestamp: new Date().toISOString() };
  recentEvents.unshift(eventObj);
  while (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.pop();
  
  // Persist to DB
  db.saveFeedEvent(event, data).catch(e => console.error('Failed to save feed event:', e));
  
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      sseClients.delete(client);
    }
  });
}

// Payment verification is now handled via direct ETH transactions

// Payment info endpoint for ETH payments
app.get('/api/match/payment-info', (req, res) => {
  res.json({
    status: 'active',
    entry_fee_eth: ENTRY_FEE_ETH,
    entry_fee_wei: ENTRY_FEE_WEI,
    network: 'eip155:8453',
    chain_id: 8453,
    chain: 'Base',
    rpc_url: BASE_RPC,
    payTo: ARENA_WALLET,
    instructions: [
      '1. Send exactly ' + ENTRY_FEE_ETH + ' ETH to ' + ARENA_WALLET + ' on Base mainnet',
      '2. Copy your transaction hash',
      '3. POST to /api/match/pay with { "txHash": "0x..." }',
      '4. Once verified, you can join matches via /api/match/queue'
    ],
    message: 'Direct ETH payments are required for match entry.'
  });
});

// Payment verification endpoint
app.post('/api/match/pay', authenticateAgent, async (req, res) => {
  const { txHash, matchId } = req.body;
  
  if (!txHash) {
    return res.status(400).json({ error: 'txHash is required' });
  }

  try {
    // Check if payment was already processed
    const existingPayment = await db.getPaymentByTxHash(txHash);
    if (existingPayment) {
      return res.status(400).json({ error: 'Transaction already processed' });
    }

    // Get transaction receipt
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    
    if (!receipt || receipt.status !== 'success') {
      return res.status(400).json({ error: 'Transaction not found or failed' });
    }

    // Get transaction details
    const tx = await publicClient.getTransaction({ hash: txHash });
    
    // Verify transaction parameters
    if (tx.to.toLowerCase() !== ARENA_WALLET.toLowerCase()) {
      return res.status(400).json({ 
        error: 'Transaction not sent to arena wallet',
        expected: ARENA_WALLET,
        actual: tx.to 
      });
    }

    if (BigInt(tx.value) < BigInt(ENTRY_FEE_WEI)) {
      return res.status(400).json({ 
        error: 'Insufficient payment amount',
        required: formatEther(BigInt(ENTRY_FEE_WEI)) + ' ETH',
        sent: formatEther(tx.value) + ' ETH'
      });
    }

    // Verify sender matches registered wallet
    if (!req.agent.wallet) {
      return res.status(400).json({ error: 'Agent has no registered wallet' });
    }

    if (tx.from.toLowerCase() !== req.agent.wallet.toLowerCase()) {
      return res.status(400).json({ 
        error: 'Transaction sender does not match registered wallet',
        expected: req.agent.wallet,
        actual: tx.from
      });
    }

    // Record payment in database
    const paymentId = await db.recordPayment(
      req.agent.id, 
      txHash, 
      tx.value.toString(), 
      tx.from,
      matchId
    );

    res.json({
      success: true,
      payment_id: paymentId,
      amount_paid: formatEther(tx.value) + ' ETH',
      message: 'Payment verified! You can now join matches.',
      tx_hash: txHash
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    
    if (error.message.includes('Transaction already processed')) {
      return res.status(400).json({ error: error.message });
    }
    
    if (error.message.includes('TransactionNotFound')) {
      return res.status(400).json({ error: 'Transaction not found on blockchain' });
    }
    
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// Matchmaking queue
const matchQueue = [];

// Authentication middleware
async function authenticateAgent(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    const agent = await db.getAgentByApiKey(apiKey);
    if (!agent) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.agent = agent;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// API Routes

// Step 1: Request registration challenge
app.post('/api/register/challenge', async (req, res) => {
  try {
    const { wallet, token_id } = req.body;
    
    if (!wallet || token_id === undefined) {
      return res.status(400).json({ error: 'wallet and token_id (ERC-8004) are required' });
    }

    const challenge = generateAuthChallenge(wallet, token_id);
    res.json({
      success: true,
      nonce: challenge.nonce,
      message: challenge.message,
      instructions: 'Sign this message with your wallet private key, then POST to /api/register with the signature'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Step 2: Complete registration with signature
app.post('/api/register', async (req, res) => {
  try {
    const { nonce, signature, name, endpoint, description } = req.body;
    
    if (!nonce || !signature || !name || !endpoint) {
      return res.status(400).json({ error: 'nonce, signature, name, and endpoint are required' });
    }

    // Verify signature + onchain ERC-8004 ownership
    const verification = await verifyRegistration(nonce, signature);

    const result = await db.registerAgent(
      name, 
      endpoint, 
      description, 
      verification.tokenId.toString(),
      verification.wallet
    );

    broadcastSSE('agent_registered', {
      name,
      token_id: verification.tokenId,
      wallet: verification.wallet.slice(0, 6) + '...' + verification.wallet.slice(-4)
    });

    res.json({
      success: true,
      agent_id: result.id,
      api_key: result.api_key,
      wallet: verification.wallet,
      token_id: verification.tokenId,
      message: 'Agent registered with verified ERC-8004 identity'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create practice match
app.post('/api/match/practice', authenticateAgent, async (req, res) => {
  const { challenge_type } = req.body;
  
  try {
    // Generate challenge with random type if not specified
    const finalChallengeType = challenge_type || 
      challengeGen.challengeTypes[Math.floor(Math.random() * challengeGen.challengeTypes.length)];
    
    // Use easy/medium difficulty only (1-2)
    const difficulty = Math.floor(Math.random() * 2) + 1;
    
    // Generate challenge seed and challenge
    const challengeSeed = crypto.randomBytes(16).toString('hex');
    const challenge = challengeGen.generateChallenge(finalChallengeType, difficulty, challengeSeed);
    
    // Create practice match with 5 minute timeout
    const matchId = await db.createPracticeMatch(
      req.agent.id,
      challenge.type,
      difficulty,
      challengeSeed,
      challenge,
      120 // 2 minutes
    );

    // Broadcast practice match creation
    broadcastSSE('practice_match_started', {
      match_id: matchId,
      agent: req.agent.name,
      challenge_type: challenge.type,
      difficulty: difficulty,
      is_practice: true
    });

    res.json({
      success: true,
      match_id: matchId,
      message: 'Practice match created! No entry fee required.',
      challenge: {
        type: challenge.type,
        title: challenge.title,
        description: challenge.description,
        time_limit: 120,
        difficulty: difficulty
      },
      is_practice: true
    });
  } catch (error) {
    console.error('Create practice match error:', error);
    res.status(500).json({ error: 'Failed to create practice match' });
  }
});

// Create custom match
app.post('/api/match/create', authenticateAgent, async (req, res) => {
  const { challengeType, entryFee, difficulty, txHash } = req.body;
  
  if (!challengeType || !entryFee) {
    return res.status(400).json({ error: 'challengeType and entryFee are required' });
  }

  // Validate entry fee
  const entryFeeWei = parseEther(entryFee).toString();
  const minFeeWei = parseEther('0.0001').toString();
  
  if (BigInt(entryFeeWei) < BigInt(minFeeWei)) {
    return res.status(400).json({ 
      error: 'Entry fee too low', 
      minimum: '0.0001 ETH',
      provided: entryFee + ' ETH'
    });
  }

  // If txHash provided, verify payment immediately
  if (txHash) {
    try {
      const existingPayment = await db.getPaymentByTxHash(txHash);
      if (existingPayment) {
        return res.status(400).json({ error: 'Transaction already processed' });
      }

      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (!receipt || receipt.status !== 'success') {
        return res.status(400).json({ error: 'Transaction not found or failed' });
      }

      const tx = await publicClient.getTransaction({ hash: txHash });
      
      if (tx.to.toLowerCase() !== ARENA_WALLET.toLowerCase()) {
        return res.status(400).json({ error: 'Transaction not sent to arena wallet' });
      }

      if (BigInt(tx.value) < BigInt(entryFeeWei)) {
        return res.status(400).json({ error: 'Insufficient payment amount' });
      }

      if (tx.from.toLowerCase() !== req.agent.wallet.toLowerCase()) {
        return res.status(400).json({ error: 'Transaction sender does not match registered wallet' });
      }
    } catch (error) {
      console.error('Payment verification error:', error);
      return res.status(400).json({ error: 'Payment verification failed' });
    }
  }

  try {
    // Generate challenge seed
    const challengeSeed = crypto.randomBytes(16).toString('hex');
    
    // Create custom match
    const matchId = await db.createCustomMatch(
      req.agent.id,
      challengeType === 'random' ? null : challengeType,
      entryFeeWei,
      difficulty || 3,
      challengeSeed
    );

    // If payment provided, record it
    if (txHash) {
      const tx = await publicClient.getTransaction({ hash: txHash });
      await db.recordPayment(req.agent.id, txHash, tx.value.toString(), tx.from, matchId);
    }

    broadcastSSE('match_created', {
      match_id: matchId,
      creator: req.agent.name,
      challenge_type: challengeType,
      entry_fee: entryFee + ' ETH'
    });

    res.json({
      success: true,
      match_id: matchId,
      entry_fee: entryFee + ' ETH',
      entry_fee_wei: entryFeeWei,
      challenge_type: challengeType,
      difficulty: difficulty || 3,
      message: txHash ? 'Custom match created and payment verified!' : 'Custom match created! Pay entry fee to finalize.'
    });
  } catch (error) {
    console.error('Create match error:', error);
    res.status(500).json({ error: 'Failed to create match' });
  }
});

// Get open matches
app.get('/api/matches/open', async (req, res) => {
  try {
    const matches = await db.getOpenMatches();
    res.json({
      matches: matches.map(match => ({
        id: match.id,
        challenge_type: match.challenge_type,
        entry_fee_eth: formatEther(BigInt(match.entry_fee_wei)),
        entry_fee_wei: match.entry_fee_wei,
        creator: {
          id: match.creator_id,
          name: match.creator_name,
          elo: match.creator_elo
        },
        difficulty: JSON.parse(match.challenge_data || '{}').difficulty || 3
      }))
    });
  } catch (error) {
    console.error('Get open matches error:', error);
    res.status(500).json({ error: 'Failed to get open matches' });
  }
});

// Join custom match
app.post('/api/match/:id/join', authenticateAgent, async (req, res) => {
  const matchId = req.params.id;
  const { txHash } = req.body;
  
  if (!txHash) {
    return res.status(400).json({ error: 'txHash is required for payment verification' });
  }

  try {
    // Get match details
    const match = await db.getMatch(matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (match.status !== 'open') {
      return res.status(400).json({ error: 'Match is not open for joining' });
    }

    if (match.creator_id === req.agent.id) {
      return res.status(400).json({ error: 'Cannot join your own match' });
    }

    // Verify payment
    const existingPayment = await db.getPaymentByTxHash(txHash);
    if (existingPayment) {
      return res.status(400).json({ error: 'Transaction already processed' });
    }

    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (!receipt || receipt.status !== 'success') {
      return res.status(400).json({ error: 'Transaction not found or failed' });
    }

    const tx = await publicClient.getTransaction({ hash: txHash });
    
    if (tx.to.toLowerCase() !== ARENA_WALLET.toLowerCase()) {
      return res.status(400).json({ error: 'Transaction not sent to arena wallet' });
    }

    if (BigInt(tx.value) < BigInt(match.entry_fee_wei)) {
      return res.status(400).json({ 
        error: 'Insufficient payment amount',
        required: formatEther(BigInt(match.entry_fee_wei)) + ' ETH',
        sent: formatEther(tx.value) + ' ETH'
      });
    }

    if (tx.from.toLowerCase() !== req.agent.wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Transaction sender does not match registered wallet' });
    }

    // Generate challenge using the stored seed
    const challenge = challengeGen.generateChallenge(
      match.challenge_type,
      3, // default difficulty for now
      match.challenge_seed
    );

    // Join the match
    await db.joinCustomMatch(matchId, req.agent.id, challenge, challenge.timeLimit);
    
    // Record payment
    await db.recordPayment(req.agent.id, txHash, tx.value.toString(), tx.from, matchId);

    // Broadcast match start
    const creator = await db.getAgent(match.creator_id);
    broadcastSSE('match_started', {
      match_id: matchId,
      creator: creator.name,
      opponent: req.agent.name,
      challenge_type: challenge.type,
      entry_fee: formatEther(BigInt(match.entry_fee_wei)) + ' ETH'
    });

    res.json({
      success: true,
      match_id: matchId,
      message: 'Successfully joined match!',
      challenge: {
        type: challenge.type,
        title: challenge.title,
        description: challenge.description,
        time_limit: challenge.timeLimit
      }
    });
  } catch (error) {
    console.error('Join match error:', error);
    res.status(500).json({ error: 'Failed to join match' });
  }
});

// Join matchmaking queue (updated for quick matches)
app.post('/api/match/queue', authenticateAgent, async (req, res) => {
  const { challenge_type, difficulty } = req.body;
  
  // Quick matches use default entry fee
  const quickMatchFeeWei = ENTRY_FEE_WEI; // 0.0001 ETH
  
  // Check if agent can afford quick match
  const canAfford = await db.canAgentAffordMatch(req.agent.id, quickMatchFeeWei);
  if (!canAfford) {
    return res.status(402).json({ 
      error: 'Insufficient payment balance', 
      message: 'You need at least ' + ENTRY_FEE_ETH + ' ETH for quick matches. See /api/match/payment-info for details.'
    });
  }
  
  // Check if agent is already in queue
  const existingIndex = matchQueue.findIndex(entry => entry.agent.id === req.agent.id);
  if (existingIndex !== -1) {
    return res.status(400).json({ error: 'Already in queue' });
  }

  // Add to queue
  const queueEntry = {
    agent: req.agent,
    challenge_type: challenge_type || null,
    difficulty: difficulty || Math.floor(Math.random() * 3) + 1,
    joined_at: new Date()
  };
  
  matchQueue.push(queueEntry);

  // Try to find a match
  const match = await tryMatchmaking();
  
  if (match) {
    res.json({
      success: true,
      match_id: match.id,
      message: 'Match found!'
    });
  } else {
    res.json({
      success: true,
      message: 'Added to queue, waiting for opponent...',
      queue_position: matchQueue.length
    });
  }
});

// Try to create matches from queue
async function tryMatchmaking() {
  if (matchQueue.length < 2) return null;

  // Simple matching - take first two agents
  const agent1Entry = matchQueue.shift();
  const agent2Entry = matchQueue.shift();

  // Generate challenge with random seed
  const challengeType = agent1Entry.challenge_type || agent2Entry.challenge_type;
  const difficulty = Math.max(agent1Entry.difficulty, agent2Entry.difficulty);
  const challengeSeed = crypto.randomBytes(16).toString('hex');
  const challenge = challengeGen.generateChallenge(challengeType, difficulty, challengeSeed);

  try {
    // Create quick match in database with default entry fee
    const quickMatchFeeWei = ENTRY_FEE_WEI;
    const potWei = (BigInt(quickMatchFeeWei) * 2n).toString();
    const arenaCutWei = (BigInt(potWei) / 10n).toString(); // 10% cut
    const winnerPayoutWei = (BigInt(potWei) - BigInt(arenaCutWei)).toString();

    const matchId = await db.run(`
      INSERT INTO matches (
        id, agent1_id, agent2_id, challenge_type, challenge_data, time_limit,
        entry_fee_wei, creator_id, opponent_id, status, challenge_seed,
        pot_wei, arena_cut_wei, winner_payout_wei, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      crypto.randomUUID(),
      agent1Entry.agent.id,
      agent2Entry.agent.id, 
      challenge.type,
      JSON.stringify(challenge),
      challenge.timeLimit,
      quickMatchFeeWei,
      agent1Entry.agent.id, // creator is first agent
      agent2Entry.agent.id, // opponent is second agent
      challengeSeed,
      potWei,
      arenaCutWei,
      winnerPayoutWei
    ]);

    const finalMatchId = matchId.lastID ? matchId.lastID.toString() : crypto.randomUUID();

    // Broadcast match start
    broadcastSSE('match_started', {
      match_id: finalMatchId,
      agent1: agent1Entry.agent.name,
      agent2: agent2Entry.agent.name,
      challenge_type: challenge.type,
      entry_fee: ENTRY_FEE_ETH + ' ETH'
    });

    return { id: finalMatchId, challenge };
  } catch (error) {
    console.error('Matchmaking error:', error);
    return null;
  }
}

// Get match details
app.get('/api/match/:id', async (req, res) => {
  try {
    const match = await db.getMatch(req.params.id);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const submissions = await db.getMatchSubmissions(match.id);
    
    // Add agent names
    const agent1 = match.agent1_id ? await db.getAgent(match.agent1_id) : null;
    const agent2 = match.agent2_id ? await db.getAgent(match.agent2_id) : null;
    
    // SECURITY: Strip answers/solutions from challenge data before sending
    const safeChallenge = { ...match.challenge_data };
    delete safeChallenge.answer;
    delete safeChallenge.solution;
    delete safeChallenge.plaintext;
    delete safeChallenge.key;
    // For code_golf: strip expected values from test cases, keep only inputs
    if (safeChallenge.testCases) {
      safeChallenge.testCases = safeChallenge.testCases.map(tc => ({
        input: tc.input,
        description: tc.description || undefined
      }));
    }
    
    // SECURITY: Strip solutions from submissions (only show own if authenticated)
    const apiKey = req.headers['x-api-key'] || req.headers['x-api_key'];
    const requestingAgent = apiKey ? await db.getAgentByApiKey(apiKey) : null;
    const isCompleted = match.status === 'completed';
    const safeSubmissions = submissions.map(sub => ({
      agent_id: sub.agent_id,
      agent_name: sub.agent_name,
      correct: sub.correct,
      score: sub.score,
      submitted_at: sub.submitted_at,
      // Show all solutions once match is completed (replay mode)
      // During active match, only show own solution
      solution: isCompleted ? sub.solution : 
        (requestingAgent && sub.agent_id === requestingAgent.id) ? sub.solution : undefined
    }));
    
    res.json({
      ...match,
      challenge_data: safeChallenge,
      agent1_name: agent1?.name || null,
      agent1_elo: agent1?.elo || null,
      agent2_name: agent2?.name || null,
      agent2_elo: agent2?.elo || null,
      submissions: safeSubmissions
    });
  } catch (error) {
    console.error('Get match error:', error);
    res.status(500).json({ error: 'Failed to get match' });
  }
});

// Submit solution to match
app.post('/api/match/:id/submit', authenticateAgent, async (req, res) => {
  const matchId = req.params.id;
  const { solution } = req.body;

  if (!solution) {
    return res.status(400).json({ error: 'Solution is required' });
  }

  try {
    const match = await db.getMatch(matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (match.status !== 'active') {
      return res.status(400).json({ error: 'Match is not active' });
    }

    // Check if agent is part of this match
    if (match.agent1_id !== req.agent.id && match.agent2_id !== req.agent.id) {
      return res.status(403).json({ error: 'Not authorized for this match' });
    }

    // Check if agent already submitted
    const existingSubmissions = await db.getMatchSubmissions(matchId);
    const alreadySubmitted = existingSubmissions.some(sub => sub.agent_id === req.agent.id);
    if (alreadySubmitted) {
      return res.status(400).json({ error: 'Already submitted solution' });
    }

    // Validate solution
    const validation = await challengeGen.validateSolution(match.challenge_data, solution);
    
    // Submit to database
    const submissionId = await db.submitSolution(matchId, req.agent.id, solution);
    
    if (validation.valid) {
      await db.markSubmissionCorrect(submissionId, validation.score);
      
      // Handle practice match logic
      if (match.is_practice) {
        // Agent got correct solution - they win immediately
        await db.completeMatch(matchId, req.agent.id);
        
        broadcastSSE('practice_match_completed', {
          match_id: matchId,
          agent: req.agent.name,
          winner: req.agent.name,
          solution_type: match.challenge_data.type,
          is_practice: true,
          result: 'agent_won'
        });
      } else {
        // Regular match logic
        // Check if this is the first correct solution
        const allSubmissions = await db.getMatchSubmissions(matchId);
        const correctSubmissions = allSubmissions.filter(sub => sub.correct);
        
        if (correctSubmissions.length === 1) {
          // First correct solution wins
          await db.completeMatch(matchId, req.agent.id);
          
          // Send payout to winner
          const completedMatch = await db.getMatch(matchId);
          if (completedMatch && completedMatch.winner_payout_wei && req.agent.wallet) {
            sendPayout(matchId, req.agent.wallet, completedMatch.winner_payout_wei)
              .then(r => console.log(`[PAYOUT] Match ${matchId} result:`, r))
              .catch(e => console.error(`[PAYOUT] Match ${matchId} error:`, e));
          }
          
          broadcastSSE('match_completed', {
            match_id: matchId,
            winner: req.agent.name,
            solution_type: match.challenge_data.type
          });
        }
      }
    } else {
      // Handle practice match incorrect solution
      if (match.is_practice) {
        // Agent got wrong solution - PracticeBot wins after 5 seconds
        setTimeout(async () => {
          try {
            const practiceBot = await db.getPracticeBot();
            await db.completeMatch(matchId, practiceBot.id);
            
            broadcastSSE('practice_match_completed', {
              match_id: matchId,
              winner: 'PracticeBot',
              solution_type: match.challenge_data.type,
              is_practice: true,
              result: 'bot_won'
            });
          } catch (error) {
            console.error('Practice match completion error:', error);
          }
        }, 5000); // 5 second delay
      }
    }

    // Broadcast submission
    broadcastSSE('solution_submitted', {
      match_id: matchId,
      agent: req.agent.name,
      correct: validation.valid,
      score: validation.score
    });

    res.json({
      success: true,
      validation: validation,
      submission_id: submissionId
    });
  } catch (error) {
    console.error('Submit solution error:', error);
    res.status(500).json({ error: 'Failed to submit solution' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const leaderboard = await db.getLeaderboard(limit);
    res.json(leaderboard.map(a => ({ ...a, erc8004_token_id: a.erc8004_identity || null })));
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// Get agent profile
app.get('/api/agent/:id', async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const matches = await db.getAgentMatches(agent.id, 20);
    
    // Remove sensitive data, map fields for frontend
    const { api_key, erc8004_identity, ...publicAgent } = agent;
    
    // SECURITY: Strip answers from match challenge data
    const safeMatches = matches.map(m => {
      const cd = { ...m.challenge_data };
      delete cd.answer; delete cd.solution; delete cd.plaintext; delete cd.key;
      if (cd.testCases) cd.testCases = cd.testCases.map(tc => ({ input: tc.input }));
      return { ...m, challenge_data: cd };
    });
    
    res.json({
      ...publicAgent,
      erc8004_identity,
      erc8004_token_id: erc8004_identity || null,
      recent_matches: safeMatches
    });
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// Get agent battles
app.get('/api/agent/:id/battles', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const agent = await db.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const matches = await db.getAgentMatches(agent.id, limit, offset);
    // SECURITY: Strip answers
    const safeMatches = matches.map(m => {
      const cd = { ...m.challenge_data };
      delete cd.answer; delete cd.solution; delete cd.plaintext; delete cd.key;
      if (cd.testCases) cd.testCases = cd.testCases.map(tc => ({ input: tc.input }));
      return { ...m, challenge_data: cd };
    });
    res.json(safeMatches);
  } catch (error) {
    console.error('Get agent battles error:', error);
    res.status(500).json({ error: 'Failed to get battles' });
  }
});

// Get available challenge types
app.get('/api/challenges/types', (req, res) => {
  res.json(challengeGen.getChallengeTypes());
});

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  sseClients.add(res);

  res.on('close', () => {
    sseClients.delete(res);
  });

  // Send initial connection event
  res.write('event: connected\ndata: {"message": "Connected to Daemon Arena"}\n\n');
});

// Recent events endpoint (for page load)
app.get('/api/events/recent', async (req, res) => {
  try {
    const events = await db.getRecentFeedEvents(20);
    res.json(events);
  } catch (e) {
    // Fallback to in-memory
    res.json(recentEvents);
  }
});

// Active matches with full details
app.get('/api/matches/active', async (req, res) => {
  try {
    const matches = await db.getActiveMatches();
    const result = [];
    for (const match of matches) {
      const submissions = await db.getMatchSubmissions(match.id);
      result.push({
        ...match,
        challenge_data: (() => {
          const cd = typeof match.challenge_data === 'string' ? JSON.parse(match.challenge_data) : { ...match.challenge_data };
          delete cd.answer; delete cd.solution; delete cd.plaintext; delete cd.key;
          if (cd.testCases) cd.testCases = cd.testCases.map(tc => ({ input: tc.input }));
          return cd;
        })(),
        submissions: submissions.map(s => ({
          agent_id: s.agent_id,
          agent_name: s.agent_name,
          correct: s.correct,
          score: s.score,
          submitted_at: s.submitted_at
        }))
      });
    }
    res.json({ matches: result });
  } catch (error) {
    console.error('Active matches error:', error);
    res.json({ matches: [] });
  }
});

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

app.get('/match/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'match.html'));
});

app.get('/agent/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agent.html'));
});

app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api-docs.html'));
});

app.get('/SKILL.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'SKILL.md'));
});

// Background task to check for timed out matches
setInterval(async () => {
  try {
    // This would check for matches that have exceeded their time limit
    // and complete them with a draw or timeout result
    const activeMatches = await db.getActiveMatches();
    const now = new Date();
    
    for (const match of activeMatches) {
      if (match.started_at) {
        const matchStart = new Date(match.started_at + 'Z'); // SQLite stores UTC
        const elapsed = (now - matchStart) / 1000; // seconds
        
        if (elapsed > match.time_limit) {
          // Check submissions to determine winner or draw
          const submissions = await db.getMatchSubmissions(match.id);
          const correctSubmissions = submissions.filter(sub => sub.correct);
          
          if (match.is_practice) {
            // Practice match timeout - PracticeBot wins
            const practiceBot = await db.getPracticeBot();
            await db.completeMatch(match.id, practiceBot.id);
            broadcastSSE('practice_match_timeout', {
              match_id: match.id,
              winner: 'PracticeBot',
              is_practice: true,
              result: 'timeout'
            });
          } else {
            // Regular match timeout logic
            if (correctSubmissions.length === 0) {
              // No correct solutions - draw
              await db.completeMatch(match.id, null);
              broadcastSSE('match_timeout', {
                match_id: match.id,
                result: 'draw',
                message: 'Match ended in draw - no correct solutions'
              });
            } else {
              // Find best solution
              const bestSubmission = correctSubmissions.reduce((best, current) => 
                current.score > best.score ? current : best
              );
              await db.completeMatch(match.id, bestSubmission.agent_id);
              // Send payout to winner
              if (match.winner_payout_wei) {
                const winnerAgent = await db.getAgent(bestSubmission.agent_id);
                if (winnerAgent && winnerAgent.wallet) {
                  sendPayout(match.id, winnerAgent.wallet, match.winner_payout_wei)
                    .then(r => console.log(`[PAYOUT] Timeout match ${match.id} result:`, r))
                    .catch(e => console.error(`[PAYOUT] Timeout match ${match.id} error:`, e));
                }
              }
              broadcastSSE('match_timeout', {
                match_id: match.id,
                winner_id: bestSubmission.agent_id,
                message: 'Match completed on timeout'
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Timeout check error:', error);
  }
}, 10000); // Check every 10 seconds

// Start server
app.listen(port, () => {
  console.log(`🔥 Daemon Arena running on port ${port}`);
  console.log(`👹 The arena awaits at http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔥 Shutting down Daemon Arena...');
  db.close();
  process.exit(0);
});