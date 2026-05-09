/**
 * Gorecat Contract
 * Handles player profiles, coinpack purchases, leaderboards, and analytics tracking
 * 
 */

const state = {
  metadata: {
    name: "Gorecat",
    description: "Player profiles, coinpacks, battlepass, weapon re-roll, leaderboards, and analytics for GorecatPSG1",
    version: "1.1.0",
  },

  // Contract deployer
  deployer: null,

  // Additional admins with full access (deployer can add/remove)
  admins: [],

  // Player profiles indexed by wallet address
  // wallet -> { cash, gunsUnlocked, coinpacksPurchased, displayName, registeredAt, lastActive, totalSpent }
  players: {},

  // 5-digit display names mapping (to ensure uniqueness)
  // displayName -> wallet
  displayNames: {},

  // Leaderboard cache (top 100, sorted by cash)
  leaderboardCache: [],
  leaderboardLastUpdated: 0,

  // Coinpack definitions
  // packId -> { name, coins, priceSOL, bonusCoins, isActive }
  coinpacks: {},

  // Analytics for monetization tracking (ONLY updated by real purchases)
  analytics: {
    totalPurchases: 0,
    totalRevenueSOL: 0,
    totalCoinsDistributed: 0,

    // Purchase history (recent - older entries archived to R2)
    purchaseHistory: [],
    purchaseHistoryMaxSize: 500, // Archive when exceeds this

    // Archived purchase history references
    // Array of { url, count, archivedAt, dateRange }
    purchaseHistoryArchives: [],

    // Daily aggregated stats (recent 90 days - older archived)
    // "YYYY-MM-DD" -> { purchases, revenueSOL, uniqueBuyers, coinsDistributed }
    dailyStats: {},

    // Archived daily stats references
    dailyStatsArchives: [],

    // Per-coinpack stats
    // packId -> { timesPurchased, totalRevenueSOL, totalCoinsGiven }
    coinpackStats: {},

    // Unique buyer tracking
    uniqueBuyersCount: 0,
    uniqueBuyers: {}, // wallet -> firstPurchaseDate

    // Retention metrics
    returningBuyersCount: 0,

    // Gun unlock tracking
    totalGunsUnlocked: 0,
    gunUnlockStats: {} // gunId -> timesUnlocked
  },

  // Treasury wallet for receiving payments (blackbox index 0)
  treasuryPublicKey: null,

  // Discount mode (50% off all packs)
  discountActive: false,
  discountPercent: 50,

  // Rate limiting
  lastActionTime: {},

  // Tournaments
  tournaments: {
    marchmayhem: {
      name: "March Mayhem",
      endsAt: 1773604800000,   // March 15, 2026 12:00 PM PST (20:00 UTC)
      platform: "psg1",
      minGamesPlayed: 1,
      status: "active",        // "active" or "finalized"
      finalizedAt: null,
      snapshot: null            // populated on finalize
    }
  }
};

/**
 * Initialize contract on deployment
 * @param {Object} inputs - Deployment inputs
 * @param {string} inputs.deployer - Deployer wallet address
 * @returns {Object} Deployment result
 */
function onDeploy(inputs) {
  state.deployer = inputs.deployer;

  // Generate treasury keypair
  const treasury = blackbox.generateSolanaKeypair();
  state.treasuryPublicKey = treasury.publicKey;

  // Initialize default coinpacks (prices in USD, converted to SOL at runtime)
  state.coinpacks = {
    bronze: {
      name: "Bronze Pack",
      coins: 500,
      priceUSD: 0.99,
      bonusCoins: 0,
      isActive: true
    },
    silver: {
      name: "Silver Pack",
      coins: 1250,
      priceUSD: 1.99,
      bonusCoins: 0,
      isActive: true
    },
    gold: {
      name: "Gold Pack",
      coins: 5000,
      priceUSD: 7.99,
      bonusCoins: 0,
      isActive: true
    }
  };

  // Initialize coinpack stats
  for (const packId of Object.keys(state.coinpacks)) {
    state.analytics.coinpackStats[packId] = {
      timesPurchased: 0,
      totalRevenueSOL: 0,
      totalCoinsGiven: 0
    };
  }

  return {
    success: true,
    message: "GorecatPSG1 contract deployed",
    treasuryWallet: state.treasuryPublicKey
  };
}

// ============================================
// PROFILE MANAGEMENT
// ============================================

/**
 * Register a new player with a 5-digit display name
 * @param {Object} inputs - Registration inputs (from is auto-injected)
 * @param {string} inputs.displayName - 5-character alphanumeric name
 * @returns {Object} Registration result
 */
function registerPlayer(inputs) {
  const { displayName } = inputs;
  const wallet = inputs.from;

  // Validate display name (5 chars, alphanumeric)
  if (!displayName || typeof displayName !== 'string') {
    throw new Error("Display name is required");
  }

  const cleanName = displayName.toUpperCase().trim();
  if (!/^[A-Z0-9]{5}$/.test(cleanName)) {
    throw new Error("Display name must be exactly 5 alphanumeric characters");
  }

  // Check if player already registered
  if (state.players[wallet]) {
    throw new Error("Wallet already registered. Use updateDisplayName to change your name.");
  }

  // Check name uniqueness
  if (state.displayNames[cleanName]) {
    throw new Error(`Display name '${cleanName}' is already taken`);
  }

  // Register player
  state.players[wallet] = {
    displayName: cleanName,
    cash: 0,
    gunsUnlocked: [],
    coinpacksPurchased: [],
    registeredAt: Date.now(),
    lastActive: Date.now(),
    totalSpent: 0,
    gamesPlayed: 0,
    highScore: 0,
    lastHighScoreAt: null,
    kills: 0,
    wave: 0,
    platform: null, // Will be set on first saveProgress
    tournamentScores: {}, // tournamentId -> { highScore, achievedAt } frozen scores
    battlepass: null,
    rerollCount: 0,
    lastRerollRarity: null,
    freeRollUsed: false,
    playsoltourn: {
      highScore: 0,
      kills: 0,
      wave: 0,
      gamesPlayed: 0,
      gunsUnlocked: [],
      rerolls: 0,
      lastUpdatedAt: null
    }
  };

  // Reserve display name
  state.displayNames[cleanName] = wallet;

  return {
    success: true,
    message: `Welcome to Gorecat,${cleanName}!`,
    profile: {
      displayName: cleanName,
      cash: 0,
      wallet: util.shortenAddress(wallet, 4, 4)
    }
  };
}

/**
 * Get player profile by wallet
 * @param {Object} inputs - Query inputs (from is auto-injected)
 * @param {string} [inputs.targetWallet] - Optional: look up another player
 * @returns {Object} Player profile
 */
function getProfile(inputs) {
  const wallet = inputs.targetWallet || inputs.from;
  const player = state.players[wallet];

  if (!player) {
    return {
      success: false,
      error: "Player not found",
      registered: false
    };
  }

  ensurePlayerNewFields(player);
  const now = Date.now();
  const bpActive = !!(player.battlepass && player.battlepass.expiresAt > now);

  return {
    success: true,
    registered: true,
    profile: {
      displayName: player.displayName,
      cash: player.cash,
      gunsUnlocked: player.gunsUnlocked,
      coinpacksPurchased: player.coinpacksPurchased.length,
      totalSpent: player.totalSpent,
      gamesPlayed: player.gamesPlayed,
      highScore: player.highScore,
      kills: player.kills || 0,
      wave: player.wave || 0,
      memberSince: player.registeredAt,
      platform: player.platform || null,
      rerollCount: player.rerollCount,
      lastRerollRarity: player.lastRerollRarity,
      battlepass: {
        active: bpActive,
        ...(player.battlepass || {})
      },
      playsoltourn: player.playsoltourn
    }
  };
}

/**
 * Look up a player profile by display name
 * @param {Object} inputs - Query inputs
 * @param {string} inputs.displayName - 5-character display name to look up
 * @returns {Object} Player profile
 */
function getProfileByName(inputs) {
  const { displayName } = inputs;

  if (!displayName || typeof displayName !== 'string') {
    throw new Error("displayName is required");
  }

  const cleanName = displayName.toUpperCase().trim();
  const wallet = state.displayNames[cleanName];

  if (!wallet) {
    return { success: false, error: "Player not found" };
  }

  const player = state.players[wallet];
  if (!player) {
    return { success: false, error: "Player not found" };
  }

  ensurePlayerNewFields(player);

  // Calculate ranks
  const allPlayers = Object.values(state.players);
  const cashRank = allPlayers.filter(p => p.cash > player.cash).length + 1;
  const scoreRank = allPlayers.filter(p => p.highScore > player.highScore).length + 1;
  const killsRank = allPlayers.filter(p => (p.kills || 0) > (player.kills || 0)).length + 1;
  const waveRank = allPlayers.filter(p => (p.wave || 0) > (player.wave || 0)).length + 1;

  return {
    success: true,
    registered: true,
    profile: {
      displayName: player.displayName,
      cash: player.cash,
      gunsUnlocked: player.gunsUnlocked,
      coinpacksPurchased: player.coinpacksPurchased.length,
      totalSpent: player.totalSpent,
      gamesPlayed: player.gamesPlayed,
      highScore: player.highScore,
      kills: player.kills || 0,
      wave: player.wave || 0,
      memberSince: player.registeredAt,
      platform: player.platform || null
    },
    ranks: {
      cash: cashRank,
      highScore: scoreRank,
      kills: killsRank,
      wave: waveRank
    },
    totalPlayers: allPlayers.length
  };
}

/**
 * Update player's display name
 * @param {Object} inputs - Update inputs (from is auto-injected)
 * @param {string} inputs.newDisplayName - New 5-character name
 * @param {string} inputs.message - Signed message for verification
 * @param {string} inputs.signature - Wallet signature
 * @returns {Object} Update result
 */
function updateDisplayName(inputs) {
  const { newDisplayName, message, signature } = inputs;
  const wallet = inputs.from;

  const player = state.players[wallet];
  if (!player) {
    throw new Error("Player not registered");
  }

  // Require signature for name change
  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `updateDisplayName:${wallet}:${timestamp}`,
      expiresIn: "5 minutes"
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, wallet, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  // Validate new name
  const cleanName = newDisplayName.toUpperCase().trim();
  if (!/^[A-Z0-9]{5}$/.test(cleanName)) {
    throw new Error("Display name must be exactly 5 alphanumeric characters");
  }

  if (state.displayNames[cleanName] && state.displayNames[cleanName] !== wallet) {
    throw new Error(`Display name '${cleanName}' is already taken`);
  }

  // Release old name, reserve new
  delete state.displayNames[player.displayName];
  state.displayNames[cleanName] = wallet;
  player.displayName = cleanName;

  return {
    success: true,
    message: `Display name updated to ${cleanName}`
  };
}

