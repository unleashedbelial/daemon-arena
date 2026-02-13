const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

class DaemonDB {
  constructor(dbPath = 'daemon-arena.db') {
    this.db = new sqlite3.Database(dbPath);
    this.initTables();
    this.runMigrations();
    this.seedPracticeBot();
  }

  initTables() {
    // Serialize to ensure tables are created in order
    this.db.serialize(() => {
      // Agents table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          endpoint TEXT NOT NULL,
          description TEXT,
          api_key TEXT UNIQUE NOT NULL,
          elo INTEGER DEFAULT 1000,
          wins INTEGER DEFAULT 0,
          losses INTEGER DEFAULT 0,
          draws INTEGER DEFAULT 0,
          erc8004_identity TEXT,
          wallet TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Matches table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY,
          agent1_id TEXT NOT NULL,
          agent2_id TEXT NOT NULL,
          challenge_type TEXT NOT NULL,
          challenge_data TEXT NOT NULL,
          status TEXT DEFAULT 'waiting',
          winner_id TEXT,
          started_at DATETIME,
          completed_at DATETIME,
          time_limit INTEGER NOT NULL,
          entry_fee_wei TEXT DEFAULT '100000000000000',
          creator_id TEXT,
          opponent_id TEXT,
          pot_wei TEXT DEFAULT '0',
          arena_cut_wei TEXT DEFAULT '0', 
          winner_payout_wei TEXT DEFAULT '0',
          challenge_seed TEXT,
          FOREIGN KEY (agent1_id) REFERENCES agents(id),
          FOREIGN KEY (agent2_id) REFERENCES agents(id),
          FOREIGN KEY (winner_id) REFERENCES agents(id),
          FOREIGN KEY (creator_id) REFERENCES agents(id),
          FOREIGN KEY (opponent_id) REFERENCES agents(id)
        )
      `);

      // Submissions table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS submissions (
          id TEXT PRIMARY KEY,
          match_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          solution TEXT NOT NULL,
          correct BOOLEAN DEFAULT FALSE,
          score INTEGER DEFAULT 0,
          submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (match_id) REFERENCES matches(id),
          FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
      `);

      // Challenges table (for pre-generated challenges)
      this.db.run(`
        CREATE TABLE IF NOT EXISTS challenges (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          difficulty INTEGER NOT NULL,
          data TEXT NOT NULL,
          answer TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Payments table for ETH transaction tracking
      this.db.run(`
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          tx_hash TEXT UNIQUE NOT NULL,
          amount_wei TEXT NOT NULL,
          from_wallet TEXT NOT NULL,
          match_id TEXT,
          verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (agent_id) REFERENCES agents(id),
          FOREIGN KEY (match_id) REFERENCES matches(id)
        )
      `);

      // Agent payment status tracking
      this.db.run(`
        CREATE TABLE IF NOT EXISTS agent_payment_status (
          agent_id TEXT PRIMARY KEY,
          paid BOOLEAN DEFAULT FALSE,
          last_payment_id TEXT,
          FOREIGN KEY (agent_id) REFERENCES agents(id),
          FOREIGN KEY (last_payment_id) REFERENCES payments(id)
        )
      `);
    });
  }

  runMigrations() {
    this.db.serialize(() => {
      // Add new columns to matches table for custom matches feature
      this.db.run(`ALTER TABLE matches ADD COLUMN entry_fee_wei TEXT DEFAULT '100000000000000'`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN creator_id TEXT`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN opponent_id TEXT`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN pot_wei TEXT DEFAULT '0'`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN arena_cut_wei TEXT DEFAULT '0'`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN winner_payout_wei TEXT DEFAULT '0'`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN challenge_seed TEXT`, () => {});
      
      // Add match_id to payments table
      this.db.run(`ALTER TABLE payments ADD COLUMN match_id TEXT`, () => {});
      
      // Add is_practice column for practice matches
      this.db.run(`ALTER TABLE matches ADD COLUMN is_practice INTEGER DEFAULT 0`, () => {});
      
      // Add elo_change columns
      this.db.run(`ALTER TABLE matches ADD COLUMN elo_change_agent1 INTEGER DEFAULT 0`, () => {});
      this.db.run(`ALTER TABLE matches ADD COLUMN elo_change_agent2 INTEGER DEFAULT 0`, () => {});

      // Feed events table for persistent live feed
      this.db.run(`
        CREATE TABLE IF NOT EXISTS feed_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    });
  }

  // Convert callback-based methods to Promise-based for easier async/await usage
  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Agent operations
  async registerAgent(name, endpoint, description, erc8004_identity = null, wallet = null) {
    const id = crypto.randomUUID();
    const api_key = 'dk_' + crypto.randomBytes(32).toString('hex');
    
    try {
      await this.run(`
        INSERT INTO agents (id, name, endpoint, description, api_key, erc8004_identity, wallet)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [id, name, endpoint, description, api_key, erc8004_identity, wallet]);
      
      return { id, api_key };
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('Agent name already exists');
      }
      throw error;
    }
  }

  async getAgent(id) {
    return await this.get('SELECT * FROM agents WHERE id = ?', [id]);
  }

  async getAgentByApiKey(apiKey) {
    return await this.get('SELECT * FROM agents WHERE api_key = ?', [apiKey]);
  }

  async getLeaderboard(limit = 50) {
    return await this.all(`
      SELECT id, name, elo, wins, losses, draws, erc8004_identity, wallet,
             (wins + losses + draws) as total_matches
      FROM agents 
      ORDER BY elo DESC 
      LIMIT ?
    `, [limit]);
  }

  // Match operations
  async createMatch(agent1Id, agent2Id, challengeType, challengeData, timeLimit) {
    const id = crypto.randomUUID();
    await this.run(`
      INSERT INTO matches (id, agent1_id, agent2_id, challenge_type, challenge_data, time_limit)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, agent1Id, agent2Id, challengeType, JSON.stringify(challengeData), timeLimit]);
    
    return id;
  }

  // Custom match creation (for the new feature)
  async createCustomMatch(creatorId, challengeType, entryFeeWei, difficulty, challengeSeed) {
    const id = crypto.randomUUID();
    await this.run(`
      INSERT INTO matches (
        id, agent1_id, agent2_id, challenge_type, challenge_data, time_limit, entry_fee_wei, creator_id, status, challenge_seed
      ) VALUES (?, ?, '', ?, '{}', 300, ?, ?, 'open', ?)
    `, [id, creatorId, challengeType, entryFeeWei, creatorId, challengeSeed]);
    
    return id;
  }

  // Join a custom match
  async joinCustomMatch(matchId, opponentId, challengeData, timeLimit) {
    const entryFeeWei = await this.get('SELECT entry_fee_wei FROM matches WHERE id = ?', [matchId]);
    const potWei = (BigInt(entryFeeWei.entry_fee_wei) * 2n).toString();
    const arenaCutWei = (BigInt(potWei) / 10n).toString(); // 10% cut
    const winnerPayoutWei = (BigInt(potWei) - BigInt(arenaCutWei)).toString();

    await this.run(`
      UPDATE matches 
      SET agent2_id = ?, opponent_id = ?, status = 'active', 
          challenge_data = ?, time_limit = ?, started_at = CURRENT_TIMESTAMP,
          pot_wei = ?, arena_cut_wei = ?, winner_payout_wei = ?
      WHERE id = ?
    `, [opponentId, opponentId, JSON.stringify(challengeData), timeLimit, 
        potWei, arenaCutWei, winnerPayoutWei, matchId]);
  }

  // Get open matches waiting for opponents
  async getOpenMatches() {
    const matches = await this.all(`
      SELECT m.id, m.challenge_type, m.entry_fee_wei, m.creator_id, m.challenge_seed,
             a.name as creator_name, a.elo as creator_elo
      FROM matches m
      JOIN agents a ON m.creator_id = a.id
      WHERE m.status = 'open'
      ORDER BY m.rowid DESC
    `);
    
    return matches;
  }

  async getMatch(id) {
    const match = await this.get('SELECT * FROM matches WHERE id = ?', [id]);
    if (match) {
      match.challenge_data = JSON.parse(match.challenge_data);
    }
    return match;
  }

  async startMatch(matchId) {
    await this.run(`
      UPDATE matches 
      SET status = 'active', started_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [matchId]);
  }

  async completeMatch(matchId, winnerId) {
    await this.run(`
      UPDATE matches 
      SET status = 'completed', winner_id = ?, completed_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [winnerId, matchId]);
    
    // Update ELO ratings
    await this.updateELO(matchId, winnerId);
    
    // Handle payout for custom matches
    await this.handleMatchPayout(matchId, winnerId);
  }

  // Match payout handling (moved to bottom to handle practice matches)

  // Submission operations
  async submitSolution(matchId, agentId, solution) {
    const id = crypto.randomUUID();
    await this.run(`
      INSERT INTO submissions (id, match_id, agent_id, solution)
      VALUES (?, ?, ?, ?)
    `, [id, matchId, agentId, solution]);
    
    return id;
  }

  async markSubmissionCorrect(submissionId, score = 100) {
    await this.run(`
      UPDATE submissions 
      SET correct = TRUE, score = ? 
      WHERE id = ?
    `, [score, submissionId]);
  }

  async getMatchSubmissions(matchId) {
    return await this.all(`
      SELECT s.*, a.name as agent_name 
      FROM submissions s 
      LEFT JOIN agents a ON s.agent_id = a.id 
      WHERE s.match_id = ? 
      ORDER BY s.submitted_at
    `, [matchId]);
  }

  // ELO rating system (moved to bottom to handle practice matches)

  async getAgentMatches(agentId, limit = 20, offset = 0) {
    const matches = await this.all(`
      SELECT m.*, 
             a1.name as agent1_name, 
             a2.name as agent2_name
      FROM matches m
      LEFT JOIN agents a1 ON m.agent1_id = a1.id
      LEFT JOIN agents a2 ON m.agent2_id = a2.id
      WHERE m.agent1_id = ? OR m.agent2_id = ? OR m.creator_id = ? OR m.opponent_id = ?
      ORDER BY m.started_at DESC
      LIMIT ? OFFSET ?
    `, [agentId, agentId, agentId, agentId, limit, offset]);
    
    return matches.map(match => ({
      ...match,
      challenge_data: JSON.parse(match.challenge_data)
    }));
  }

  async getActiveMatches() {
    const matches = await this.all(`
      SELECT m.*, 
             a1.name as agent1_name, 
             a2.name as agent2_name
      FROM matches m
      LEFT JOIN agents a1 ON m.agent1_id = a1.id
      LEFT JOIN agents a2 ON m.agent2_id = a2.id
      WHERE m.status IN ('waiting', 'active')
      ORDER BY m.started_at DESC
    `);
    
    return matches.map(match => ({
      ...match,
      challenge_data: JSON.parse(match.challenge_data)
    }));
  }

  // Payment operations
  async recordPayment(agentId, txHash, amountWei, fromWallet, matchId = null) {
    const paymentId = crypto.randomUUID();
    
    try {
      await this.run(`
        INSERT INTO payments (id, agent_id, tx_hash, amount_wei, from_wallet, match_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [paymentId, agentId, txHash, amountWei, fromWallet, matchId]);
      
      // Update payment status
      await this.run(`
        INSERT OR REPLACE INTO agent_payment_status (agent_id, paid, last_payment_id)
        VALUES (?, TRUE, ?)
      `, [agentId, paymentId]);
      
      return paymentId;
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('Transaction hash already used');
      }
      throw error;
    }
  }

  async getPaymentByTxHash(txHash) {
    return await this.get('SELECT * FROM payments WHERE tx_hash = ?', [txHash]);
  }

  async isAgentPaid(agentId) {
    const status = await this.get('SELECT paid FROM agent_payment_status WHERE agent_id = ?', [agentId]);
    return status ? status.paid : false;
  }

  async getAgentPaymentBalance(agentId) {
    const result = await this.get(`
      SELECT COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) as total_paid
      FROM payments 
      WHERE agent_id = ?
    `, [agentId]);
    return result ? result.total_paid.toString() : '0';
  }

  async canAgentAffordMatch(agentId, entryFeeWei) {
    const balance = await this.getAgentPaymentBalance(agentId);
    return BigInt(balance) >= BigInt(entryFeeWei);
  }

  async getAgentPaymentHistory(agentId) {
    return await this.all(`
      SELECT * FROM payments 
      WHERE agent_id = ? 
      ORDER BY verified_at DESC
    `, [agentId]);
  }

  // Seed PracticeBot if it doesn't exist
  async seedPracticeBot() {
    try {
      const existingBot = await this.get('SELECT * FROM agents WHERE name = ?', ['PracticeBot']);
      if (!existingBot) {
        console.log('[DB] Creating PracticeBot...');
        await this.run(`
          INSERT INTO agents (
            id, name, endpoint, description, api_key, elo, 
            wins, losses, draws, wallet, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
          'practice-bot-001',
          'PracticeBot', 
          'internal://practice-bot',
          'Built-in practice opponent for testing challenges',
          'practice_bot_internal_key',
          1000,
          0, 0, 0,
          '0x0000000000000000000000000000000000000000'
        ]);
        console.log('[DB] PracticeBot created successfully');
      }
    } catch (error) {
      console.error('[DB] Error seeding PracticeBot:', error);
    }
  }

  // Get PracticeBot
  async getPracticeBot() {
    return await this.get('SELECT * FROM agents WHERE name = ?', ['PracticeBot']);
  }

  // Create practice match
  async createPracticeMatch(agentId, challengeType, difficulty, challengeSeed, challengeData, timeLimit = 300) {
    const id = crypto.randomUUID();
    const practiceBot = await this.getPracticeBot();
    
    if (!practiceBot) {
      throw new Error('PracticeBot not found');
    }
    
    await this.run(`
      INSERT INTO matches (
        id, agent1_id, agent2_id, challenge_type, challenge_data, time_limit,
        entry_fee_wei, creator_id, opponent_id, status, challenge_seed,
        pot_wei, arena_cut_wei, winner_payout_wei, started_at, is_practice
      ) VALUES (?, ?, ?, ?, ?, ?, '0', ?, ?, 'active', ?, '0', '0', '0', CURRENT_TIMESTAMP, 1)
    `, [
      id, agentId, practiceBot.id, challengeType, JSON.stringify(challengeData),
      timeLimit, agentId, practiceBot.id, challengeSeed
    ]);
    
    return id;
  }

  // Update ELO ratings (skip for practice matches)
  async updateELO(matchId, winnerId) {
    const match = await this.getMatch(matchId);
    if (!match) return;
    
    // Skip ELO updates for practice matches
    if (match.is_practice) {
      console.log(`[DB] Skipping ELO update for practice match ${matchId}`);
      return;
    }

    const agent1 = await this.getAgent(match.agent1_id);
    const agent2 = await this.getAgent(match.agent2_id);
    
    const K = 32; // ELO K-factor
    const expectedScore1 = 1 / (1 + Math.pow(10, (agent2.elo - agent1.elo) / 400));
    const expectedScore2 = 1 - expectedScore1;

    let actualScore1, actualScore2;
    if (!winnerId) {
      // Draw
      actualScore1 = actualScore2 = 0.5;
    } else if (winnerId === match.agent1_id) {
      // Agent 1 wins
      actualScore1 = 1;
      actualScore2 = 0;
    } else {
      // Agent 2 wins
      actualScore1 = 0;
      actualScore2 = 1;
    }

    const newElo1 = Math.round(agent1.elo + K * (actualScore1 - expectedScore1));
    const newElo2 = Math.round(agent2.elo + K * (actualScore2 - expectedScore2));

    // Store ELO changes on the match
    const eloChange1 = newElo1 - agent1.elo;
    const eloChange2 = newElo2 - agent2.elo;
    await this.run(`UPDATE matches SET elo_change_agent1 = ?, elo_change_agent2 = ? WHERE id = ?`,
      [eloChange1, eloChange2, matchId]);

    // Update ELOs and win/loss records
    if (!winnerId) {
      await this.run(`
        UPDATE agents 
        SET elo = ?, draws = draws + 1
        WHERE id = ?
      `, [newElo1, match.agent1_id]);
      
      await this.run(`
        UPDATE agents 
        SET elo = ?, draws = draws + 1
        WHERE id = ?
      `, [newElo2, match.agent2_id]);
    } else if (winnerId === match.agent1_id) {
      await this.run(`
        UPDATE agents 
        SET elo = ?, wins = wins + 1
        WHERE id = ?
      `, [newElo1, match.agent1_id]);
      
      await this.run(`
        UPDATE agents 
        SET elo = ?, losses = losses + 1
        WHERE id = ?
      `, [newElo2, match.agent2_id]);
    } else {
      await this.run(`
        UPDATE agents 
        SET elo = ?, losses = losses + 1
        WHERE id = ?
      `, [newElo1, match.agent1_id]);
      
      await this.run(`
        UPDATE agents 
        SET elo = ?, wins = wins + 1
        WHERE id = ?
      `, [newElo2, match.agent2_id]);
    }
  }

  // Handle match payout (skip for practice matches)
  async handleMatchPayout(matchId, winnerId) {
    const match = await this.getMatch(matchId);
    if (!match || !match.winner_payout_wei || match.winner_payout_wei === '0') {
      return; // No payout needed for this match
    }
    
    // Skip payouts for practice matches
    if (match.is_practice) {
      console.log(`[DB] Skipping payout for practice match ${matchId}`);
      return;
    }
    
    // In a real implementation, you would:
    // 1. Transfer winner_payout_wei to the winner's wallet
    // 2. Keep arena_cut_wei in the arena wallet
    // 3. Record the payout transaction
    
    // For now, we just log the payout
    console.log(`Match ${matchId} completed. Payout: ${match.winner_payout_wei} wei to winner ${winnerId}, Arena cut: ${match.arena_cut_wei} wei`);
  }

  close() {
    this.db.close();
  }
  async saveFeedEvent(event, data) {
    await this.run(`INSERT INTO feed_events (event, data) VALUES (?, ?)`,
      [event, JSON.stringify(data)]);
    // Keep only last 100 events
    await this.run(`DELETE FROM feed_events WHERE id NOT IN (SELECT id FROM feed_events ORDER BY id DESC LIMIT 100)`);
  }

  async getRecentFeedEvents(limit = 20) {
    const rows = await this.all(`SELECT * FROM feed_events ORDER BY id DESC LIMIT ?`, [limit]);
    return rows.map(r => ({
      event: r.event,
      data: JSON.parse(r.data),
      timestamp: r.created_at
    }));
  }
}

module.exports = DaemonDB;