/**
 * Save game progress (cash collected, guns unlocked, kills)
 * Called by the game client to persist progress
 * @param {Object} inputs - Progress data (from is auto-injected)
 * @param {number} inputs.cashCollected - Cash value (saves if higher than current)
 * @param {string[]} [inputs.gunsUnlocked] - Array of gun IDs unlocked
 * @param {number} [inputs.score] - Score achieved this session
 * @param {number} [inputs.kills] - Kill count (saves if higher than current)
 * @param {number} [inputs.wave] - Highest wave reached this session
 * @param {string} [inputs.platform] - Platform the user is playing from (e.g., 'web', 'ios', 'android', 'desktop')
 * @returns {Object} Save result
 */
function saveProgress(inputs) {
  const { cashCollected, gunsUnlocked, score, kills, wave, platform } = inputs;
  const wallet = inputs.from;

  const player = state.players[wallet];
  if (!player) {
    throw new Error("Player not registered");
  }

  // Lazy-migrate new fields for accounts created before this contract version
  ensurePlayerNewFields(player);

  // Determine if battlepass is active (mirrors stats into playsoltourn scope)
  const bpActive = !!(player.battlepass && player.battlepass.expiresAt > Date.now());

  // Update cash (highest value only)
  if (typeof cashCollected === 'number' && cashCollected > player.cash) {
    player.cash = Math.floor(cashCollected);
  }

  // Update guns unlocked
  if (Array.isArray(gunsUnlocked)) {
    for (const gunId of gunsUnlocked) {
      if (!player.gunsUnlocked.includes(gunId)) {
        player.gunsUnlocked.push(gunId);

        // Track gun unlock analytics
        state.analytics.totalGunsUnlocked++;
        if (!state.analytics.gunUnlockStats[gunId]) {
          state.analytics.gunUnlockStats[gunId] = 0;
        }
        state.analytics.gunUnlockStats[gunId]++;
      }
      // Mirror into playsoltourn scope when battlepass is active
      if (bpActive && !player.playsoltourn.gunsUnlocked.includes(gunId)) {
        player.playsoltourn.gunsUnlocked.push(gunId);
      }
    }
  }

  // Lazy-add lastHighScoreAt for players registered before this field existed
  if (player.lastHighScoreAt === undefined) {
    player.lastHighScoreAt = null;
  }

  // Update high score
  if (typeof score === 'number' && score > player.highScore) {
    // Before overwriting, snapshot the old score for any tournament where it was valid
    if (!player.tournamentScores) player.tournamentScores = {};
    const oldScoreAt = player.lastHighScoreAt;
    const now = Date.now();

    for (const [tid, tournament] of Object.entries(state.tournaments)) {
      // Preserve old score if it was set during the tournament window
      const oldScoreValid = oldScoreAt === null || oldScoreAt <= tournament.endsAt;
      if (oldScoreValid && player.highScore > 0) {
        if (!player.tournamentScores[tid] || player.highScore > player.tournamentScores[tid].highScore) {
          player.tournamentScores[tid] = { highScore: player.highScore, achievedAt: oldScoreAt };
        }
      }
      // If still within tournament window, record the new score too
      if (now <= tournament.endsAt) {
        if (!player.tournamentScores[tid] || score > player.tournamentScores[tid].highScore) {
          player.tournamentScores[tid] = { highScore: score, achievedAt: now };
        }
      }
    }

    player.highScore = score;
    player.lastHighScoreAt = now;
  }

  // Update kills (highest value only)
  if (typeof kills === 'number' && kills > (player.kills || 0)) {
    player.kills = kills;
  }

  // Update highest wave reached
  if (typeof wave === 'number' && wave > (player.wave || 0)) {
    player.wave = wave;
  }

  // Update platform (tracks most recent platform used)
  if (platform && typeof platform === 'string') {
    player.platform = platform.toLowerCase().trim();
  }

  player.gamesPlayed++;
  player.lastActive = Date.now();

  // Mirror score/kills/wave/gamesPlayed into playsoltourn while battlepass is active
  if (bpActive) {
    const t = player.playsoltourn;
    if (typeof score === 'number' && score > t.highScore) t.highScore = score;
    if (typeof kills === 'number' && kills > t.kills) t.kills = kills;
    if (typeof wave === 'number' && wave > t.wave) t.wave = wave;
    t.gamesPlayed++;
    t.lastUpdatedAt = Date.now();
  }

  // Invalidate leaderboard cache
  state.leaderboardLastUpdated = 0;

  return {
    success: true,
    profile: {
      cash: player.cash,
      gunsCount: player.gunsUnlocked.length,
      highScore: player.highScore,
      kills: player.kills || 0,
      wave: player.wave || 0,
      platform: player.platform
    }
  };
}

// ============================================
// COINPACK PURCHASES
// ============================================

/**
 * Get available coinpacks (prices anchored to USD, converted to SOL)
 * @param {Object} inputs - Query inputs
 * @returns {Object} Available coinpacks with current SOL prices
 */
function getCoinpacks(_inputs) {
  // Get current SOL price in USD
  const solPrice = okx.getSolPrice();

  // Check if discount is active
  const discountActive = state.discountActive === true;
  const discountPercent = state.discountPercent || 50;
  const discountMultiplier = discountActive ? (100 - discountPercent) / 100 : 1;

  // Pack definitions (source of truth - handles legacy state migration)
  const packDefs = {
    bronze: { coins: 500, bonus: 0, priceUSD: 0.99 },
    silver: { coins: 1250, bonus: 0, priceUSD: 1.99 },
    gold: { coins: 5000, bonus: 0, priceUSD: 7.99 }
  };

  const allowedPacks = ['bronze', 'silver', 'gold'];
  const packs = allowedPacks
    .filter(id => state.coinpacks[id]?.isActive !== false)
    .map(id => {
      const def = packDefs[id];
      const originalPriceUSD = def.priceUSD;
      const effectivePriceUSD = Math.round(originalPriceUSD * discountMultiplier * 100) / 100;
      const priceSOL = Math.round((effectivePriceUSD / solPrice) * 10000) / 10000;
      const originalPriceSOL = Math.round((originalPriceUSD / solPrice) * 10000) / 10000;

      return {
        id,
        name: state.coinpacks[id]?.name || `${id.charAt(0).toUpperCase() + id.slice(1)} Pack`,
        coins: def.coins,
        bonus: def.bonus,
        totalCoins: def.coins + def.bonus,
        priceUSD: effectivePriceUSD,
        priceSOL,
        // Include original prices when discount is active
        ...(discountActive && {
          originalPriceUSD,
          originalPriceSOL,
          discountPercent
        })
      };
    });

  return {
    success: true,
    coinpacks: packs,
    solPriceUSD: solPrice,
    treasuryWallet: state.treasuryPublicKey,
    discountActive,
    ...(discountActive && { discountPercent })
  };
}

/**
 * Buy a coinpack (REAL PURCHASE - TRACKS ANALYTICS)
 * Step 1: Call without txSignature to get unsigned transaction
 * Step 2: Frontend signs and sends, then calls again with txSignature
 * @param {Object} inputs - Purchase inputs (from is auto-injected)
 * @param {string} inputs.packId - Coinpack ID to purchase
 * @param {string} [inputs.txSignature] - Payment transaction signature (omit for unsigned tx)
 * @returns {Object} Unsigned transaction OR purchase confirmation
 */
async function buyPack(inputs) {
  const { packId, txSignature } = inputs;
  const wallet = inputs.from;

  const player = state.players[wallet];
  if (!player) {
    throw new Error("Player not registered");
  }

  // Pack definitions (source of truth - handles legacy state migration)
  const packDefs = {
    bronze: { coins: 500, bonus: 0, priceUSD: 0.99 },
    silver: { coins: 1250, bonus: 0, priceUSD: 1.99 },
    gold: { coins: 5000, bonus: 0, priceUSD: 7.99 }
  };

  const packDef = packDefs[packId];
  if (!packDef) {
    throw new Error("Invalid coinpack");
  }

  const pack = state.coinpacks[packId];
  if (pack?.isActive === false) {
    throw new Error("Coinpack is inactive");
  }

  // Calculate SOL price from USD (apply discount if active)
  const solPrice = okx.getSolPrice();
  const discountActive = state.discountActive === true;
  const discountPercent = state.discountPercent || 50;
  const discountMultiplier = discountActive ? (100 - discountPercent) / 100 : 1;
  const effectivePriceUSD = Math.round(packDef.priceUSD * discountMultiplier * 100) / 100;
  const priceSOL = Math.round((effectivePriceUSD / solPrice) * 10000) / 10000;

  // STEP 1: No signature - generate unsigned transaction
  if (!txSignature) {
    const umiInstance = umi.createUmi();
    const userSigner = umi.createNoopSigner(wallet);

    // Build SOL transfer with memo for identification
    const memoText = `gorecatpsg1:buyPack:${packId}:${wallet.slice(0, 8)}`;
    const builder = umi.transactionBuilder()
      .setFeePayer(userSigner)
      .add(umi.transferSol(umiInstance, {
        source: userSigner,
        destination: umi.publicKey(state.treasuryPublicKey),
        amount: umi.sol(priceSOL)
      }))
      .add(umi.addMemo(umiInstance, { memo: memoText }));

    const unsignedTx = await umi.buildPartialTransaction(umiInstance, builder);

    return {
      success: true,
      requiresPayment: true,
      transaction: unsignedTx,
      packId,
      packName: pack?.name || `${packId.charAt(0).toUpperCase() + packId.slice(1)} Pack`,
      priceSOL: priceSOL,
      coinsToReceive: packDef.coins + packDef.bonus,
      treasuryWallet: state.treasuryPublicKey,
      discountApplied: discountActive,
      ...(discountActive && { discountPercent })
    };
  }

  // STEP 2: Signature provided - verify payment and credit purchase
  const parsed = await umi.parseTransaction(txSignature, {
    extractTransfers: true,
    includeTokenBalances: false
  });

  if (!parsed.success) {
    throw new Error(`Failed to parse transaction: ${parsed.error || 'Unknown error'}`);
  }

  // Find SOL transfer to treasury
  const validTransfer = parsed.transfers?.find(t =>
    t.to === state.treasuryPublicKey &&
    t.from === wallet &&
    t.amount >= priceSOL * 0.99 // Allow 1% slippage
  );

  if (!validTransfer) {
    throw new Error(`Payment not found. Expected ${priceSOL} SOL to treasury.`);
  }

  // Credit coins to player
  const totalCoins = packDef.coins + packDef.bonus;
  player.cash += totalCoins;
  player.totalSpent += priceSOL;
  player.coinpacksPurchased.push({
    packId,
    timestamp: Date.now(),
    txSignature
  });
  player.lastActive = Date.now();

  // ============================================
  // ANALYTICS TRACKING (Real purchases only)
  // ============================================
  const now = Date.now();
  const dateKey = new Date(now).toISOString().split('T')[0]; // YYYY-MM-DD

  // Global stats
  state.analytics.totalPurchases++;
  state.analytics.totalRevenueSOL += priceSOL;
  state.analytics.totalCoinsDistributed += totalCoins;

  // Track unique vs returning buyers
  const isFirstPurchase = !state.analytics.uniqueBuyers[wallet];
  if (isFirstPurchase) {
    state.analytics.uniqueBuyersCount++;
    state.analytics.uniqueBuyers[wallet] = dateKey;
  } else {
    // Returning buyer
    state.analytics.returningBuyersCount++;
  }

  // Daily stats
  if (!state.analytics.dailyStats[dateKey]) {
    state.analytics.dailyStats[dateKey] = {
      purchases: 0,
      revenueSOL: 0,
      coinsDistributed: 0,
      uniqueBuyers: 0,
      newBuyers: 0,
      returningBuyers: 0
    };
  }
  const daily = state.analytics.dailyStats[dateKey];
  daily.purchases++;
  daily.revenueSOL += priceSOL;
  daily.coinsDistributed += totalCoins;
  if (isFirstPurchase) {
    daily.newBuyers++;
  } else {
    daily.returningBuyers++;
  }

  // Per-pack stats
  state.analytics.coinpackStats[packId].timesPurchased++;
  state.analytics.coinpackStats[packId].totalRevenueSOL += priceSOL;
  state.analytics.coinpackStats[packId].totalCoinsGiven += totalCoins;

  // Purchase history (keep last N)
  state.analytics.purchaseHistory.push({
    wallet: util.shortenAddress(wallet, 4, 4),
    packId,
    priceSOL: priceSOL,
    coins: totalCoins,
    timestamp: now,
    isFirstPurchase
  });

  // Note: Archiving is handled by archiveOldData() function
  // which can be called manually or via timer to move old data to R2

  return {
    success: true,
    message: `Purchased ${pack.name}!`,
    coinsAdded: totalCoins,
    newBalance: player.cash,
    isFirstPurchase
  };
}

/**
 * Debug buy pack (FOR TESTING - NO ANALYTICS TRACKING)
 * Credits coins without payment verification
 * @param {Object} inputs - Debug inputs (from is auto-injected)
 * @param {string} inputs.packId - Coinpack ID to credit
 * @returns {Object} Debug result
 */
function debugBuyPack(inputs) {
  const { packId } = inputs;
  const wallet = inputs.from;

  const player = state.players[wallet];
  if (!player) {
    throw new Error("Player not registered");
  }

  const pack = state.coinpacks[packId];
  if (!pack) {
    throw new Error("Invalid coinpack");
  }

  // Credit coins WITHOUT tracking analytics
  const totalCoins = pack.coins + pack.bonusCoins;
  player.cash += totalCoins;
  player.lastActive = Date.now();

  // Note: NO analytics tracking here
  // This keeps test purchases separate from real data

  return {
    success: true,
    debug: true,
    message: `[DEBUG] Credited ${totalCoins} coins`,
    coinsAdded: totalCoins,
    newBalance: player.cash,
    warning: "This is a debug purchase - not tracked in analytics"
  };
}

// ============================================
// LEADERBOARD (PUBLIC ACCESS)
// ============================================

/**
 * Get public leaderboard
 * Sorted by cash, includes 5-digit display names
 * @param {Object} inputs - Query inputs
 * @param {number} [inputs.page] - Page number (default 0)
 * @param {number} [inputs.limit] - Results per page (default 20, max 50)
 * @param {string} [inputs.sortBy] - Sort field: 'cash', 'highScore', 'gamesPlayed', 'kills', 'wave' (default 'cash')
 * @returns {Object} Leaderboard data
 */
function getLeaderboard(inputs) {
  const { page = 0, limit = 20, sortBy = 'cash' } = inputs;
  const actualLimit = Math.min(limit, 50);

  // Build leaderboard from players
  const validSortFields = ['cash', 'highScore', 'gamesPlayed', 'kills', 'wave'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'cash';

  const leaderboard = Object.entries(state.players)
    .map(([wallet, player]) => ({
      displayName: player.displayName,
      wallet: util.shortenAddress(wallet, 4, 4),
      cash: player.cash,
      highScore: player.highScore,
      gamesPlayed: player.gamesPlayed,
      kills: player.kills || 0,
      wave: player.wave || 0,
      gunsUnlocked: player.gunsUnlocked.length,
      platform: player.platform || null
    }))
    .sort((a, b) => b[sortField] - a[sortField]);

  // Paginate
  const startIndex = page * actualLimit;
  const pageData = leaderboard.slice(startIndex, startIndex + actualLimit);

  // Add rank
  const rankedData = pageData.map((entry, idx) => ({
    rank: startIndex + idx + 1,
    ...entry
  }));

  return {
    success: true,
    leaderboard: rankedData,
    page,
    pageSize: actualLimit,
    totalPlayers: leaderboard.length,
    totalPages: Math.ceil(leaderboard.length / actualLimit),
    sortBy: sortField
  };
}

/**
 * Get player's rank on leaderboard
 * @param {Object} inputs - Query inputs (from is auto-injected)
 * @param {string} [inputs.targetWallet] - Optional: check another player's rank
 * @returns {Object} Rank data
 */
function getPlayerRank(inputs) {
  const wallet = inputs.targetWallet || inputs.from;
  const player = state.players[wallet];

  if (!player) {
    return {
      success: false,
      error: "Player not found"
    };
  }

  // Calculate rank by cash, score, kills, and wave
  const allPlayers = Object.entries(state.players);
  const cashRank = allPlayers.filter(([_, p]) => p.cash > player.cash).length + 1;
  const scoreRank = allPlayers.filter(([_, p]) => p.highScore > player.highScore).length + 1;
  const killsRank = allPlayers.filter(([_, p]) => (p.kills || 0) > (player.kills || 0)).length + 1;
  const waveRank = allPlayers.filter(([_, p]) => (p.wave || 0) > (player.wave || 0)).length + 1;

  return {
    success: true,
    displayName: player.displayName,
    ranks: {
      cash: cashRank,
      highScore: scoreRank,
      kills: killsRank,
      wave: waveRank
    },
    stats: {
      cash: player.cash,
      highScore: player.highScore,
      kills: player.kills || 0,
      wave: player.wave || 0,
      gamesPlayed: player.gamesPlayed
    },
    totalPlayers: allPlayers.length
  };
}

/**
 * Battlepass-only leaderboard, scoped to playsoltourn stats
 * Only includes players with an ACTIVE battlepass.
 * @param {Object} inputs
 * @param {number} [inputs.page=0]
 * @param {number} [inputs.limit=20]
 * @param {string} [inputs.sortBy='highScore'] - 'highScore' | 'kills' | 'wave' | 'gamesPlayed'
 * @returns {Object} Leaderboard data
 */
function getBattlepassLeaderboard(inputs) {
  ensureBattlepassState();
  const { page = 0, limit = 20, sortBy = 'highScore' } = inputs;
  const actualLimit = Math.min(limit, 50);
  const validSortFields = ['highScore', 'kills', 'wave', 'gamesPlayed', 'rerolls'];
  const sortField = validSortFields.includes(sortBy) ? sortBy : 'highScore';
  const now = Date.now();

  const entries = Object.entries(state.players)
    .filter(([_, p]) => p.battlepass && p.battlepass.expiresAt > now)
    .map(([wallet, p]) => {
      ensurePlayerNewFields(p);
      const t = p.playsoltourn;
      return {
        displayName: p.displayName,
        wallet: util.shortenAddress(wallet, 4, 4),
        highScore: t.highScore,
        kills: t.kills,
        wave: t.wave,
        gamesPlayed: t.gamesPlayed,
        gunsUnlocked: t.gunsUnlocked.length,
        rerolls: t.rerolls,
        platform: p.platform || null,
        battlepassExpiresAt: p.battlepass.expiresAt
      };
    })
    .sort((a, b) => b[sortField] - a[sortField]);

  const startIndex = page * actualLimit;
  const pageData = entries
    .slice(startIndex, startIndex + actualLimit)
    .map((e, i) => ({ rank: startIndex + i + 1, ...e }));

  return {
    success: true,
    leaderboard: pageData,
    page,
    pageSize: actualLimit,
    totalParticipants: entries.length,
    totalPages: Math.ceil(entries.length / actualLimit) || 1,
    sortBy: sortField
  };
}

// ============================================
// ANALYTICS
// ============================================

/**
 * Get comprehensive analytics for monetization reporting
 * PUBLIC - No authentication required (data is aggregated, no PII)
 * @param {Object} inputs - Query inputs
 * @param {number} [inputs.daysBack] - Days of history to include (default 30)
 * @returns {Object} Analytics data
 */
function getAnalytics(inputs) {
  const { daysBack = 30 } = inputs;

  // Calculate date range
  const now = Date.now();
  const cutoffDate = new Date(now - (daysBack * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];

  // Filter daily stats to requested range
  const relevantDays = Object.entries(state.analytics.dailyStats)
    .filter(([date]) => date >= cutoffDate)
    .sort(([a], [b]) => a.localeCompare(b));

  // Calculate period totals
  const periodStats = relevantDays.reduce((acc, [_, day]) => ({
    purchases: acc.purchases + day.purchases,
    revenueSOL: acc.revenueSOL + day.revenueSOL,
    coinsDistributed: acc.coinsDistributed + day.coinsDistributed,
    newBuyers: acc.newBuyers + (day.newBuyers || 0),
    returningBuyers: acc.returningBuyers + (day.returningBuyers || 0)
  }), { purchases: 0, revenueSOL: 0, coinsDistributed: 0, newBuyers: 0, returningBuyers: 0 });

  // Average order value
  const avgOrderValue = periodStats.purchases > 0
    ? (periodStats.revenueSOL / periodStats.purchases).toFixed(4)
    : 0;

  // Daily averages
  const daysWithData = relevantDays.length || 1;

  return {
    success: true,
    period: {
      days: daysBack,
      startDate: cutoffDate,
      endDate: new Date(now).toISOString().split('T')[0]
    },

    // Lifetime totals
    lifetime: {
      totalPurchases: state.analytics.totalPurchases,
      totalRevenueSOL: Number(state.analytics.totalRevenueSOL.toFixed(4)),
      totalCoinsDistributed: state.analytics.totalCoinsDistributed,
      uniqueBuyers: state.analytics.uniqueBuyersCount,
      totalPlayers: Object.keys(state.players).length
    },

    // Period totals (last N days)
    periodTotals: {
      purchases: periodStats.purchases,
      revenueSOL: Number(periodStats.revenueSOL.toFixed(4)),
      coinsDistributed: periodStats.coinsDistributed,
      newBuyers: periodStats.newBuyers,
      returningBuyers: periodStats.returningBuyers
    },

    // Key metrics
    metrics: {
      avgOrderValueSOL: Number(avgOrderValue),
      avgDailyRevenue: Number((periodStats.revenueSOL / daysWithData).toFixed(4)),
      avgDailyPurchases: Number((periodStats.purchases / daysWithData).toFixed(2)),
      buyerRetentionRate: state.analytics.uniqueBuyersCount > 0
        ? Number((state.analytics.returningBuyersCount / state.analytics.uniqueBuyersCount * 100).toFixed(1))
        : 0,
      conversionRate: Object.keys(state.players).length > 0
        ? Number((state.analytics.uniqueBuyersCount / Object.keys(state.players).length * 100).toFixed(1))
        : 0
    },

    // Coinpack performance
    coinpackPerformance: Object.entries(state.analytics.coinpackStats).map(([packId, stats]) => ({
      packId,
      name: state.coinpacks[packId]?.name || packId,
      purchases: stats.timesPurchased,
      revenueSOL: Number(stats.totalRevenueSOL.toFixed(4)),
      revenueShare: state.analytics.totalRevenueSOL > 0
        ? Number((stats.totalRevenueSOL / state.analytics.totalRevenueSOL * 100).toFixed(1))
        : 0
    })).sort((a, b) => b.revenueSOL - a.revenueSOL)
  };
}

/**
 * Get daily trend data for charts
 * @param {Object} inputs - Query inputs
 * @param {number} [inputs.daysBack] - Days to include (default 14)
 * @returns {Object} Daily trend data
 */
function getDailyTrends(inputs) {
  const { daysBack = 14 } = inputs;

  const now = Date.now();
  const days = [];

  for (let i = daysBack - 1; i >= 0; i--) {
    const date = new Date(now - (i * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];
    const dayStats = state.analytics.dailyStats[date] || {
      purchases: 0,
      revenueSOL: 0,
      coinsDistributed: 0,
      newBuyers: 0
    };

    days.push({
      date,
      purchases: dayStats.purchases,
      revenue: Number(dayStats.revenueSOL.toFixed(4)),
      coins: dayStats.coinsDistributed,
      newBuyers: dayStats.newBuyers || 0
    });
  }

  return {
    success: true,
    trends: days
  };
}

/**
 * Get recent purchase activity (for live dashboard)
 * @param {Object} inputs - Query inputs
 * @param {number} [inputs.limit] - Number of recent purchases (default 10, max 50)
 * @returns {Object} Recent purchases
 */
function getRecentPurchases(inputs) {
  const { limit = 10 } = inputs;
  const actualLimit = Math.min(limit, 50);

  const recent = state.analytics.purchaseHistory
    .slice(-actualLimit)
    .reverse(); // Most recent first

  return {
    success: true,
    purchases: recent,
    totalPurchases: state.analytics.totalPurchases
  };
}

/**
 * Count registered players grouped by platform value
 * @returns {Object} { success, total, counts: { [platform]: count } }
 */
function getPlatformCounts(_inputs) {
  const counts = {};
  const spendByPlatform = {};
  let total = 0;
  let totalSpent = 0;
  for (const p of Object.values(state.players)) {
    const key = p.platform == null ? 'unknown' : String(p.platform);
    counts[key] = (counts[key] || 0) + 1;
    const spent = Number(p.totalSpent) || 0;
    spendByPlatform[key] = (spendByPlatform[key] || 0) + spent;
    total++;
    totalSpent += spent;
  }
  return { success: true, total, totalSpent, counts, spendByPlatform };
}

// ============================================
// ADMIN FUNCTIONS
// ============================================

/**
 * Check if a wallet is an admin (deployer or in admins list)
 * @param {string} wallet - Wallet address to check
 * @returns {boolean} True if admin
 */
function isAdmin(wallet) {
  return wallet === state.deployer || (state.admins && state.admins.includes(wallet));
}

/**
 * Add or remove admins (deployer only)
 * @param {Object} inputs - Admin management inputs
 * @param {string} inputs.targetWallet - Wallet to add/remove
 * @param {string} inputs.action - 'add' or 'remove'
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Result
 */
function adminManageAdmins(inputs) {
  const { targetWallet, action, message, signature } = inputs;
  const caller = inputs.from;

  // Only deployer can manage admins
  if (caller !== state.deployer) {
    throw new Error("Only deployer can manage admins");
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminManageAdmins:${caller}:${action}:${targetWallet}:${timestamp}`,
      expiresIn: "5 minutes",
      currentAdmins: state.admins || []
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  if (!targetWallet || !action) {
    throw new Error("targetWallet and action are required");
  }

  if (!state.admins) {
    state.admins = [];
  }

  if (action === 'add') {
    if (targetWallet === state.deployer) {
      throw new Error("Deployer is already an admin by default");
    }
    if (!state.admins.includes(targetWallet)) {
      state.admins.push(targetWallet);
    }
    return {
      success: true,
      message: `Added ${util.shortenAddress(targetWallet, 4, 4)} as admin`,
      admins: state.admins
    };
  } else if (action === 'remove') {
    const index = state.admins.indexOf(targetWallet);
    if (index > -1) {
      state.admins.splice(index, 1);
    }
    return {
      success: true,
      message: `Removed ${util.shortenAddress(targetWallet, 4, 4)} from admins`,
      admins: state.admins
    };
  } else {
    throw new Error("Invalid action. Use 'add' or 'remove'");
  }
}

/**
 * Get list of current admins
 * @param {Object} inputs - Query inputs
 * @returns {Object} Admin list
 */
function getAdmins(inputs) {
  return {
    success: true,
    deployer: state.deployer,
    admins: state.admins || [],
    isCallerAdmin: isAdmin(inputs.from)
  };
}

/**
 * Toggle 50% discount mode on/off (admin only)
 * @param {Object} inputs - Toggle inputs
 * @param {boolean} [inputs.active] - Set discount active state (toggles if omitted)
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Result with new discount state
 */
function adminToggleDiscount(inputs) {
  const { active, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can toggle discount mode");
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminToggleDiscount:${caller}:${timestamp}`,
      expiresIn: "5 minutes",
      currentState: {
        discountActive: state.discountActive,
        discountPercent: state.discountPercent || 50
      }
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  // Toggle or set explicitly
  if (typeof active === 'boolean') {
    state.discountActive = active;
  } else {
    state.discountActive = !state.discountActive;
  }

  return {
    success: true,
    discountActive: state.discountActive,
    discountPercent: state.discountPercent || 50,
    message: state.discountActive
      ? `Discount mode ENABLED (${state.discountPercent || 50}% off all packs)`
      : "Discount mode DISABLED (full prices restored)"
  };
}

/**
 * Add or update a coinpack (admin only)
 * @param {Object} inputs - Pack data
 * @param {string} inputs.packId - Pack identifier
 * @param {string} inputs.name - Display name
 * @param {number} inputs.coins - Base coins
 * @param {number} inputs.priceSOL - Price in SOL
 * @param {number} [inputs.bonusCoins] - Bonus coins
 * @param {boolean} [inputs.isActive] - Whether pack is purchasable
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Result
 */
function adminSetCoinpack(inputs) {
  const { packId, name, coins, priceSOL, bonusCoins = 0, isActive = true, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can manage coinpacks");
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminSetCoinpack:${caller}:${timestamp}`,
      expiresIn: "5 minutes"
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  // Validate inputs
  if (!packId || !name || typeof coins !== 'number' || typeof priceSOL !== 'number') {
    throw new Error("Invalid coinpack data");
  }

  // Initialize stats if new pack
  if (!state.analytics.coinpackStats[packId]) {
    state.analytics.coinpackStats[packId] = {
      timesPurchased: 0,
      totalRevenueSOL: 0,
      totalCoinsGiven: 0
    };
  }

  state.coinpacks[packId] = {
    name,
    coins,
    priceSOL,
    bonusCoins,
    isActive
  };

  return {
    success: true,
    message: `Coinpack '${packId}' updated`,
    pack: state.coinpacks[packId]
  };
}

/**
 * Withdraw treasury funds (admin only)
 * @param {Object} inputs - Withdrawal inputs
 * @param {number} inputs.amountSOL - Amount to withdraw
 * @param {string} inputs.destination - Destination wallet
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Result
 */
async function adminWithdraw(inputs) {
  const { amountSOL, destination, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can withdraw");
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminWithdraw:${caller}:${amountSOL}:${timestamp}`,
      expiresIn: "5 minutes"
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  // Get treasury keypair
  const treasury = blackbox.getKey(0);
  const privateKey = treasury.secretKey || treasury.privateKey;

  // Create transfer
  const umiInstance = umi.createUmi();
  const umiWithTreasury = umi.setKeypairIdentity(umiInstance, privateKey);

  const builder = umi.transactionBuilder()
    .add(umi.transferSol(umiWithTreasury, {
      source: umiWithTreasury.identity,
      destination: umi.publicKey(destination),
      amount: umi.sol(amountSOL)
    }));

  const result = await umi.buildSignAndSerializeAndSend(
    umiWithTreasury,
    builder,
    umiWithTreasury.identity,
    { commitment: 'processed', skipPreflight: true, maxRetries: 0 }
  );

  return {
    success: true,
    txSignature: result.signature,
    amountSOL,
    destination: util.shortenAddress(destination, 4, 4)
  };
}

/**
 * Get treasury balance (admin only)
 * @param {Object} inputs - Query inputs (from is auto-injected)
 * @returns {Object} Balance info
 */
async function getTreasuryBalance(inputs) {
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can view treasury balance");
  }

  const balance = await umi.getBalance(state.treasuryPublicKey);

  return {
    success: true,
    treasuryWallet: state.treasuryPublicKey,
    balanceSOL: balance,
    totalLifetimeRevenue: state.analytics.totalRevenueSOL
  };
}

/**
 * Credit coins to a player (admin only, for support/promotions)
 * NOTE: This does NOT track in analytics (like debugBuyPack)
 * @param {Object} inputs - Credit inputs
 * @param {string} inputs.targetWallet - Player to credit
 * @param {number} inputs.coins - Coins to add
 * @param {string} inputs.reason - Reason for credit
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Result
 */
function adminCreditCoins(inputs) {
  const { targetWallet, coins, reason, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can credit coins");
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminCreditCoins:${caller}:${targetWallet}:${coins}:${timestamp}`,
      expiresIn: "5 minutes"
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  const player = state.players[targetWallet];
  if (!player) {
    throw new Error("Target player not found");
  }

  player.cash += coins;

  return {
    success: true,
    message: `Credited ${coins} coins to ${player.displayName}`,
    reason,
    newBalance: player.cash,
    analyticsTracked: false
  };
}

/**
 * Delete a user by their display name (admin only)
 * Removes player profile, display name reservation, leaderboard entries, and related tracking data
 * @param {Object} inputs - Delete inputs (from is auto-injected)
 * @param {string} inputs.username - Display name of the player to delete
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Result
 */
function adminDeleteUser(inputs) {
  const { username, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can delete users");
  }

  if (!username || typeof username !== 'string') {
    throw new Error("username is required");
  }

  const cleanName = username.toUpperCase().trim();
  const wallet = state.displayNames[cleanName];

  if (!wallet) {
    throw new Error(`No user found with display name '${cleanName}'`);
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminDeleteUser:${caller}:${cleanName}:${wallet}:${timestamp}`,
      expiresIn: "5 minutes",
      targetWallet: wallet,
      targetDisplayName: cleanName
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  const player = state.players[wallet];
  if (!player) {
    throw new Error("Player record not found for wallet");
  }

  // Remove display name reservation
  delete state.displayNames[cleanName];

  // Remove player profile
  delete state.players[wallet];

  // Remove from rate limiting
  delete state.lastActionTime[wallet];

  // Remove from analytics unique buyers
  if (state.analytics.uniqueBuyers[wallet]) {
    delete state.analytics.uniqueBuyers[wallet];
    state.analytics.uniqueBuyersCount = Object.keys(state.analytics.uniqueBuyers).length;
  }

  // Remove from leaderboard cache
  state.leaderboardCache = state.leaderboardCache.filter(entry => entry.wallet !== wallet);

  return {
    success: true,
    message: `Deleted user '${cleanName}' (wallet: ${util.shortenAddress(wallet, 4, 4)})`,
    deletedDisplayName: cleanName,
    deletedWallet: util.shortenAddress(wallet, 4, 4)
  };
}

// ============================================
// DATA ARCHIVING (State Management)
// ============================================

/**
 * Archive old purchase history to R2
 * Moves purchase history entries to cold storage, keeping state lean
 * @param {Object} inputs - Archive inputs (from is auto-injected)
 * @param {number} [inputs.keepRecent] - Number of recent entries to keep (default: 200)
 * @returns {Object} Archive result
 */
async function archivePurchaseHistory(inputs) {
  const { keepRecent = 200 } = inputs;
  const caller = inputs.from;

  // Only admins can archive
  if (!isAdmin(caller)) {
    throw new Error("Only admins can archive data");
  }

  const history = state.analytics.purchaseHistory;

  // Check if archiving is needed
  if (history.length <= keepRecent) {
    return {
      success: true,
      message: "No archiving needed",
      currentCount: history.length,
      threshold: keepRecent
    };
  }

  // Split into archive and keep portions
  const toArchive = history.slice(0, history.length - keepRecent);
  const toKeep = history.slice(-keepRecent);

  // Archive to R2
  const result = await r2.archive.storeArray(toArchive, {
    folder: 'gorecatpsg1/archives',
    prefix: 'purchase-history'
  });

  if (!result.success) {
    throw new Error(`Archive failed: ${result.error}`);
  }

  // Update state: store reference, keep recent data
  state.analytics.purchaseHistoryArchives.push(result.reference);
  state.analytics.purchaseHistory = toKeep;

  return {
    success: true,
    archived: {
      count: toArchive.length,
      url: result.url,
      dateRange: result.dateRange
    },
    remaining: toKeep.length,
    totalArchives: state.analytics.purchaseHistoryArchives.length
  };
}

/**
 * Archive old daily stats to R2
 * Keeps recent days in state, archives older data
 * @param {Object} inputs - Archive inputs (from is auto-injected)
 * @param {number} [inputs.keepDays] - Number of recent days to keep (default: 90)
 * @returns {Object} Archive result
 */
async function archiveDailyStats(inputs) {
  const { keepDays = 90 } = inputs;
  const caller = inputs.from;

  // Only admins can archive
  if (!isAdmin(caller)) {
    throw new Error("Only admins can archive data");
  }

  const now = Date.now();
  const cutoffDate = new Date(now - (keepDays * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];

  // Separate old and recent stats
  const oldStats = {};
  const recentStats = {};
  let oldCount = 0;

  for (const [date, stats] of Object.entries(state.analytics.dailyStats)) {
    if (date < cutoffDate) {
      oldStats[date] = stats;
      oldCount++;
    } else {
      recentStats[date] = stats;
    }
  }

  // Check if archiving is needed
  if (oldCount === 0) {
    return {
      success: true,
      message: "No old stats to archive",
      currentDays: Object.keys(recentStats).length,
      cutoffDate
    };
  }

  // Archive to R2
  const result = await r2.archive.storeObject(oldStats, {
    folder: 'gorecatpsg1/archives',
    prefix: 'daily-stats'
  });

  if (!result.success) {
    throw new Error(`Archive failed: ${result.error}`);
  }

  // Update state
  state.analytics.dailyStatsArchives.push({
    ...result.reference,
    dateRange: {
      earliest: Object.keys(oldStats).sort()[0],
      latest: Object.keys(oldStats).sort().pop()
    }
  });
  state.analytics.dailyStats = recentStats;

  return {
    success: true,
    archived: {
      days: oldCount,
      url: result.url,
      dateRange: {
        from: Object.keys(oldStats).sort()[0],
        to: Object.keys(oldStats).sort().pop()
      }
    },
    remainingDays: Object.keys(recentStats).length,
    totalArchives: state.analytics.dailyStatsArchives.length
  };
}

/**
 * Archive all old data in one call
 * Convenience function to archive both purchase history and daily stats
 * @param {Object} inputs - Archive inputs (from is auto-injected)
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Archive results
 */
async function archiveOldData(inputs) {
  const { message, signature } = inputs;
  const caller = inputs.from;

  // Only admins can archive
  if (!isAdmin(caller)) {
    throw new Error("Only admins can archive data");
  }

  // Require signature for data modification
  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `archiveOldData:${caller}:${timestamp}`,
      expiresIn: "5 minutes",
      preview: {
        purchaseHistoryCount: state.analytics.purchaseHistory.length,
        dailyStatsCount: Object.keys(state.analytics.dailyStats).length
      }
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  const results = {
    purchaseHistory: null,
    dailyStats: null
  };

  // Archive purchase history if needed
  if (state.analytics.purchaseHistory.length > 200) {
    try {
      results.purchaseHistory = await archivePurchaseHistory({ from: caller, keepRecent: 200 });
    } catch (err) {
      results.purchaseHistory = { success: false, error: err.message };
    }
  } else {
    results.purchaseHistory = { skipped: true, reason: "Below threshold" };
  }

  // Archive daily stats if needed (keep 90 days)
  if (Object.keys(state.analytics.dailyStats).length > 90) {
    try {
      results.dailyStats = await archiveDailyStats({ from: caller, keepDays: 90 });
    } catch (err) {
      results.dailyStats = { success: false, error: err.message };
    }
  } else {
    results.dailyStats = { skipped: true, reason: "Below threshold" };
  }

  return {
    success: true,
    results
  };
}

/**
 * Get archive status and list of all archived data
 * @param {Object} inputs - Query inputs
 * @returns {Object} Archive information
 */
function getArchiveStatus(_inputs) {
  const purchaseArchives = state.analytics.purchaseHistoryArchives || [];
  const dailyArchives = state.analytics.dailyStatsArchives || [];

  // Calculate totals
  const totalPurchasesArchived = purchaseArchives.reduce((sum, a) => sum + (a.count || 0), 0);
  const totalDaysArchived = dailyArchives.reduce((sum, a) => sum + (a.count || 0), 0);

  return {
    success: true,
    status: {
      purchaseHistory: {
        inState: state.analytics.purchaseHistory.length,
        archived: totalPurchasesArchived,
        archiveCount: purchaseArchives.length,
        shouldArchive: state.analytics.purchaseHistory.length > state.analytics.purchaseHistoryMaxSize
      },
      dailyStats: {
        inState: Object.keys(state.analytics.dailyStats).length,
        archived: totalDaysArchived,
        archiveCount: dailyArchives.length,
        shouldArchive: Object.keys(state.analytics.dailyStats).length > 90
      }
    },
    archives: {
      purchaseHistory: purchaseArchives.map(a => ({
        url: a.url,
        count: a.count,
        archivedAt: a.archivedAt,
        dateRange: a.dateRange
      })),
      dailyStats: dailyArchives.map(a => ({
        url: a.url,
        count: a.count,
        archivedAt: a.archivedAt,
        dateRange: a.dateRange
      }))
    }
  };
}

// ============================================
// TOURNAMENTS
// ============================================

const DEFAULT_TOURNAMENTS = {
  marchmayhem: {
    name: "March Mayhem",
    endsAt: 1773604800000,   // March 15, 2026 12:00 PM PST (20:00 UTC)
    platform: "psg1",
    minGamesPlayed: 1,
    status: "active",
    finalizedAt: null,
    snapshot: null
  }
};

/**
 * Ensure state.tournaments exists (lazy migration for already-deployed contracts)
 */
function ensureTournaments() {
  if (!state.tournaments) {
    state.tournaments = JSON.parse(JSON.stringify(DEFAULT_TOURNAMENTS));
  }
  // Fix: original deploy used 2025 timestamp by mistake
  if (state.tournaments.marchmayhem && state.tournaments.marchmayhem.endsAt < 1770000000000) {
    state.tournaments.marchmayhem.endsAt = 1773604800000;
  }
}

/**
 * Get tournament info and participant count
 * @param {Object} inputs - Query inputs
 * @param {string} inputs.tournamentId - Tournament identifier
 * @returns {Object} Tournament info
 */
function getTournamentInfo(inputs) {
  ensureTournaments();
  const { tournamentId } = inputs;

  if (!tournamentId || typeof tournamentId !== 'string') {
    throw new Error("tournamentId is required");
  }

  const tournament = state.tournaments[tournamentId];
  if (!tournament) {
    throw new Error(`Tournament '${tournamentId}' not found`);
  }

  // Count eligible participants
  let participantCount = 0;
  for (const player of Object.values(state.players)) {
    if (player.gamesPlayed >= tournament.minGamesPlayed) {
      participantCount++;
    }
  }

  return {
    success: true,
    tournament: {
      id: tournamentId,
      name: tournament.name,
      endsAt: tournament.endsAt,
      platform: tournament.platform,
      minGamesPlayed: tournament.minGamesPlayed,
      status: tournament.status,
      finalizedAt: tournament.finalizedAt,
      snapshot: tournament.snapshot
    },
    participantCount,
    totalPlayers: Object.keys(state.players).length
  };
}

/**
 * Batch-verify wallets against tournament criteria.
 * Checks each wallet for: registration, minimum games played, and registration before tournament deadline.
 * Max 100 wallets per call.
 *
 * @param {Object} inputs - Verification inputs
 * @param {string} inputs.tournamentId - Tournament identifier (e.g. "marchmayhem")
 * @param {string[]} inputs.wallets - Array of full wallet addresses to verify (max 100)
 * @returns {Object} results - Keyed by wallet address
 * @returns {boolean} results[wallet].eligible - Whether the wallet qualifies
 * @returns {string} [results[wallet].reason] - Rejection reason if ineligible: "not_registered" | "insufficient_games" | "registered_after_deadline"
 * @returns {string} [results[wallet].displayName] - Player name (if eligible)
 * @returns {number} [results[wallet].highScore] - High score (if eligible)
 * @returns {number} [results[wallet].lastHighScoreAt] - Timestamp of last high score (if eligible)
 * @returns {number} [results[wallet].gamesPlayed] - Games played (if eligible, or if insufficient_games)
 *
 * @example
 * // Call:
 * verifyTournamentParticipants({ tournamentId: "marchmayhem", wallets: ["ABC...", "DEF..."] })
 * // Returns:
 * // { success: true, tournamentId: "marchmayhem", status: "active", results: {
 * //   "ABC...": { eligible: true, displayName: "TIGER", highScore: 5200, ... },
 * //   "DEF...": { eligible: false, reason: "insufficient_games", gamesPlayed: 0, required: 1 }
 * // }}
 */
function verifyTournamentParticipants(inputs) {
  ensureTournaments();
  ensureBattlepassState();
  const { tournamentId, wallets, scope = 'global' } = inputs;
  const useTournScope = scope === 'playsoltourn';

  if (!tournamentId || typeof tournamentId !== 'string') {
    throw new Error("tournamentId is required");
  }

  const tournament = state.tournaments[tournamentId];
  if (!tournament) {
    throw new Error(`Tournament '${tournamentId}' not found`);
  }

  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("wallets must be a non-empty array");
  }

  if (wallets.length > 100) {
    throw new Error("Maximum 100 wallets per batch");
  }

  const results = {};

  for (const wallet of wallets) {
    const player = state.players[wallet];

    if (!player) {
      results[wallet] = { eligible: false, reason: "not_registered" };
      continue;
    }

    ensurePlayerNewFields(player);

    // playsoltourn scope: must hold an active battlepass and stats are read from playsoltourn
    if (useTournScope) {
      const bpActive = !!(player.battlepass && player.battlepass.expiresAt > Date.now());
      if (!bpActive) {
        results[wallet] = { eligible: false, reason: "no_active_battlepass" };
        continue;
      }

      const t = player.playsoltourn;
      if (t.gamesPlayed < tournament.minGamesPlayed) {
        results[wallet] = {
          eligible: false,
          reason: "insufficient_games",
          gamesPlayed: t.gamesPlayed,
          required: tournament.minGamesPlayed,
          scope: 'playsoltourn'
        };
        continue;
      }

      if (player.registeredAt > tournament.endsAt) {
        results[wallet] = { eligible: false, reason: "registered_after_deadline", scope: 'playsoltourn' };
        continue;
      }

      const lastUpdatedAt = t.lastUpdatedAt != null ? t.lastUpdatedAt : null;
      const scoreValid = lastUpdatedAt === null || lastUpdatedAt <= tournament.endsAt;

      results[wallet] = {
        eligible: true,
        scope: 'playsoltourn',
        displayName: player.displayName,
        highScore: t.highScore,
        scoreValid,
        lastHighScoreAt: lastUpdatedAt,
        gamesPlayed: t.gamesPlayed,
        kills: t.kills,
        wave: t.wave,
        gunsUnlocked: t.gunsUnlocked.length,
        platform: player.platform || null,
        battlepassExpiresAt: player.battlepass.expiresAt
      };
      continue;
    }

    // Default (global) scope below

    // Check minimum games played
    if (player.gamesPlayed < tournament.minGamesPlayed) {
      results[wallet] = {
        eligible: false,
        reason: "insufficient_games",
        gamesPlayed: player.gamesPlayed,
        required: tournament.minGamesPlayed
      };
      continue;
    }

    // Check registration was before tournament end
    if (player.registeredAt > tournament.endsAt) {
      results[wallet] = { eligible: false, reason: "registered_after_deadline" };
      continue;
    }

    // Use tournament-specific frozen score if available, otherwise fall back to current high score
    const tournamentScore = player.tournamentScores && player.tournamentScores[tournamentId];
    let effectiveHighScore, effectiveScoreAt, scoreValid;

    if (tournamentScore) {
      // Player has a frozen score from when they played during the tournament
      effectiveHighScore = tournamentScore.highScore;
      effectiveScoreAt = tournamentScore.achievedAt;
      scoreValid = true;
    } else {
      // Fall back to current high score with timestamp validation
      effectiveHighScore = player.highScore;
      const lastHighScoreAt = player.lastHighScoreAt != null ? player.lastHighScoreAt : null;
      effectiveScoreAt = lastHighScoreAt;
      scoreValid = lastHighScoreAt === null || lastHighScoreAt <= tournament.endsAt;
    }

    // Passed all checks
    results[wallet] = {
      eligible: true,
      scope: 'global',
      displayName: player.displayName,
      highScore: effectiveHighScore,
      scoreValid,
      lastHighScoreAt: effectiveScoreAt,
      gamesPlayed: player.gamesPlayed,
      kills: player.kills || 0,
      wave: player.wave || 0,
      platform: player.platform || null
    };
  }

  return {
    success: true,
    tournamentId,
    tournamentName: tournament.name,
    status: tournament.status,
    snapshot: tournament.snapshot,
    scope,
    results
  };
}

/**
 * Finalize a tournament (admin only)
 * Marks tournament as finalized with a cutoff timestamp and snapshot ID
 * @param {Object} inputs - Finalize inputs
 * @param {string} inputs.tournamentId - Tournament identifier
 * @param {string} inputs.snapshotId - Identifier for the finalized snapshot
 * @param {string} inputs.message - Signed message
 * @param {string} inputs.signature - Signature
 * @returns {Object} Finalization result
 */
function finalizeTournament(inputs) {
  ensureTournaments();
  const { tournamentId, snapshotId, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) {
    throw new Error("Only admins can finalize tournaments");
  }

  if (!tournamentId || typeof tournamentId !== 'string') {
    throw new Error("tournamentId is required");
  }

  const tournament = state.tournaments[tournamentId];
  if (!tournament) {
    throw new Error(`Tournament '${tournamentId}' not found`);
  }

  if (tournament.status === "finalized") {
    throw new Error(`Tournament '${tournamentId}' is already finalized`);
  }

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `finalizeTournament:${caller}:${tournamentId}:${timestamp}`,
      expiresIn: "5 minutes",
      currentStatus: tournament.status
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || "Signature verification failed");
  }

  if (!snapshotId || typeof snapshotId !== 'string') {
    throw new Error("snapshotId is required");
  }

  tournament.status = "finalized";
  tournament.finalizedAt = Date.now();
  tournament.snapshot = snapshotId;

  return {
    success: true,
    message: `Tournament '${tournament.name}' finalized`,
    tournamentId,
    status: tournament.status,
    finalizedAt: tournament.finalizedAt,
    snapshot: tournament.snapshot
  };
}

// ============================================
// BATTLEPASS & WEAPON RE-ROLL
// ============================================

const ACCEPTED_TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  GORECAT: 'UbESBaztbkxJRWxPcfDeK8Fft15igTbrv3sed1bsegM',
  PLAY: 'PLAYs3GSSadH2q2JLS7djp7yzeT75NK78XgrE5YLrfq'
};

const DEFAULT_RARITY_POOL = {
  common:    { weight: 6500 },
  rare:      { weight: 3000 },
  legendary: { weight:  500 }
};

/**
 * Lazy migration for battlepass/reroll state on already-deployed contracts
 * @internal
 */
function ensureBattlepassState() {
  if (state.battlepassPriceUSD == null) state.battlepassPriceUSD = 7;
  if (state.rerollPriceUSD == null) state.rerollPriceUSD = 2;
  if (state.battlepassDurationDays == null) state.battlepassDurationDays = 30;
  if (!state.acceptedTokens) state.acceptedTokens = { ...ACCEPTED_TOKENS };
  if (!state.tokenDecimals) state.tokenDecimals = { [ACCEPTED_TOKENS.USDC]: 6 };
  if (!state.tokenUsdRates) state.tokenUsdRates = { GORECAT: null, PLAY: null };
  if (!state.rarityPool) state.rarityPool = JSON.parse(JSON.stringify(DEFAULT_RARITY_POOL));
  if (!state.battlepassAnalytics) {
    state.battlepassAnalytics = { totalSold: 0, totalRevenueUSD: 0, byCurrency: {} };
  }
  if (!state.rerollAnalytics) {
    state.rerollAnalytics = { totalRolls: 0, totalRevenueUSD: 0, byCurrency: {}, byRarity: {} };
  }
  if (!state.rerollAnalytics.byRarity) state.rerollAnalytics.byRarity = {};
  if (!state.usedRerollSigs) state.usedRerollSigs = {};
  if (!state.usedBattlepassSigs) state.usedBattlepassSigs = {};
}

/**
 * Lazy migration of new per-player fields (battlepass, reroll, playsoltourn stats).
 * Safe to call on every read/write — only fills missing fields, never overwrites.
 * @internal
 */
function ensurePlayerNewFields(player) {
  if (!player) return;
  if (player.battlepass === undefined) player.battlepass = null;
  if (player.rerollCount === undefined) player.rerollCount = 0;
  if (player.lastRerollRarity === undefined) player.lastRerollRarity = null;
  if (player.freeRollUsed === undefined) player.freeRollUsed = false;
  if (!player.playsoltourn) {
    player.playsoltourn = {
      highScore: 0,
      kills: 0,
      wave: 0,
      gamesPlayed: 0,
      gunsUnlocked: [],
      rerolls: 0,
      lastUpdatedAt: null
    };
  }
  if (player.playsoltourn.rerolls === undefined) player.playsoltourn.rerolls = 0;
}

/**
 * Resolve currency code -> { currency, mint, amount, decimals }
 * @internal
 */
async function computePaymentAmount(currency, priceUSD) {
  const c = String(currency || '').toUpperCase();
  if (c === 'SOL') {
    const solPrice = okx.getSolPrice();
    if (!solPrice || solPrice <= 0) throw new Error('SOL price unavailable');
    return {
      currency: 'SOL',
      mint: null,
      amount: Math.round((priceUSD / solPrice) * 10000) / 10000,
      decimals: 9
    };
  }
  const mint = state.acceptedTokens[c];
  if (!mint) throw new Error(`Unsupported currency: ${currency}`);

  // Resolve & cache decimals (fail loudly — wrong decimals = wrong amount on-chain)
  let decimals = state.tokenDecimals[mint];
  if (decimals == null) {
    const info = await umi.getTokenInfo(mint);
    if (info?.decimals == null) {
      throw new Error(
        `Decimals for ${c} (${mint}) not found via getTokenInfo. ` +
        `Admin must seed via adminSetTokenRate({token, decimals}).`
      );
    }
    decimals = info.decimals;
    state.tokenDecimals[mint] = decimals;
  }

  if (c === 'USDC') {
    return { currency: c, mint, amount: priceUSD, decimals };
  }

  // Token-denominated (GORECAT / PLAY) - admin-set rate (tokens per 1 USD)
  const rate = state.tokenUsdRates?.[c];
  if (!rate || rate <= 0) {
    throw new Error(`${c} payments are not enabled (admin must set rate)`);
  }
  return {
    currency: c,
    mint,
    amount: Math.round(priceUSD * rate * 1e6) / 1e6,
    decimals
  };
}

/**
 * Build unsigned payment transaction (SOL or SPL token) with memo
 * @internal
 */
async function buildPaymentTx(wallet, payInfo, memoText) {
  if (payInfo.currency === 'SOL') {
    const umiInstance = umi.createUmi();
    const userSigner = umi.createNoopSigner(wallet);
    const builder = umi.transactionBuilder()
      .setFeePayer(userSigner)
      .add(umi.transferSol(umiInstance, {
        source: userSigner,
        destination: umi.publicKey(state.treasuryPublicKey),
        amount: umi.sol(payInfo.amount)
      }))
      .add(umi.addMemo(umiInstance, { memo: memoText }));
    return await umi.buildPartialTransaction(umiInstance, builder);
  }

  // SPL token transfer (user signs client-side)
  return await umi.buildMultiTransferTx({
    transfers: [
      {
        type: 'token',
        from: wallet,
        to: state.treasuryPublicKey,
        amount: payInfo.amount,
        mint: payInfo.mint,
        decimals: payInfo.decimals
      },
      { type: 'memo', data: memoText }
    ],
    feePayer: wallet
  });
}

/**
 * Verify a payment landed at treasury for the expected amount/currency
 * @internal
 */
async function verifyPayment(txSignature, wallet, payInfo) {
  const parsed = await umi.parseTransaction(txSignature, {
    extractTransfers: true,
    includeTokenBalances: true
  });
  if (!parsed.success) {
    throw new Error(`Failed to parse transaction: ${parsed.error || 'Unknown error'}`);
  }
  const transfers = parsed.transfers || [];
  const minAmount = payInfo.amount * 0.90; // 10% slippage tolerance

  if (payInfo.currency === 'SOL') {
    const t = transfers.find(t =>
      !t.mint
      && t.to === state.treasuryPublicKey
      && t.from === wallet
      && t.amount >= minAmount
    );
    if (!t) throw new Error(`Payment not found. Expected ${payInfo.amount} SOL to treasury.`);
    return t;
  }

  const t = transfers.find(t =>
    t.mint === payInfo.mint
    && t.to === state.treasuryPublicKey
    && t.from === wallet
    && t.amount >= minAmount
  );
  if (!t) {
    throw new Error(`Payment not found. Expected ${payInfo.amount} ${payInfo.currency} to treasury.`);
  }
  return t;
}

/**
 * Server-side gacha roll for a rarity tier using VRF (provably fair)
 * @internal
 */
async function rollRarityInternal() {
  const entries = Object.entries(state.rarityPool).filter(([, r]) => (r.weight || 0) > 0);
  if (entries.length === 0) throw new Error('No rarities configured in pool');

  const totalWeight = entries.reduce((s, [, r]) => s + r.weight, 0);
  const vrfResult = await vrfApi.selectNumber(0, totalWeight - 1);
  const roll = vrfResult.result;

  let cumulative = 0;
  for (const [rarity, r] of entries) {
    cumulative += r.weight;
    if (roll < cumulative) {
      return { rarity, roll, totalWeight, vrfProof: vrfResult.proof };
    }
  }
  const [rarity] = entries[entries.length - 1];
  return { rarity, roll, totalWeight, vrfProof: vrfResult.proof };
}

/**
 * Get battlepass pricing in supported currencies (SOL, USDC)
 * @returns {Object} Battlepass info
 */
function getBattlepassInfo(_inputs) {
  ensureBattlepassState();
  const solPrice = okx.getSolPrice();
  const priceUSD = state.battlepassPriceUSD;

  return {
    success: true,
    priceUSD,
    durationDays: state.battlepassDurationDays,
    currencies: {
      SOL:  { amount: Math.round((priceUSD / solPrice) * 10000) / 10000, mint: null },
      USDC: { amount: priceUSD, mint: state.acceptedTokens.USDC }
    },
    treasuryWallet: state.treasuryPublicKey,
    solPriceUSD: solPrice
  };
}

/**
 * Get reroll pricing in all 4 supported currencies + drop rates
 * @returns {Object} Reroll info
 */
function getRerollInfo(inputs) {
  ensureBattlepassState();
  const solPrice = okx.getSolPrice();
  const priceUSD = state.rerollPriceUSD;

  // Per-caller free-roll status (only meaningful when called by a registered player)
  const callerWallet = inputs?.from;
  const caller = callerWallet ? state.players[callerWallet] : null;
  if (caller) ensurePlayerNewFields(caller);
  const freeRollAvailable = caller ? !caller.freeRollUsed : null;

  const currencies = {
    SOL:  { amount: Math.round((priceUSD / solPrice) * 10000) / 10000, mint: null, enabled: true },
    USDC: { amount: priceUSD, mint: state.acceptedTokens.USDC, enabled: true }
  };
  for (const c of ['GORECAT', 'PLAY']) {
    const rate = state.tokenUsdRates?.[c];
    currencies[c] = {
      amount: rate ? Math.round(priceUSD * rate * 1e6) / 1e6 : null,
      mint: state.acceptedTokens[c],
      enabled: rate != null && rate > 0
    };
  }

  const totalWeight = Object.values(state.rarityPool).reduce((s, r) => s + (r.weight || 0), 0);
  const dropRates = Object.entries(state.rarityPool).map(([rarity, r]) => ({
    rarity,
    chancePercent: totalWeight > 0 ? Number((r.weight / totalWeight * 100).toFixed(4)) : 0
  })).sort((a, b) => b.chancePercent - a.chancePercent);

  return {
    success: true,
    priceUSD,
    currencies,
    freeRollAvailable,
    treasuryWallet: state.treasuryPublicKey,
    solPriceUSD: solPrice,
    dropRates
  };
}

/**
 * Buy battlepass (2-step flow: get unsigned tx, then submit signature)
 * @param {Object} inputs - Purchase inputs (from is auto-injected)
 * @param {string} [inputs.currency='SOL'] - 'SOL' or 'USDC'
 * @param {string} [inputs.txSignature] - Payment signature (omit on step 1)
 * @returns {Object} Unsigned tx OR purchase confirmation
 */
async function buyBattlepass(inputs) {
  ensureBattlepassState();
  const { currency = 'SOL', txSignature } = inputs;
  const wallet = inputs.from;

  const player = state.players[wallet];
  if (!player) throw new Error('Player not registered');

  const c = String(currency).toUpperCase();
  if (c !== 'SOL' && c !== 'USDC') {
    throw new Error('Battlepass accepts SOL or USDC only');
  }

  const payInfo = await computePaymentAmount(c, state.battlepassPriceUSD);

  // STEP 1: build unsigned tx
  if (!txSignature) {
    const memo = `gorecatpsg1:battlepass:${wallet.slice(0, 8)}`;
    const tx = await buildPaymentTx(wallet, payInfo, memo);
    return {
      success: true,
      requiresPayment: true,
      transaction: tx,
      currency: c,
      amount: payInfo.amount,
      mint: payInfo.mint,
      priceUSD: state.battlepassPriceUSD,
      durationDays: state.battlepassDurationDays,
      treasuryWallet: state.treasuryPublicKey
    };
  }

  // STEP 2: verify payment, activate battlepass
  if (state.usedBattlepassSigs[txSignature]) {
    throw new Error('This payment has already been redeemed');
  }
  await verifyPayment(txSignature, wallet, payInfo);
  state.usedBattlepassSigs[txSignature] = Date.now();

  const now = Date.now();
  // Battlepass is permanent — expiry pinned to 2100-01-01 UTC so all existing
  // bpActive checks (expiresAt > now) keep working without schema or FE changes.
  // Effectively forever; revisit before the year 2099.
  const expiresAt = 4102444800000;

  player.battlepass = {
    activatedAt: now,
    expiresAt,
    currency: c,
    txSignature
  };
  player.lastActive = now;

  // Analytics
  state.battlepassAnalytics.totalSold++;
  state.battlepassAnalytics.totalRevenueUSD += state.battlepassPriceUSD;
  if (!state.battlepassAnalytics.byCurrency[c]) {
    state.battlepassAnalytics.byCurrency[c] = { count: 0, revenue: 0 };
  }
  state.battlepassAnalytics.byCurrency[c].count++;
  state.battlepassAnalytics.byCurrency[c].revenue += payInfo.amount;

  return {
    success: true,
    message: 'Battlepass activated!',
    battlepass: player.battlepass,
    expiresAt
  };
}

/**
 * Re-roll a weapon (gacha). 2-step flow.
 * @param {Object} inputs - Reroll inputs (from is auto-injected)
 * @param {string} [inputs.currency='SOL'] - 'SOL' | 'USDC' | 'GORECAT' | 'PLAY'
 * @param {string} [inputs.txSignature] - Payment signature (omit on step 1)
 * @returns {Object} Unsigned tx OR roll result with VRF proof
 */
async function rerollWeapon(inputs) {
  ensureBattlepassState();
  const { currency = 'SOL', txSignature, useFreeRoll } = inputs;
  const wallet = inputs.from;

  const player = state.players[wallet];
  if (!player) throw new Error('Player not registered');
  ensurePlayerNewFields(player);

  // Free-roll path is now explicit — caller must pass `useFreeRoll: true`.
  // This prevents a test click / retried request / accidental dispatch from
  // silently burning the freebie. Bare rerollWeapon({from}) calls now go to
  // the paid 2-step flow (returns unsigned tx) without consuming the free roll.
  if (useFreeRoll === true) {
    if (player.freeRollUsed) {
      throw new Error('Free roll already used. Use the paid flow with a currency + txSignature.');
    }
    player.freeRollUsed = true;
    const result = await rollRarityInternal();

    player.rerollCount = (player.rerollCount || 0) + 1;
    player.lastRerollRarity = result.rarity;
    player.lastActive = Date.now();

    // Mirror into playsoltourn scope when battlepass is active
    const bpActive = !!(player.battlepass && player.battlepass.expiresAt > Date.now());
    if (bpActive) {
      player.playsoltourn.rerolls++;
      player.playsoltourn.lastUpdatedAt = Date.now();
    }

    state.rerollAnalytics.totalRolls++;
    state.rerollAnalytics.byRarity[result.rarity] =
      (state.rerollAnalytics.byRarity[result.rarity] || 0) + 1;

    return {
      success: true,
      free: true,
      message: `Free roll: ${result.rarity}!`,
      rarity: result.rarity,
      vrfProof: result.vrfProof,
      rerollCount: player.rerollCount
    };
  }

  const c = String(currency).toUpperCase();
  if (!['SOL', 'USDC', 'GORECAT', 'PLAY'].includes(c)) {
    throw new Error('Re-roll accepts SOL, USDC, GORECAT, or PLAY');
  }

  const payInfo = await computePaymentAmount(c, state.rerollPriceUSD);

  // STEP 1: build unsigned tx
  if (!txSignature) {
    const memo = `gorecatpsg1:reroll:${wallet.slice(0, 8)}`;
    const tx = await buildPaymentTx(wallet, payInfo, memo);
    return {
      success: true,
      requiresPayment: true,
      transaction: tx,
      currency: c,
      amount: payInfo.amount,
      mint: payInfo.mint,
      priceUSD: state.rerollPriceUSD,
      treasuryWallet: state.treasuryPublicKey
    };
  }

  // STEP 2: verify payment, perform server-side VRF roll
  if (state.usedRerollSigs[txSignature]) {
    throw new Error('This payment has already been redeemed');
  }
  await verifyPayment(txSignature, wallet, payInfo);
  state.usedRerollSigs[txSignature] = Date.now();

  const result = await rollRarityInternal();

  player.rerollCount = (player.rerollCount || 0) + 1;
  player.lastRerollRarity = result.rarity;
  player.lastActive = Date.now();

  // Mirror into playsoltourn scope when battlepass is active
  const bpActive = !!(player.battlepass && player.battlepass.expiresAt > Date.now());
  if (bpActive) {
    player.playsoltourn.rerolls++;
    player.playsoltourn.lastUpdatedAt = Date.now();
  }

  // Analytics
  state.rerollAnalytics.totalRolls++;
  state.rerollAnalytics.totalRevenueUSD += state.rerollPriceUSD;
  if (!state.rerollAnalytics.byCurrency[c]) {
    state.rerollAnalytics.byCurrency[c] = { count: 0, revenue: 0 };
  }
  state.rerollAnalytics.byCurrency[c].count++;
  state.rerollAnalytics.byCurrency[c].revenue += payInfo.amount;
  state.rerollAnalytics.byRarity[result.rarity] =
    (state.rerollAnalytics.byRarity[result.rarity] || 0) + 1;

  return {
    success: true,
    message: `Rolled ${result.rarity}!`,
    rarity: result.rarity,
    vrfProof: result.vrfProof,
    rerollCount: player.rerollCount
  };
}

/**
 * Admin: set token-per-USD rate for GORECAT or PLAY (or null to disable)
 * @param {Object} inputs
 * @param {string} inputs.token - 'GORECAT' | 'PLAY'
 * @param {number|null} inputs.usdRate - tokens equal to 1 USD, or null to disable
 * @returns {Object} Result
 */
function adminSetTokenRate(inputs) {
  ensureBattlepassState();
  const { token, usdRate, decimals, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) throw new Error('Only admins can set token rates');

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminSetTokenRate:${caller}:${token}:${timestamp}`,
      expiresIn: '5 minutes',
      currentRates: state.tokenUsdRates
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || 'Signature verification failed');
  }

  const t = String(token || '').toUpperCase();
  if (!['GORECAT', 'PLAY'].includes(t)) {
    throw new Error('Token must be GORECAT or PLAY');
  }
  if (usdRate !== null && (typeof usdRate !== 'number' || usdRate <= 0)) {
    throw new Error('usdRate must be a positive number, or null to disable');
  }

  state.tokenUsdRates[t] = usdRate;

  // Optionally seed decimals so payment math doesn't depend on Helius metadata
  if (typeof decimals === 'number' && decimals >= 0 && decimals <= 18) {
    const mint = state.acceptedTokens[t];
    state.tokenDecimals[mint] = decimals;
  }

  return {
    success: true,
    token: t,
    usdRate,
    decimals: state.tokenDecimals[state.acceptedTokens[t]] ?? null,
    message: usdRate
      ? `${t} rate set to ${usdRate} tokens per USD`
      : `${t} payments disabled`
  };
}

/**
 * Admin: update battlepass / reroll USD prices and battlepass duration
 * @param {Object} inputs
 * @param {number} [inputs.battlepassPriceUSD]
 * @param {number} [inputs.rerollPriceUSD]
 * @param {number} [inputs.battlepassDurationDays]
 * @returns {Object} Result
 */
function adminSetPrices(inputs) {
  ensureBattlepassState();
  const { battlepassPriceUSD, rerollPriceUSD, battlepassDurationDays, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) throw new Error('Only admins can update prices');

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminSetPrices:${caller}:${timestamp}`,
      expiresIn: '5 minutes',
      current: {
        battlepassPriceUSD: state.battlepassPriceUSD,
        rerollPriceUSD: state.rerollPriceUSD,
        battlepassDurationDays: state.battlepassDurationDays
      }
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || 'Signature verification failed');
  }

  if (typeof battlepassPriceUSD === 'number' && battlepassPriceUSD > 0) {
    state.battlepassPriceUSD = battlepassPriceUSD;
  }
  if (typeof rerollPriceUSD === 'number' && rerollPriceUSD > 0) {
    state.rerollPriceUSD = rerollPriceUSD;
  }
  if (typeof battlepassDurationDays === 'number' && battlepassDurationDays > 0) {
    state.battlepassDurationDays = battlepassDurationDays;
  }

  return {
    success: true,
    prices: {
      battlepassPriceUSD: state.battlepassPriceUSD,
      rerollPriceUSD: state.rerollPriceUSD,
      battlepassDurationDays: state.battlepassDurationDays
    }
  };
}

/**
 * Admin: configure the rarity pool (set/replace weights)
 * @param {Object} inputs
 * @param {Object} inputs.rarityPool - Map of rarity -> { weight }
 *   e.g. { common: {weight: 6500}, rare: {weight: 3000}, legendary: {weight: 500} }
 * @returns {Object} Result
 */
function adminSetRarityPool(inputs) {
  ensureBattlepassState();
  const { rarityPool, message, signature } = inputs;
  const caller = inputs.from;

  if (!isAdmin(caller)) throw new Error('Only admins can configure rarity pool');

  if (!signature) {
    const timestamp = Date.now();
    return {
      success: true,
      requiresSignature: true,
      message: `adminSetRarityPool:${caller}:${timestamp}`,
      expiresIn: '5 minutes',
      currentPool: state.rarityPool
    };
  }

  const verification = verify.verifyTimeBoundSignature(message, signature, caller, 5);
  if (!verification?.success) {
    throw new Error(verification?.error || 'Signature verification failed');
  }

  if (!rarityPool || typeof rarityPool !== 'object') {
    throw new Error('rarityPool must be an object');
  }

  for (const [rarity, r] of Object.entries(rarityPool)) {
    if (typeof r.weight !== 'number' || r.weight < 0) {
      throw new Error(`Invalid weight for rarity '${rarity}'`);
    }
  }

  state.rarityPool = rarityPool;

  return {
    success: true,
    message: 'Rarity pool updated',
    rarities: Object.keys(rarityPool),
    totalWeight: Object.values(rarityPool).reduce((s, r) => s + r.weight, 0)
  };
}

/**
 * Get a player's battlepass status
 * @param {Object} inputs
 * @param {string} [inputs.targetWallet] - Optional, defaults to caller
 * @returns {Object} Battlepass status
 */
function getBattlepassStatus(inputs) {
  ensureBattlepassState();
  const wallet = inputs.targetWallet || inputs.from;
  const player = state.players[wallet];
  if (!player) return { success: false, error: 'Player not found' };

  const bp = player.battlepass;
  const now = Date.now();
  const active = !!(bp && bp.expiresAt > now);

  return {
    success: true,
    active,
    battlepass: bp || null,
    timeRemaining: active ? bp.expiresAt - now : 0
  };
}

/**
 * Battlepass + reroll analytics summary (public)
 * @returns {Object} Analytics
 */
function getMonetizationAnalytics(_inputs) {
  ensureBattlepassState();
  return {
    success: true,
    battlepass: state.battlepassAnalytics,
    reroll: state.rerollAnalytics,
    config: {
      battlepassPriceUSD: state.battlepassPriceUSD,
      rerollPriceUSD: state.rerollPriceUSD,
      battlepassDurationDays: state.battlepassDurationDays,
      tokenUsdRates: state.tokenUsdRates
    }
  };
}
