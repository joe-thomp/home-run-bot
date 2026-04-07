require('dotenv').config();
const Discord = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
const { execFile } = require('child_process');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');

class BaseballBot {
    constructor(token, channelIds, options = {}) {
        this.client = new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.MessageContent
            ]
        });
        this.token = token;
        this.channelIds = Array.isArray(channelIds) ? channelIds : [channelIds];
        this.currentSeason = new Date().getFullYear();
        
        // Players to monitor
        this.players = {
            '592450': { name: 'Aaron Judge', team: 'NYY', number: '99', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '665862': { name: 'Jazz Chisholm Jr.', team: 'NYY', number: '13', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '665742': { name: 'Juan Soto', team: 'NYM', number: '22', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '660271': { name: 'Shohei Ohtani', team: 'LAD', number: '17', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '656941': { name: 'Kyle Schwarber', team: 'PHI', number: '12', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '547180': { name: 'Bryce Harper', team: 'PHI', number: '3', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '683002': { name: 'Gunnar Henderson', team: 'BAL', number: '2', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '545361': { name: 'Mike Trout', team: 'LAA', number: '27', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} }
        };
        for (const playerData of Object.values(this.players)) {
            playerData.sentHomeRunsByChannel = {};
        }

        this.statePath = options.statePath || path.join(__dirname, 'data', 'bot_state.json');
        this.botUsername = options.botUsername || null;
        this.adminUserIds = new Set((options.adminUserIds || []).map(id => id.toString()));

        this.debugging = true;
        this.lastCheckTime = null;
        this.checkInProgress = null;
        this.pendingNotifications = new Set(); // hrIds currently waiting for Statcast before sending
    }

    getPlayerHeadshotUrl(playerName) {
        const headshots = {
            'Aaron Judge': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current',
            'Jazz Chisholm Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665862/headshot/67/current',
            'Juan Soto': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665742/headshot/67/current',
            'Shohei Ohtani': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660271/headshot/67/current',
            'Kyle Schwarber': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/656941/headshot/67/current',
            'Bryce Harper': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/547180/headshot/67/current',
            'Gunnar Henderson': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/683002/headshot/67/current'
        };
        return headshots[playerName] || null;
    }

    getPlayerHeadshotUrlById(playerId) {
        if (!playerId) {
            return null;
        }

        return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${playerId}/headshot/67/current`;
    }

    loadState() {
        if (!fs.existsSync(this.statePath)) {
            return new Set();
        }

        try {
            const rawState = fs.readFileSync(this.statePath, 'utf8');
            const parsedState = JSON.parse(rawState);

            if (parsedState.season !== this.currentSeason || !parsedState.players) {
                return new Set();
            }

            const restoredPlayers = new Set();
            for (const [playerId, savedState] of Object.entries(parsedState.players)) {
                if (!this.players[playerId]) {
                    continue;
                }

                this.players[playerId].lastCheckedHR = Number(savedState.lastCheckedHR) || 0;
                const legacySentHomeRuns = Array.isArray(savedState.sentHomeRuns) ? savedState.sentHomeRuns : [];
                this.players[playerId].sentHomeRuns = new Set(legacySentHomeRuns);
                this.players[playerId].sentHomeRunsByChannel = {};
                for (const channelId of this.channelIds) {
                    const perChannelSentHomeRuns = Array.isArray(savedState.sentHomeRunsByChannel?.[channelId])
                        ? savedState.sentHomeRunsByChannel[channelId]
                        : legacySentHomeRuns;
                    this.players[playerId].sentHomeRunsByChannel[channelId] = new Set(perChannelSentHomeRuns);
                }
                this.rebuildSentHomeRuns(this.players[playerId]);
                this.players[playerId].homeRunParks = savedState.homeRunParks || {};
                restoredPlayers.add(playerId);
            }

            return restoredPlayers;
        } catch (error) {
            this.log(`Could not load state file: ${error.message}`);
            return new Set();
        }
    }

    saveState() {
        try {
            const stateDir = path.dirname(this.statePath);
            if (!fs.existsSync(stateDir)) {
                fs.mkdirSync(stateDir, { recursive: true });
            }

            const serializedPlayers = {};
            for (const [playerId, playerData] of Object.entries(this.players)) {
                this.ensurePlayerDeliveryState(playerData);
                this.rebuildSentHomeRuns(playerData);
                const serializedPerChannelState = {};
                for (const channelId of this.channelIds) {
                    serializedPerChannelState[channelId] = Array.from(playerData.sentHomeRunsByChannel[channelId]);
                }

                serializedPlayers[playerId] = {
                    lastCheckedHR: playerData.lastCheckedHR,
                    sentHomeRuns: Array.from(playerData.sentHomeRuns),
                    sentHomeRunsByChannel: serializedPerChannelState,
                    homeRunParks: playerData.homeRunParks || {}
                };
            }

            fs.writeFileSync(this.statePath, JSON.stringify({
                season: this.currentSeason,
                updatedAt: new Date().toISOString(),
                players: serializedPlayers
            }, null, 2));
        } catch (error) {
            this.log(`Could not save state file: ${error.message}`);
        }
    }

    ensurePlayerDeliveryState(playerData) {
        if (!(playerData.sentHomeRuns instanceof Set)) {
            playerData.sentHomeRuns = new Set(Array.isArray(playerData.sentHomeRuns) ? playerData.sentHomeRuns : []);
        }

        if (!playerData.sentHomeRunsByChannel || typeof playerData.sentHomeRunsByChannel !== 'object') {
            playerData.sentHomeRunsByChannel = {};
        }

        for (const channelId of this.channelIds) {
            if (!(playerData.sentHomeRunsByChannel[channelId] instanceof Set)) {
                const existingIds = Array.isArray(playerData.sentHomeRunsByChannel[channelId])
                    ? playerData.sentHomeRunsByChannel[channelId]
                    : Array.from(playerData.sentHomeRuns);
                playerData.sentHomeRunsByChannel[channelId] = new Set(existingIds);
            }
        }
    }

    rebuildSentHomeRuns(playerData) {
        this.ensurePlayerDeliveryState(playerData);
        const fullySentHomeRuns = new Set();
        const candidateIds = new Set();

        for (const channelId of this.channelIds) {
            for (const hrId of playerData.sentHomeRunsByChannel[channelId]) {
                candidateIds.add(hrId);
            }
        }

        for (const hrId of candidateIds) {
            if (this.channelIds.every(channelId => playerData.sentHomeRunsByChannel[channelId].has(hrId))) {
                fullySentHomeRuns.add(hrId);
            }
        }

        playerData.sentHomeRuns = fullySentHomeRuns;
        return fullySentHomeRuns;
    }

    getPendingChannelIdsForHomeRun(playerData, hrId) {
        this.ensurePlayerDeliveryState(playerData);
        return this.channelIds.filter(channelId => !playerData.sentHomeRunsByChannel[channelId].has(hrId));
    }

    markHomeRunSentToChannels(playerData, hrId, channelIds) {
        if (!Array.isArray(channelIds) || channelIds.length === 0) {
            return;
        }

        this.ensurePlayerDeliveryState(playerData);
        for (const channelId of channelIds) {
            if (!playerData.sentHomeRunsByChannel[channelId]) {
                playerData.sentHomeRunsByChannel[channelId] = new Set();
            }
            playerData.sentHomeRunsByChannel[channelId].add(hrId);
        }

        this.rebuildSentHomeRuns(playerData);
    }

    isHomeRunFullySent(playerData, hrId) {
        this.ensurePlayerDeliveryState(playerData);
        return this.channelIds.every(channelId => playerData.sentHomeRunsByChannel[channelId].has(hrId));
    }

    countContiguousDeliveredHomeRuns(playerData, homeRunDetails) {
        let deliveredCount = 0;
        for (const hrDetail of homeRunDetails) {
            if (this.isFallbackHomeRunDetail(hrDetail)) {
                break;
            }

            const hrId = this.buildHomeRunId(hrDetail);
            if (!this.isHomeRunFullySent(playerData, hrId)) {
                break;
            }

            deliveredCount++;
        }

        return deliveredCount;
    }

    createHomeRunDetail(overrides = {}) {
        return {
            distance: 'Distance not available',
            rbi: 1,
            rbiDescription: 'Solo HR',
            detailStatus: 'confirmed',
            gameId: null,
            gameDate: null,
            eventKey: null,
            atBatIndex: null,
            gameHomeRunIndex: null,
            ...overrides
        };
    }

    createFallbackHomeRunDetails(count, playerId) {
        return Array.from({ length: count }, (_, index) => this.createHomeRunDetail({
            detailStatus: 'fallback',
            eventKey: `${playerId}_${this.currentSeason}_fallback_${index + 1}`
        }));
    }

    isFallbackHomeRunDetail(hrDetail) {
        if (!hrDetail) {
            return true;
        }

        return hrDetail.detailStatus === 'fallback' ||
            (!hrDetail.gameId && String(hrDetail.eventKey || '').includes('_fallback_'));
    }

    sortHomeRunDetailsChronologically(details) {
        return (Array.isArray(details) ? details : [])
            .map((detail, index) => ({ detail, index }))
            .sort((left, right) => {
                const leftDate = left.detail?.gameDate ? new Date(left.detail.gameDate).getTime() : Number.MAX_SAFE_INTEGER;
                const rightDate = right.detail?.gameDate ? new Date(right.detail.gameDate).getTime() : Number.MAX_SAFE_INTEGER;
                if (leftDate !== rightDate) {
                    return leftDate - rightDate;
                }

                const leftGameId = Number.parseInt(left.detail?.gameId, 10);
                const rightGameId = Number.parseInt(right.detail?.gameId, 10);
                const safeLeftGameId = Number.isFinite(leftGameId) ? leftGameId : Number.MAX_SAFE_INTEGER;
                const safeRightGameId = Number.isFinite(rightGameId) ? rightGameId : Number.MAX_SAFE_INTEGER;
                if (safeLeftGameId !== safeRightGameId) {
                    return safeLeftGameId - safeRightGameId;
                }

                const leftAtBatIndex = Number.isInteger(left.detail?.atBatIndex) ? left.detail.atBatIndex : Number.MAX_SAFE_INTEGER;
                const rightAtBatIndex = Number.isInteger(right.detail?.atBatIndex) ? right.detail.atBatIndex : Number.MAX_SAFE_INTEGER;
                if (leftAtBatIndex !== rightAtBatIndex) {
                    return leftAtBatIndex - rightAtBatIndex;
                }

                const leftGameHomeRunIndex = Number.isInteger(left.detail?.gameHomeRunIndex) ? left.detail.gameHomeRunIndex : Number.MAX_SAFE_INTEGER;
                const rightGameHomeRunIndex = Number.isInteger(right.detail?.gameHomeRunIndex) ? right.detail.gameHomeRunIndex : Number.MAX_SAFE_INTEGER;
                if (leftGameHomeRunIndex !== rightGameHomeRunIndex) {
                    return leftGameHomeRunIndex - rightGameHomeRunIndex;
                }

                return left.index - right.index;
            })
            .map(item => item.detail);
    }

    buildHomeRunId(hrDetail) {
        if (hrDetail.eventKey) {
            return hrDetail.eventKey;
        }

        return [
            hrDetail.gameId || 'unknown',
            hrDetail.gameDate || 'unknown',
            hrDetail.gameHomeRunIndex || 'unknown',
            hrDetail.distance || 'unknown',
            hrDetail.rbi || 'unknown'
        ].join('_');
    }

    buildPlayIdentifiers(play, gameId, gameDate, gameHomeRunIndex) {
        const atBatIndex = Number.isInteger(play.about?.atBatIndex) ? play.about.atBatIndex : null;
        const eventKey = atBatIndex !== null
            ? `${gameId}_${atBatIndex}`
            : `${gameId}_${gameDate || 'unknown'}_${gameHomeRunIndex}`;

        return {
            atBatIndex,
            gameHomeRunIndex,
            eventKey
        };
    }

    findPlayerIdByName(playerName) {
        return Object.keys(this.players).find(id =>
            this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
        );
    }

    isAdminMessage(message) {
        if (this.adminUserIds.has(message.author.id)) {
            return true;
        }

        return Boolean(
            message.member &&
            message.member.permissions &&
            message.member.permissions.has(Discord.PermissionFlagsBits.Administrator)
        );
    }

    async ensureAdmin(message) {
        if (this.isAdminMessage(message)) {
            return true;
        }

        await message.reply('That command is admin-only. Use a server admin account or add your Discord user ID to ADMIN_USER_IDS.');
        return false;
    }

    async syncBotProfile() {
        if (!this.botUsername || !this.client.user) {
            return;
        }

        if (this.client.user.username === this.botUsername) {
            this.log(`Bot username already set to ${this.botUsername}`);
            return;
        }

        try {
            await this.client.user.setUsername(this.botUsername);
            this.log(`Updated bot username to ${this.botUsername}`);
        } catch (error) {
            this.log(`Could not update bot username automatically: ${error.message}`);
        }
    }

    log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }

    async initialize() {
        this.log('Initializing bot...');
        this.log(`Configured to send alerts to ${this.channelIds.length} channel(s): ${this.channelIds.join(', ')}`);
        
        const restoredPlayers = this.loadState();

        for (const playerId of Object.keys(this.players)) {
            if (restoredPlayers.has(playerId)) {
                this.log(`Restored ${this.players[playerId].name}: ${this.players[playerId].lastCheckedHR} HRs`);
                continue;
            }

            const currentHR = await this.getPlayerHomeRuns(playerId);
            this.players[playerId].lastCheckedHR = currentHR;
            this.log(`Initialized ${this.players[playerId].name}: ${currentHR} HRs`);
        }

        this.saveState();
        
        this.client.on('ready', async () => {
            this.log(`Bot logged in as ${this.client.user.tag}`);
            await this.syncBotProfile();
            this.startMonitoring();
        });

        this.client.on('error', (error) => {
            this.log(`Discord client error: ${error.message}`);
            console.error('Full error:', error);
        });

        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;
            await this.handleCommand(message);
        });

        await this.client.login(this.token);
    }

    async getPlayerStats(playerId) {
        try {
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&season=${this.currentSeason}&group=hitting`
            );
            
            const stats = response.data.stats[0];
            if (stats && stats.splits && stats.splits.length > 0) {
                return stats.splits[0].stat;
            }
            return null;
        } catch (error) {
            this.log(`Error fetching stats for player ${playerId}: ${error.message}`);
            return null;
        }
    }

    async getPlayerHomeRuns(playerId) {
        const stats = await this.getPlayerStats(playerId);
        return stats ? parseInt(stats.homeRuns) || 0 : 0;
    }

    async getRecentHomeRunDetails(playerId, newHomeRunCount = 1) {
        try {
            // Get player's game log without limit
            const gamesResponse = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
            );
            
            this.log(`Successfully fetched game log for player ${playerId}`);
            
            if (!gamesResponse.data.stats || !gamesResponse.data.stats[0] || !gamesResponse.data.stats[0].splits) {
                return this.createFallbackHomeRunDetails(newHomeRunCount, playerId);
            }

            // Sort games descending by date and filter for games with HRs
            const hrGames = gamesResponse.data.stats[0].splits
                .filter(game => game.stat.homeRuns > 0)
                .sort((a, b) => new Date(b.date) - new Date(a.date));

            if (hrGames.length === 0) {
                return this.createFallbackHomeRunDetails(newHomeRunCount, playerId);
            }

            // Process the most recent HR game(s)
            const detailsList = [];
            let homeRunsFound = 0;
            
            for (let i = 0; i < hrGames.length && homeRunsFound < newHomeRunCount; i++) {
                const game = hrGames[i];
                const gameId = game.game?.gamePk;
                const homeRunsInThisGame = game.stat.homeRuns;
                
                if (!gameId) continue;

                try {
                    // Use playByPlay endpoint
                    const gameDetailResponse = await axios.get(
                        `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
                    );
                    
                    const gameData = gameDetailResponse.data;
                    if (!gameData.allPlays) {
                        // Fallback to feed/live
                        const liveFeedResponse = await axios.get(
                            `https://statsapi.mlb.com/api/v1/game/${gameId}/feed/live`
                        );
                        gameData.allPlays = liveFeedResponse.data.liveData?.plays?.allPlays || [];
                    }

                    // Find all HR plays by this player in this game
                    const plays = gameData.allPlays || [];
                    const hrPlaysInGame = [];
                    
                    for (const play of plays) {
                        if (this.isHomeRunByPlayer(play, playerId)) {
                            const gameHomeRunIndex = hrPlaysInGame.length + 1;
                            const identifiers = this.buildPlayIdentifiers(play, gameId, game.date, gameHomeRunIndex);
                            const distance = this.extractDistanceFromPlay(play);
                            const rbiInfo = this.extractRBIInfo(play);
                            hrPlaysInGame.push({
                                distance, 
                                rbi: rbiInfo.rbi,
                                rbiDescription: rbiInfo.rbiDescription,
                                gameId,
                                gameDate: game.date,
                                ...identifiers
                            });
                        }
                    }

                    // If we found the expected number of HRs in play-by-play data
                    if (hrPlaysInGame.length >= homeRunsInThisGame) {
                        // Add all the home runs from this game
                        detailsList.push(...hrPlaysInGame);
                        homeRunsFound += hrPlaysInGame.length;
                    } else if (hrPlaysInGame.length > 0) {
                        // We found some but not all home runs
                        detailsList.push(...hrPlaysInGame);
                        homeRunsFound += hrPlaysInGame.length;
                        
                        // Add placeholder for missing home runs
                        const missing = homeRunsInThisGame - hrPlaysInGame.length;
                        for (let j = 0; j < missing && homeRunsFound < newHomeRunCount; j++) {
                            const gameHomeRunIndex = hrPlaysInGame.length + j + 1;
                            detailsList.push(this.createHomeRunDetail({
                                distance: 'Not yet available',
                                rbi: 'unknown',
                                rbiDescription: 'HR (details pending)',
                                detailStatus: 'pending',
                                gameId,
                                gameDate: game.date,
                                gameHomeRunIndex,
                                eventKey: `${gameId}_${game.date}_placeholder_${gameHomeRunIndex}`
                            }));
                            homeRunsFound++;
                        }
                    } else {
                        // No play-by-play data found, add placeholders
                        for (let j = 0; j < homeRunsInThisGame && homeRunsFound < newHomeRunCount; j++) {
                            const gameHomeRunIndex = j + 1;
                            detailsList.push(this.createHomeRunDetail({
                                distance: 'Not yet available',
                                rbi: 'unknown',
                                rbiDescription: 'HR (details pending)',
                                detailStatus: 'pending',
                                gameId,
                                gameDate: game.date,
                                gameHomeRunIndex,
                                eventKey: `${gameId}_${game.date}_placeholder_${gameHomeRunIndex}`
                            }));
                            homeRunsFound++;
                        }
                    }

                    // Statcast fallback for missing details
                    for (let j = 0; j < detailsList.length; j++) {
                        if (detailsList[j].distance === "Not yet available" || detailsList[j].rbi === "unknown") {
                            const statcastDetails = await this.getHomeRunDetailsFromStatcast(
                                playerId,
                                detailsList[j].gameId,
                                detailsList[j].gameHomeRunIndex || 1
                            );
                            if (statcastDetails) {
                                detailsList[j] = { ...detailsList[j], ...statcastDetails };
                            }
                        }
                    }
                } catch (gameError) {
                    this.log(`Error fetching game ${gameId} details: ${gameError.message}`);
                    // Add placeholders for this game's home runs
                    for (let j = 0; j < homeRunsInThisGame && homeRunsFound < newHomeRunCount; j++) {
                        const gameHomeRunIndex = j + 1;
                        detailsList.push(this.createHomeRunDetail({
                            distance: 'Not yet available',
                            rbi: 'unknown',
                            rbiDescription: 'HR (details pending)',
                            detailStatus: 'pending',
                            gameId,
                            gameDate: game.date,
                            gameHomeRunIndex,
                            eventKey: `${gameId}_${game.date}_placeholder_${gameHomeRunIndex}`
                        }));
                        homeRunsFound++;
                    }
                }
            }
            
            // Return list of details for the new home runs
            return detailsList.length > 0
                ? this.sortHomeRunDetailsChronologically(detailsList)
                : this.createFallbackHomeRunDetails(newHomeRunCount, playerId);
        } catch (error) {
            this.log(`Error fetching home run details: ${error.message}`);
            return this.createFallbackHomeRunDetails(newHomeRunCount, playerId);
        }
    }

    // Updated helper method to check if a play is a home run
    isHomeRunByPlayer(play, playerId) {
        // Check if it's the right player
        const batterId = play.matchup?.batter?.id || play.result?.batter?.id;
        if (batterId?.toString() !== playerId) {
            return false;
        }
        
        // Check multiple fields for home run indication
        const isHomeRun = 
            play.result?.event === 'Home Run' || 
            play.result?.eventType === 'home_run' ||
            play.result?.type === 'home_run' ||
            (play.result?.description && play.result.description.toLowerCase().includes('homers')) ||
            (play.result?.description && play.result.description.toLowerCase().includes('home run'));
        
        return isHomeRun;
    }

    // CRITICAL FIX: Updated method to extract distance from the correct location
    extractDistanceFromPlay(play) {
        let distance = "Distance not available";
        
        // Priority 1: Check playEvents array (THIS IS WHERE THE DATA ACTUALLY IS!)
        if (play.playEvents && Array.isArray(play.playEvents)) {
            for (const event of play.playEvents) {
                if (event.hitData && event.hitData.totalDistance) {
                    distance = `${Math.round(event.hitData.totalDistance)} ft`;
                    this.log(`Found distance in playEvents: ${distance}`);
                    break;
                }
            }
        }
        
        // Priority 2: Check hitData at play level (rarely populated)
        if (distance === "Distance not available" && play.hitData) {
            if (play.hitData.totalDistance) {
                distance = `${Math.round(play.hitData.totalDistance)} ft`;
                this.log(`Found distance in play.hitData: ${distance}`);
            } else if (play.hitData.launchDistance) {
                distance = `${Math.round(play.hitData.launchDistance)} ft`;
                this.log(`Found launch distance: ${distance}`);
            }
        }
        
        // Priority 3: Parse from description as last resort
        if (distance === "Distance not available" && play.result?.description) {
            const patterns = [
                /(\d{3,4})\s*(?:feet|foot|ft)/i,
                /\((\d{3,4})\s*ft\)/i,
                /(\d{3,4})-foot/i,
                /traveled\s*(\d{3,4})/i
            ];
            
            for (const pattern of patterns) {
                const match = play.result.description.match(pattern);
                if (match && match[1]) {
                    distance = `${match[1]} ft`;
                    this.log(`Found distance in description: ${distance}`);
                    break;
                }
            }
        }
        
        return distance;
    }

    // Updated RBI extraction with better detection
    extractRBIInfo(play) {
        let rbi = 1; // Default to solo HR
        let rbiDescription = "Solo HR";
        
        // Priority 1: Check result.rbi field
        if (play.result && typeof play.result.rbi === 'number' && play.result.rbi > 0) {
            rbi = play.result.rbi;
            this.log(`Found RBI in result.rbi: ${rbi}`);
        } 
        // Priority 2: Check runners who scored
        else if (play.runners && Array.isArray(play.runners)) {
            // Count runners who scored (including the batter)
            const scoringRunners = play.runners.filter(runner => 
                runner.movement && 
                (runner.movement.end === 'score' || runner.movement.outBase === 'score')
            );
            
            if (scoringRunners.length > 0) {
                rbi = scoringRunners.length;
                this.log(`Found ${rbi} scoring runners`);
            } else {
                this.log(`No scoring runners found`);
            }
        }
        // Priority 3: Parse from description
        else if (play.result?.description) {
            const desc = play.result.description.toLowerCase();
            
            // Check for explicit mentions
            if (desc.includes('grand slam')) {
                rbi = 4;
            } else if (desc.includes('3-run') || desc.includes('three-run')) {
                rbi = 3;
            } else if (desc.includes('2-run') || desc.includes('two-run')) {
                rbi = 2;
            } else if (desc.includes('solo')) {
                rbi = 1;
            } else {
                // Count "scores" mentions
                const scoreMatches = desc.match(/scores?/gi);
                if (scoreMatches) {
                    // The batter scores too, so count should include them
                    rbi = Math.max(1, scoreMatches.length);
                }
            }
            this.log(`Parsed RBI from description: ${rbi}`);
        } else {
            this.log(`No RBI info found, defaulting to 1`);
        }
        
        // Set description based on RBI count
        switch(rbi) {
            case 1:
                rbiDescription = "Solo HR";
                break;
            case 2:
                rbiDescription = "2-run HR";
                break;
            case 3:
                rbiDescription = "3-run HR";
                break;
            case 4:
                rbiDescription = "Grand Slam!";
                break;
            default:
                rbiDescription = `${rbi}-run HR`;
        }
        
        return { rbi, rbiDescription };
    }

    // Add this helper method to count runners from description
    countRunnersFromDescription(description) {
        let count = 0;
        
        // Look for phrases like "scores", "score", etc.
        const scoreMatches = description.match(/(\w+)\s+scores?/gi);
        if (scoreMatches) {
            // Subtract 1 because the batter's name will be included
            count = scoreMatches.length - 1;
        }
        
        // Look for specific runner mentions
        if (description.includes('scores from third') || description.includes('scores from 3rd')) count++;
        if (description.includes('scores from second') || description.includes('scores from 2nd')) count++;
        if (description.includes('scores from first') || description.includes('scores from 1st')) count++;
        
        return Math.max(0, count);
    }

        async getHomeRunDetailsFromAlternativeAPI(playerId) {
        try {
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
            );
            
            if (response.data.stats && response.data.stats[0] && response.data.stats[0].splits) {
                // Look for the most recent game with home runs
                const recentGames = response.data.stats[0].splits
                    .filter(game => game.stat.homeRuns > 0)
                    .sort((a, b) => new Date(b.date) - new Date(a.date));
                
                if (recentGames.length > 0) {
                    const mostRecentHRGame = recentGames[0];
                    const gameId = mostRecentHRGame.game?.gamePk;
                    
                    if (gameId) {
                        try {
                            // Try playByPlay endpoint first
                            const gameDetailResponse = await axios.get(
                                `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
                            );
                            
                            const plays = gameDetailResponse.data.allPlays || [];
                            
                            // Find home runs by this player
                            for (const play of plays.reverse()) {
                                if (this.isHomeRunByPlayer(play, playerId)) {
                                    const distance = this.extractDistanceFromPlay(play);
                                    const rbiInfo = this.extractRBIInfo(play);
                                    
                                    return {
                                        distance: distance,
                                        rbi: rbiInfo.rbi,
                                        rbiDescription: rbiInfo.rbiDescription,
                                        gameId: gameId
                                    };
                                }
                            }
                        } catch (detailError) {
                            this.log(`Could not get detailed game data: ${detailError.message}`);
                        }
                    }
                    
                    // Fallback: details pending
                    return {
                        distance: "Not yet available",
                        rbi: "unknown",
                        rbiDescription: "HR (details pending)",
                        gameId: gameId
                    };
                }
            }
            
            return { distance: "Distance not available", rbi: 1, rbiDescription: "Solo HR" };
        } catch (error) {
            this.log(`Error in alternative HR details API: ${error.message}`);
            return { distance: "Distance not available", rbi: 1, rbiDescription: "Solo HR" };
        }
    }

    getRbiDescription(rbi) {
        if (rbi === 1) return "Solo HR";
        if (rbi === 2) return "2-run HR";
        if (rbi === 3) return "3-run HR";
        if (rbi === 4) return "Grand Slam!";
        return "Solo HR"; // Default fallback
    }

    async getHomeRunDetailsFromStatcast(playerId, gameId = null, gameHomeRunIndex = 1) {
        try {
            let url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=home%5C.run%7C&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfC=&hfSea=${this.currentSeason}%7C&hfSit=&player_type=batter&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=&game_date_lt=&hfInning=&hfRO=&team=&position=&hfOutfieldDirection=&hfInn=&min_pitches=0&min_results=0&min_pas=0&sort_col=game_date&player_event_sort=game_date&sort_order=desc&type=details&player_id=${playerId}`;
            
            if (gameId) {
                url += `&game_pk=${gameId}`;
            }
            
            const response = await axios.get(url);
            
            const rows = parse(response.data, {
                columns: true,
                skip_empty_lines: true
            });

            if (!Array.isArray(rows) || rows.length === 0) {
                return null;
            }
            
            let matchingHomeRunCount = 0;
            for (const row of rows) {
                if (row.events === 'home_run' &&
                    (!gameId || row.game_pk === gameId.toString())) {
                    matchingHomeRunCount++;
                    if (matchingHomeRunCount < gameHomeRunIndex) {
                        continue;
                    }

                    const distance = row.hit_distance_sc && row.hit_distance_sc !== 'null'
                        ? `${Math.round(parseFloat(row.hit_distance_sc))} ft`
                        : 'Distance not available';
                    const rbi = parseInt(row.rbi, 10) || 1;
                    const rbiDescription = this.getRbiDescription(rbi);
                    
                    return { distance, rbi, rbiDescription };
                }
            }
            
            return null;
        } catch (error) {
            this.log(`Error fetching Statcast data: ${error.message}`);
            return null;
        }
    }

    async checkForNewHomeRuns() {
        if (this.checkInProgress) {
            this.log('Home run check already in progress; reusing the active run');
            return this.checkInProgress;
        }

        this.checkInProgress = (async () => {
            this.lastCheckTime = new Date();
            this.log(`Starting home run check at ${this.lastCheckTime.toISOString()}`);
            
            let alertsSent = 0;
            
            for (const [playerId, playerData] of Object.entries(this.players)) {
                try {
                    this.ensurePlayerDeliveryState(playerData);
                    const currentHomeRuns = await this.getPlayerHomeRuns(playerId);
                    
                    this.log(`${playerData.name}: Current=${currentHomeRuns}, Last=${playerData.lastCheckedHR}`);
                    
                    if (currentHomeRuns > playerData.lastCheckedHR) {
                        const newHomeRuns = currentHomeRuns - playerData.lastCheckedHR;
                        this.log(`🚨 NEW HOME RUN DETECTED! ${playerData.name} went from ${playerData.lastCheckedHR} to ${currentHomeRuns} (+${newHomeRuns})`);
                        
                        const allHomeRunDetails = this.sortHomeRunDetailsChronologically(
                            await this.getRecentHomeRunDetails(playerId, currentHomeRuns)
                        );
                        
                        const todayStr = new Date().toISOString().slice(0, 10);

                        const unseenHomeRuns = [];
                        for (let index = 0; index < allHomeRunDetails.length; index++) {
                            const hrDetail = allHomeRunDetails[index];
                            const hrId = this.buildHomeRunId(hrDetail);

                            // Skip HRs already being processed by a pending notification
                            if (this.pendingNotifications.has(hrId)) {
                                continue;
                            }

                            const pendingChannelIds = this.getPendingChannelIdsForHomeRun(playerData, hrId);
                            if (pendingChannelIds.length > 0) {
                                // Skip HRs from games not played today to avoid replaying old HRs on state reset
                                if (hrDetail.gameDate && hrDetail.gameDate !== todayStr) {
                                    this.log(`${playerData.name}: Skipping old HR ${hrId} from ${hrDetail.gameDate} (not today); marking as sent`);
                                    this.markHomeRunSentToChannels(playerData, hrId, pendingChannelIds);
                                    continue;
                                }

                                unseenHomeRuns.push({
                                    hrDetail,
                                    hrId,
                                    pendingChannelIds,
                                    totalHomeRuns: index + 1
                                });
                            }
                        }

                        const dispatchableHomeRuns = unseenHomeRuns.filter(({ hrDetail }) => !this.isFallbackHomeRunDetail(hrDetail));
                        const fallbackHomeRunCount = unseenHomeRuns.length - dispatchableHomeRuns.length;

                        this.log(`Found ${dispatchableHomeRuns.length} dispatchable new home runs out of ${allHomeRunDetails.length} total for ${playerData.name}`);
                        if (fallbackHomeRunCount > 0) {
                            this.log(`${playerData.name}: ${fallbackHomeRunCount} home run(s) are still missing game context; leaving them pending for the next check`);
                        }

                        for (const { hrDetail, hrId, pendingChannelIds, totalHomeRuns } of dispatchableHomeRuns) {
                            // Mark as pending so subsequent check cycles don't re-dispatch
                            this.pendingNotifications.add(hrId);

                            // Fire off the wait-for-statcast-then-send flow (non-blocking)
                            this.waitForStatcastAndSend(playerId, playerData, totalHomeRuns, hrDetail, hrId, pendingChannelIds)
                                .then(sent => {
                                    if (sent) alertsSent++;
                                })
                                .catch(err => this.log(`Notification error for ${playerData.name} HR ${hrId}: ${err.message}`))
                                .finally(() => {
                                    this.pendingNotifications.delete(hrId);
                                    this.saveState();
                                });
                        }

                        this.players[playerId].lastCheckedHR = Math.min(
                            currentHomeRuns,
                            this.countContiguousDeliveredHomeRuns(playerData, allHomeRunDetails)
                        );
                        if (this.players[playerId].lastCheckedHR < currentHomeRuns) {
                            this.log(`${playerData.name}: only fully delivered ${this.players[playerId].lastCheckedHR}/${currentHomeRuns} tracked home run(s); leaving the remainder pending for retry`);
                        }
                        this.saveState();
                    }
                } catch (error) {
                    this.log(`Error checking ${playerData.name}: ${error.message}`);
                    console.error(`Full error for ${playerData.name}:`, error);
                }
            }
            
            this.saveState();
            this.log(`Home run check completed. Alerts sent: ${alertsSent}`);
        })();

        try {
            await this.checkInProgress;
        } finally {
            this.checkInProgress = null;
        }
    }

    buildInitialAlertFields(playerData, totalHomeRuns, hrType, distance) {
        const compactDistance = String(distance).replace(/(\d+)\s*ft/i, '$1ft');

        return [
            { name: 'Type', value: hrType, inline: true },
            { name: 'Distance', value: compactDistance, inline: true },
            { name: 'Player', value: `${playerData.name} (#${playerData.number})`, inline: true },
            { name: 'Team', value: playerData.team, inline: true },
            { name: 'Season Total', value: `${totalHomeRuns}`, inline: false }
        ];
    }

    buildCombinedFollowUpFields(totalDongs, pitcherDisplay, statcastData = null, analysisResult = null) {
        const fields = [];

        if (statcastData) {
            if (statcastData.launch_speed) {
                fields.push({ name: 'Exit Velocity', value: `${statcastData.launch_speed.toFixed(1)} mph`, inline: true });
            }
            if (statcastData.launch_angle != null) {
                fields.push({ name: 'Launch Angle', value: `${Number(statcastData.launch_angle).toFixed(0)}\u00b0`, inline: true });
            }
            if (analysisResult?.spray_direction) {
                fields.push({ name: 'Spray Direction', value: analysisResult.spray_direction, inline: true });
            }
        }

        if (analysisResult) {
            const homeParkDetail = analysisResult.park_details?.find(p => p.team === statcastData?.home_team);
            if (homeParkDetail) {
                fields.push({ name: 'Wall Height', value: `${homeParkDetail.fence_height} ft`, inline: true });
                fields.push({ name: 'Wall Distance', value: `${Math.round(homeParkDetail.wall_distance)} ft`, inline: true });
            }
        }

        fields.push({ name: 'Parks Cleared', value: `${totalDongs}/30`, inline: true });
        fields.push({ name: 'Off Pitcher', value: pitcherDisplay || 'N/A', inline: true });

        return fields;
    }

    getHomeRunAlertPresentation(playerData, details, statcastData = null) {
        const primaryDetails = Array.isArray(details) ? details[0] : details;
        const hrType =
            statcastData?.rbi_description ||
            primaryDetails?.rbiDescription ||
            primaryDetails?.rbi_description ||
            'Solo HR';
        const distanceText = Number.isFinite(Number(statcastData?.hit_distance_sc))
            ? `${Math.round(statcastData.hit_distance_sc)} ft`
            : (primaryDetails?.distance || 'Distance not available');

        let isNuke = false;
        if (distanceText && distanceText !== 'Not yet available' && distanceText !== 'Distance not available') {
            const match = String(distanceText).match(/(\d+)/);
            if (match) {
                const distanceNum = parseInt(match[1], 10);
                isNuke = distanceNum > 440;
            }
        }

        const titleText = hrType === 'Grand Slam!'
            ? `${playerData.name.toUpperCase()} GRAND SLAM!`
            : `${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}!`;
        const description = isNuke
            ? `${playerData.name} just hit a fucking NUKE!`
            : `${playerData.name} just hit a home run!`;

        return {
            primaryDetails,
            hrType,
            distanceText,
            titleText,
            description
        };
    }

    getAnalysisEmbedColor(totalDongs) {
        if (totalDongs >= 25) {
            return '#FF2222';
        }

        if (totalDongs >= 15) {
            return '#FFD700';
        }

        return '#888888';
    }

    buildAlertMessageOptions(playerId, playerData, totalHomeRuns, details, options = {}) {
        const {
            statcastData = null,
            analysisResult = null,
            footerText = null
        } = options;
        const {
            primaryDetails,
            hrType,
            distanceText,
            titleText,
            description
        } = this.getHomeRunAlertPresentation(playerData, details, statcastData);

        const embed = new Discord.EmbedBuilder()
            .setTitle(titleText)
            .setDescription(description)
            .addFields(this.buildInitialAlertFields(
                playerData,
                totalHomeRuns,
                hrType,
                distanceText
            ))
            .setColor(analysisResult ? this.getAnalysisEmbedColor(analysisResult.total_dongs) : '#132448')
            .setTimestamp();

        if (analysisResult) {
            const pitcherDisplay = (statcastData?.pitcher_name && statcastData.pitcher_name !== 'Unknown')
                ? (statcastData.pitcher_team ? `${statcastData.pitcher_name} (${statcastData.pitcher_team})` : statcastData.pitcher_name)
                : 'N/A';

            embed.addFields(this.buildCombinedFollowUpFields(
                analysisResult.total_dongs,
                pitcherDisplay,
                statcastData,
                analysisResult
            ));

            // List parks where it would NOT be a HR (if 10 or fewer)
            if (analysisResult.parks_not_cleared?.length > 0 && analysisResult.parks_not_cleared.length <= 10) {
                embed.addFields({
                    name: `Not a HR in (${analysisResult.parks_not_cleared.length})`,
                    value: analysisResult.parks_not_cleared.join(', '),
                    inline: true
                });
            }
        }

        if (footerText) {
            embed.setFooter({ text: footerText });
        } else if (primaryDetails?.rbi === 'unknown') {
            embed.setFooter({ text: 'Details may update soonâ€”check back!' });
        }

        const alertThumbnail = this.getPlayerHeadshotUrlById(playerId) || this.getPlayerHeadshotUrl(playerData.name);
        if (alertThumbnail) {
            embed.setThumbnail(alertThumbnail);
        }

        const messageOptions = { embeds: [embed] };
        if (analysisResult?.image_path && fs.existsSync(analysisResult.image_path)) {
            const attachment = new Discord.AttachmentBuilder(analysisResult.image_path, { name: 'ballpark_overlay.png' });
            embed.setImage('attachment://ballpark_overlay.png');
            messageOptions.files = [attachment];
        }

        return messageOptions;
    }

    async sendToConfiguredChannels(messageOptions, logLabel, targetChannelIds = this.channelIds) {
        const successChannelIds = [];
        const failedChannelIds = [];
        for (const channelId of targetChannelIds) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                await channel.send(messageOptions);
                this.log(`Sent ${logLabel} to channel ${channelId}`);
                successChannelIds.push(channelId);
            } catch (error) {
                this.log(`Error sending ${logLabel} to channel ${channelId}: ${error.message}`);
                console.error(`Full error for channel ${channelId}:`, error);
                failedChannelIds.push(channelId);
            }
        }

        return { successChannelIds, failedChannelIds };
    }

    cleanupAnalysisImage(imagePath) {
        if (!imagePath) {
            return;
        }

        try {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        } catch (cleanupError) {
            this.log(`Image cleanup error: ${cleanupError.message}`);
        }
    }

    buildCompactStatcastFields(statcastData, analysisResult, wallHeight, wallDist, totalDongs, pitcherDisplay) {
        const statcastDistance = Number.isFinite(Number(statcastData.hit_distance_sc))
            ? `${Math.round(Number(statcastData.hit_distance_sc))} ft`
            : 'N/A';

        return [
            { name: 'Type', value: statcastData.rbi_description || 'HR', inline: true },
            { name: 'Distance', value: statcastDistance, inline: true },
            { name: 'Exit Velocity', value: `${statcastData.launch_speed.toFixed(1)} mph`, inline: true },
            { name: 'Launch Angle', value: `${statcastData.launch_angle.toFixed(0)}\u00b0`, inline: true },
            { name: 'Spray Direction', value: analysisResult.spray_direction, inline: true },
            { name: 'Home Team', value: statcastData.home_team || 'N/A', inline: true },
            { name: 'Wall Height', value: wallHeight, inline: true },
            { name: 'Wall Distance', value: wallDist, inline: true },
            { name: 'Parks Cleared', value: `${totalDongs}/30`, inline: true },
            { name: 'Off Pitcher', value: pitcherDisplay || 'N/A', inline: true }
        ];
    }

    // ── Statcast Data Methods ────────────────────────────────

    async getStatcastDataForHR(playerId, hrDetail) {
        // Primary: use MLB playByPlay API (reliable)
        try {
            const gameId = hrDetail?.gameId;
            if (!gameId) return null;

            const pbpResp = await axios.get(
                `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
            );
            const plays = pbpResp.data.allPlays || [];

            let hitData = null;
            let pitcherName = 'Unknown';
            let plateZ = 3.5;
            const matchingHomeRuns = plays.filter(play =>
                play.result?.event === 'Home Run' &&
                play.matchup?.batter?.id?.toString() === playerId
            );

            let selectedPlay = null;
            if (Number.isInteger(hrDetail?.atBatIndex)) {
                selectedPlay = matchingHomeRuns.find(play => play.about?.atBatIndex === hrDetail.atBatIndex) || null;
            }

            if (!selectedPlay && Number.isInteger(hrDetail?.gameHomeRunIndex)) {
                selectedPlay = matchingHomeRuns[hrDetail.gameHomeRunIndex - 1] || null;
            }

            if (!selectedPlay) {
                selectedPlay = matchingHomeRuns[0] || null;
            }

            if (!selectedPlay) {
                return null;
            }

            const rbiInfo = this.extractRBIInfo(selectedPlay);
            pitcherName = selectedPlay.matchup?.pitcher?.fullName || 'Unknown';
            for (const evt of (selectedPlay.playEvents || [])) {
                if (evt.hitData) {
                    hitData = evt.hitData;
                }
                if (evt.pitchData?.coordinates?.pZ) {
                    plateZ = evt.pitchData.coordinates.pZ;
                }
            }

            if (!hitData || !hitData.launchSpeed || !hitData.coordinates) return null;

            // Get home/away teams from boxscore
            let homeTeam = '';
            let awayTeam = '';
            try {
                const boxResp = await axios.get(
                    `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`
                );
                homeTeam = boxResp.data.teams.home.team.abbreviation || '';
                awayTeam = boxResp.data.teams.away.team.abbreviation || '';
            } catch (e) {
                this.log(`Could not get boxscore for teams: ${e.message}`);
            }

            const playerTeamAbbr = this.players[playerId]?.team || '';
            const pitcherTeam = (playerTeamAbbr === homeTeam) ? awayTeam : homeTeam;

            return {
                launch_speed: hitData.launchSpeed,
                launch_angle: hitData.launchAngle,
                hit_distance_sc: hitData.totalDistance,
                hc_x: hitData.coordinates.coordX,
                hc_y: hitData.coordinates.coordY,
                plate_z: plateZ,
                home_team: homeTeam,
                pitcher_name: pitcherName,
                pitcher_team: pitcherTeam,
                rbi: rbiInfo.rbi,
                rbi_description: rbiInfo.rbiDescription
            };
        } catch (error) {
            this.log(`Error fetching Statcast data from playByPlay: ${error.message}`);
            return null;
        }
    }

    runHRAnalysis(statcastData, playerName, playerId = null) {
        return new Promise((resolve) => {
            const scriptPath = path.join(__dirname, 'scripts', 'hr_analysis.py');
            const fencesPath = path.join(__dirname, 'data', 'fences.json');
            const stadiumPathsFile = path.join(__dirname, 'data', 'stadium_paths.json');
            const timestamp = Date.now();
            const outputImage = path.join(__dirname, 'tmp', `hr_overlay_${timestamp}.png`);

            // Ensure tmp directory exists
            const tmpDir = path.join(__dirname, 'tmp');
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }

            const args = [
                scriptPath,
                '--launch_speed', String(statcastData.launch_speed),
                '--launch_angle', String(statcastData.launch_angle),
                '--hit_distance', String(statcastData.hit_distance_sc),
                '--hc_x', String(statcastData.hc_x),
                '--hc_y', String(statcastData.hc_y),
                '--plate_z', String(statcastData.plate_z),
                '--home_team', statcastData.home_team,
                '--player_name', playerName,
                '--player_id', playerId ? String(playerId) : '',
                '--pitcher_name', statcastData.pitcher_name || 'Unknown',
                '--output_image', outputImage,
                '--fences_path', fencesPath,
                '--stadium_paths', stadiumPathsFile
            ];

            // Use venv Python if available, fall back to system python
            const venvPython = path.join(__dirname, 'venv', 'bin', 'python');
            const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python';

            execFile(pythonCmd, args, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    this.log(`HR analysis error: ${error.message}`);
                    if (stderr) this.log(`HR analysis stderr: ${stderr}`);
                    resolve(null);
                    return;
                }

                try {
                    const result = JSON.parse(stdout.trim());
                    resolve(result);
                } catch (parseError) {
                    this.log(`HR analysis JSON parse error: ${parseError.message}`);
                    this.log(`Raw stdout: ${stdout}`);
                    resolve(null);
                }
            });
        });
    }

    async waitForStatcastAndSend(playerId, playerData, totalHRs, hrDetail, hrId, pendingChannelIds) {
        const POLL_INTERVAL = 30000;  // 30 seconds between attempts
        const MAX_WAIT = 600000;      // 10 minutes total
        const gameId = hrDetail?.gameId;

        this.log(`Waiting for Statcast data before sending ${playerData.name} HR ${hrId} (up to 10 min)...`);

        let statcastData = null;
        let analysisResult = null;
        const startTime = Date.now();

        // Poll for Statcast data up to 10 minutes
        while (Date.now() - startTime < MAX_WAIT) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

            if (!gameId) break;

            try {
                statcastData = await this.getStatcastDataForHR(playerId, hrDetail);
                if (!statcastData) {
                    this.log(`Statcast not yet available for ${playerData.name} HR ${hrId} (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
                    continue;
                }

                this.log(`Got Statcast for ${playerData.name}: EV=${statcastData.launch_speed}, LA=${statcastData.launch_angle}, Dist=${statcastData.hit_distance_sc}`);

                analysisResult = await this.runHRAnalysis(statcastData, playerData.name, playerId);
                if (!analysisResult || !analysisResult.success) {
                    this.log(`HR analysis failed for ${playerData.name}, will retry...`);
                    statcastData = null;
                    analysisResult = null;
                    continue;
                }

                this.log(`HR analysis complete for ${playerData.name}: ${analysisResult.total_dongs}/30 parks`);
                break; // Got everything we need
            } catch (error) {
                this.log(`Statcast poll error for ${playerData.name}: ${error.message}`);
            }
        }

        // Build and send the single combined message
        const messageOptions = this.buildAlertMessageOptions(
            playerId,
            playerData,
            totalHRs,
            hrDetail,
            {
                statcastData,
                analysisResult,
                footerText: (!statcastData) ? 'Statcast data was not available' : null
            }
        );

        const deliveryResult = await this.sendToConfiguredChannels(messageOptions, 'home-run-alert', pendingChannelIds);

        if (deliveryResult.successChannelIds.length === 0) {
            this.log(`Alert failed for ${playerData.name} HR ${hrId}; leaving pending`);
            return false;
        }

        this.markHomeRunSentToChannels(playerData, hrId, deliveryResult.successChannelIds);

        // Store parks cleared count
        if (analysisResult && Number.isFinite(analysisResult.total_dongs)) {
            playerData.homeRunParks[hrId] = analysisResult.total_dongs;
        }

        // Clean up temp image
        if (analysisResult?.image_path) {
            this.cleanupAnalysisImage(analysisResult.image_path);
        }

        const hadStatcast = statcastData ? 'with Statcast' : 'basic (no Statcast)';
        this.log(`Sent combined alert ${hadStatcast} for ${playerData.name} HR ${hrId} to ${deliveryResult.successChannelIds.length} channel(s)`);
        return true;
    }

    startMonitoring() {
        cron.schedule('*/4 * * * *', async () => {
            try {
                await this.checkForNewHomeRuns();
            } catch (error) {
                this.log(`Scheduled check failed: ${error.message}`);
            }
        });
        
        this.log('Started monitoring for home runs from your selected star players!');
        this.log('Checking every 4 minutes year-round so Opening Day and late-season games are not missed');
    }

    async handleCommand(message) {
        const content = message.content.trim().toLowerCase();
        if (!content.startsWith('!')) {
            return;
        }

        const parts = content.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        if (command === '!judge') {
            await this.sendPlayerStats('592450', message);
            return;
        }

        if (command === '!jazz') {
            await this.sendPlayerStats('665862', message);
            return;
        }

        if (command === '!soto') {
            await this.sendPlayerStats('665742', message);
            return;
        }

        if (command === '!ohtani') {
            await this.sendPlayerStats('660271', message);
            return;
        }

        if (command === '!schwarber') {
            await this.sendPlayerStats('656941', message);
            return;
        }

        if (command === '!harper') {
            await this.sendPlayerStats('547180', message);
            return;
        }

        if (command === '!gunnar') {
            await this.sendPlayerStats('683002', message);
            return;
        }

        if (command === '!trout') {
            await this.sendPlayerStats('545361', message);
            return;
        }

        if (command === '!players') {
            await this.sendTrackedPlayers(message);
            return;
        }

        if (command === '!hrstats') {
            await this.sendAllHomeRunStats(message);
            return;
        }

        if (command === '!parkstats') {
            const playerName = args.join(' ') || null;
            await this.sendParksBreakdown(message, playerName);
            return;
        }

        const adminCommands = new Set([
            '!testhr',
            '!debug',
            '!forcecheck',
            '!reset',
            '!testdetails',
            '!testrbi',
            '!testdistance',
            '!debuggame',
            '!testgame',
            '!findrecent',
            '!teststatcast'
        ]);

        if (adminCommands.has(command) && !(await this.ensureAdmin(message))) {
            return;
        }

        if (command === '!testhr') {
            await this.sendTestHomeRunAlert(message);
            return;
        }

        if (command === '!debug') {
            await this.sendDebugInfo(message);
            return;
        }

        if (command === '!forcecheck') {
            await message.reply('Running manual home run check...');
            await this.checkForNewHomeRuns();
            await message.reply('Manual check completed! Check console logs for details.');
            return;
        }

        if (command === '!reset') {
            const playerName = args.join(' ');
            if (!playerName) {
                await message.reply('Usage: !reset [playerName]');
                return;
            }

            await this.resetPlayerHR(playerName, message);
            return;
        }

        if (command === '!testdetails') {
            const playerName = args.join(' ');
            if (!playerName) {
                await message.reply('Usage: !testdetails [playerName]');
                return;
            }

            await this.testHomeRunDetails(playerName, message);
            return;
        }

        if (command === '!testrbi') {
            const playerName = args.join(' ');
            if (!playerName) {
                await message.reply('Usage: !testrbi [playerName]');
                return;
            }

            await this.testRBIDetection(playerName, message);
            return;
        }

        if (command === '!testdistance') {
            const playerName = args.join(' ');
            if (!playerName) {
                await message.reply('Usage: !testdistance [playerName]');
                return;
            }

            await this.testDistanceData(playerName, message);
            return;
        }

        if (command === '!debuggame') {
            if (args.length < 2) {
                await message.reply('Usage: !debuggame [gameId] [playerName]');
                return;
            }

            const gameId = args[0];
            const playerName = args.slice(1).join(' ');
            await this.debugSpecificGame(gameId, playerName, message);
            return;
        }

        if (command === '!testgame') {
            if (args.length < 2) {
                await message.reply('Usage: !testgame [gameId] [playerName]');
                return;
            }

            const gameId = args[0];
            const playerName = args.slice(1).join(' ');
            await this.testSpecificGame(gameId, playerName, message);
            return;
        }

        if (command === '!findrecent') {
            await this.findRecentHomeRunsWithDistance(message);
            return;
        }

        if (command === '!teststatcast') {
            await this.testEnhancedStatcast(message);
        }
    }

    async sendDebugInfo(message) {
        try {
            const debugInfo = [];
            debugInfo.push(`**Bot Status:**`);
            debugInfo.push(`- Last check: ${this.lastCheckTime ? this.lastCheckTime.toISOString() : 'Never'}`);
            debugInfo.push(`- Current season: ${this.currentSeason}`);
            debugInfo.push(`- Debugging enabled: ${this.debugging}`);
            debugInfo.push(`- Alert channels: ${this.channelIds.length} (${this.channelIds.join(', ')})`);
            debugInfo.push(`\n**Player Tracking:**`);
            
            for (const [playerId, playerData] of Object.entries(this.players)) {
                const currentHR = await this.getPlayerHomeRuns(playerId);
                debugInfo.push(`- ${playerData.name}: Tracked=${playerData.lastCheckedHR}, Current=${currentHR}`);
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle('🔧 Debug Information')
                .setDescription(debugInfo.join('\n'))
                .setColor('#FFA500')
                .setTimestamp();

            await message.reply({ embeds: [embed] });
        } catch (error) {
            this.log(`Error in debug command: ${error.message}`);
            await message.reply('Error getting debug info!');
        }
    }

    async resetPlayerHR(playerName, message) {
        try {
            const playerId = this.findPlayerIdByName(playerName);
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const oldValue = this.players[playerId].lastCheckedHR;
            this.players[playerId].lastCheckedHR = 0;
            this.players[playerId].sentHomeRuns.clear();
            this.players[playerId].sentHomeRunsByChannel = {};
            this.ensurePlayerDeliveryState(this.players[playerId]);
            this.saveState();
            this.log(`Reset ${this.players[playerId].name} HR count from ${oldValue} to 0 and cleared sent home runs (manual reset)`);
            
            await message.reply(`Reset ${this.players[playerId].name}'s tracked HR count from ${oldValue} to 0 and cleared sent home runs. Next check will detect any current HRs as new.`);
        } catch (error) {
            this.log(`Error in reset command: ${error.message}`);
            await message.reply('Error resetting player HR count!');
        }
    }

    async testHomeRunDetails(playerName, message) {
        try {
            const playerId = this.findPlayerIdByName(playerName);
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const playerData = this.players[playerId];
            await message.reply(`🔍 Testing home run details fetching for ${playerData.name}...`);
            
            // Test primary method with detailed debugging
            await message.reply(`📊 Testing primary method (game feed API)...`);
            const primaryDetails = await this.getRecentHomeRunDetails(playerId, 1);
            const firstDetail = Array.isArray(primaryDetails) ? primaryDetails[0] : primaryDetails;
            await message.reply(`Primary method results for ${playerData.name}:\nDistance: ${firstDetail.distance}\nRBI: ${firstDetail.rbi}\nType: ${firstDetail.rbiDescription}`);
            
            // Test alternative method
            await message.reply(`📊 Testing alternative method (game log API)...`);
            const alternativeDetails = await this.getHomeRunDetailsFromAlternativeAPI(playerId);
            await message.reply(`Alternative method results for ${playerData.name}:\nDistance: ${alternativeDetails.distance}\nRBI: ${alternativeDetails.rbi}\nType: ${alternativeDetails.rbiDescription}`);
            
            // Test current season stats to see if player has any home runs
            await message.reply(`📊 Checking current season stats...`);
            const currentHR = await this.getPlayerHomeRuns(playerId);
            await message.reply(`Current season home runs for ${playerData.name}: ${currentHR}`);
            
            // Test raw API response for debugging
            await this.testRawAPIResponse(playerId, message);
            
        } catch (error) {
            this.log(`Error in test details command: ${error.message}`);
            await message.reply('Error testing home run details!');
        }
    }

    async testRawAPIResponse(playerId, message) {
        try {
            const playerData = this.players[playerId];
            await message.reply(`🔍 Testing raw API responses for ${playerData.name}...`);
            
            // Test game log API
            try {
                const gamesResponse = await axios.get(
                    `https://statsapi.mlb.com/api/v1/people/${playerId}/gameLog?season=${this.currentSeason}&gameType=R&limit=5`
                );
                
                await message.reply(`🔗 API URL tested: https://statsapi.mlb.com/api/v1/people/${playerId}/gameLog?season=${this.currentSeason}&gameType=R&limit=5`);
                
                if (gamesResponse.data.dates && gamesResponse.data.dates.length > 0) {
                    const recentGames = gamesResponse.data.dates.slice(0, 2); // Just check first 2 dates
                    await message.reply(`📊 Found ${recentGames.length} recent game dates for ${playerData.name}`);
                    
                    for (let i = 0; i < recentGames.length; i++) {
                        const date = recentGames[i];
                        await message.reply(`📅 Date ${i+1}: ${date.date} - ${date.games.length} games`);
                        
                        if (date.games.length > 0) {
                            const game = date.games[0]; // Check first game of each date
                            await message.reply(`🎮 Game ID: ${game.gameId}, Home: ${game.teams.home.team.name}, Away: ${game.teams.away.team.name}`);
                            
                            // Try to get game feed data
                            try {
                                const gameFeedResponse = await axios.get(
                                    `https://statsapi.mlb.com/api/v1/game/${game.gameId}/feed/live`
                                );
                                
                                if (gameFeedResponse.data.liveData && gameFeedResponse.data.liveData.plays) {
                                    const allPlays = gameFeedResponse.data.liveData.plays.allPlays;
                                    await message.reply(`📋 Game has ${allPlays.length} total plays`);
                                    
                                    // Look for any home runs in this game
                                    const homeRunPlays = allPlays.filter(play => 
                                        play.result && 
                                        (play.result.event === 'Home Run' || 
                                         play.result.eventType === 'home_run' ||
                                         (play.result.description && play.result.description.toLowerCase().includes('home run')))
                                    );
                                    
                                    await message.reply(`⚾ Found ${homeRunPlays.length} home run plays in this game`);
                                    
                                    if (homeRunPlays.length > 0) {
                                        const samplePlay = homeRunPlays[0];
                                        await message.reply(`📊 Sample home run play structure:`);
                                        await message.reply(`Event: ${samplePlay.result?.event || 'N/A'}`);
                                        await message.reply(`EventType: ${samplePlay.result?.eventType || 'N/A'}`);
                                        await message.reply(`Description: ${samplePlay.result?.description || 'N/A'}`);
                                        await message.reply(`RBI: ${samplePlay.result?.rbi || 'N/A'}`);
                                        
                                        if (samplePlay.hitData) {
                                            await message.reply(`HitData keys: ${Object.keys(samplePlay.hitData).join(', ')}`);
                                            if (samplePlay.hitData.totalDistance) {
                                                await message.reply(`TotalDistance: ${samplePlay.hitData.totalDistance}`);
                                            }
                                            if (samplePlay.hitData.distance) {
                                                await message.reply(`Distance: ${samplePlay.hitData.distance}`);
                                            }
                                        }
                                    }
                                } else {
                                    await message.reply(`❌ No live data available for this game`);
                                }
                            } catch (gameFeedError) {
                                await message.reply(`❌ Error fetching game feed: ${gameFeedError.message}`);
                            }
                        }
                    }
                } else {
                    await message.reply(`❌ No recent games found for ${playerData.name}`);
                }
            } catch (gamesError) {
                await message.reply(`❌ Error fetching game log: ${gamesError.message}`);
            }
            
            // Test the alternative API that's working
            await message.reply(`🔍 Testing the working alternative API...`);
            try {
                const altResponse = await axios.get(
                    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
                );
                
                await message.reply(`✅ Alternative API successful! Found ${altResponse.data.stats ? altResponse.data.stats.length : 0} stat entries`);
                
                if (altResponse.data.stats && altResponse.data.stats[0] && altResponse.data.stats[0].splits) {
                    const gamesWithHR = altResponse.data.stats[0].splits.filter(game => game.stat.homeRuns > 0);
                    await message.reply(`⚾ Found ${gamesWithHR.length} games with home runs`);
                    
                    if (gamesWithHR.length > 0) {
                        const mostRecent = gamesWithHR[0];
                        await message.reply(`📊 Most recent HR game: ${mostRecent.date}`);
                        await message.reply(`Game ID: ${mostRecent.gameId || 'Not available'}`);
                        await message.reply(`Home Runs: ${mostRecent.stat.homeRuns}`);
                        await message.reply(`RBI: ${mostRecent.stat.rbi}`);
                        
                        // Debug the game object structure
                        await message.reply(`🔍 Game object keys: ${Object.keys(mostRecent).join(', ')}`);
                        if (mostRecent.game) {
                            await message.reply(`📊 Game sub-object keys: ${Object.keys(mostRecent.game).join(', ')}`);
                        }
                        
                        // Try to get detailed game data for this specific game
                        const gameId = mostRecent.gameId || mostRecent.game?.gameId;
                        if (gameId) {
                            await message.reply(`🔍 Attempting to get detailed game data for ${gameId}...`);
                            try {
                                const gameDetailResponse = await axios.get(
                                    `https://statsapi.mlb.com/api/v1/game/${gameId}/feed/live`
                                );
                            
                            if (gameDetailResponse.data.liveData && gameDetailResponse.data.liveData.plays) {
                                const allPlays = gameDetailResponse.data.liveData.plays.allPlays;
                                const homeRunPlays = allPlays.filter(play => 
                                    play.result && 
                                    (play.result.event === 'Home Run' || 
                                     play.result.eventType === 'home_run' ||
                                     (play.result.description && play.result.description.toLowerCase().includes('home run'))) &&
                                    play.matchup && play.matchup.batter && 
                                    play.matchup.batter.id.toString() === playerId
                                );
                                
                                await message.reply(`📋 Found ${homeRunPlays.length} home runs by ${playerData.name} in this game`);
                                
                                if (homeRunPlays.length > 0) {
                                    const hrPlay = homeRunPlays[0];
                                    await message.reply(`📊 Home run play details:`);
                                    await message.reply(`Event: ${hrPlay.result?.event || 'N/A'}`);
                                    await message.reply(`Description: ${hrPlay.result?.description || 'N/A'}`);
                                    await message.reply(`RBI: ${hrPlay.result?.rbi || 'N/A'}`);
                                    
                                    if (hrPlay.hitData) {
                                        await message.reply(`HitData available: ${Object.keys(hrPlay.hitData).join(', ')}`);
                                        if (hrPlay.hitData.totalDistance) {
                                            await message.reply(`✅ TotalDistance: ${hrPlay.hitData.totalDistance} ft`);
                                        }
                                        if (hrPlay.hitData.distance) {
                                            await message.reply(`✅ Distance: ${hrPlay.hitData.distance} ft`);
                                        }
                                    } else {
                                        await message.reply(`❌ No hitData available for this play`);
                                    }
                                }
                            } else {
                                await message.reply(`❌ No live data available for game ${mostRecent.gameId}`);
                            }
                        } catch (gameDetailError) {
                            await message.reply(`❌ Error fetching game details: ${gameDetailError.message}`);
                        }
                    } else {
                        await message.reply(`❌ No valid game ID found for detailed data`);
                    }
                }
                }
            } catch (altError) {
                await message.reply(`❌ Error with alternative API: ${altError.message}`);
            }
            
        } catch (error) {
            this.log(`Error in test raw API response: ${error.message}`);
            await message.reply('Error testing raw API response!');
        }
    }

    async testRBIDetection(playerName, message) {
        try {
            const playerId = Object.keys(this.players).find(id => 
                this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
            );
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const playerData = this.players[playerId];
            await message.reply(`🔍 Testing RBI detection for ${playerData.name}...`);
            
            // Get current season stats first
            const stats = await this.getPlayerStats(playerId);
            if (stats) {
                await message.reply(`📊 ${playerData.name} season stats:\nHR: ${stats.homeRuns || 0}\nRBI: ${stats.rbi || 0}\nAVG: ${stats.avg || 'N/A'}`);
            }
            
            // Try to get recent game-by-game RBI data
            try {
                const response = await axios.get(
                    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
                );
                
                if (response.data.stats && response.data.stats[0] && response.data.stats[0].splits) {
                    const games = response.data.stats[0].splits
                        .filter(game => game.stat.homeRuns > 0) // Only games with home runs
                        .sort((a, b) => new Date(b.date) - new Date(a.date))
                        .slice(0, 5); // Last 5 games with HRs
                    
                    if (games.length > 0) {
                        await message.reply(`⚾ Found ${games.length} recent games with home runs:`);
                        
                        for (const game of games) {
                            const rbi = game.stat.rbi || 0;
                            const hr = game.stat.homeRuns || 0;
                            const rbiDescription = this.getRbiDescription(rbi);
                            
                            await message.reply(`📅 ${game.date}: ${hr} HR, ${rbi} RBI (${rbiDescription})`);
                        }
                        
                        // Test the most recent home run game
                        const mostRecent = games[0];
                        await message.reply(`🔍 Testing most recent HR game (${mostRecent.date}):`);
                        await message.reply(`Game ID: ${mostRecent.gameId}`);
                        await message.reply(`Home Runs: ${mostRecent.stat.homeRuns}`);
                        await message.reply(`RBI: ${mostRecent.stat.rbi}`);
                        await message.reply(`RBI Description: ${this.getRbiDescription(mostRecent.stat.rbi)}`);
                        
                    } else {
                        await message.reply(`❌ No games with home runs found for ${playerData.name} this season`);
                    }
                } else {
                    await message.reply(`❌ No game log data available for ${playerData.name}`);
                }
            } catch (error) {
                await message.reply(`❌ Error fetching game log: ${error.message}`);
            }
            
        } catch (error) {
            this.log(`Error in test RBI detection: ${error.message}`);
            await message.reply('Error testing RBI detection!');
        }
    }

    async testDistanceData(playerName, message) {
        try {
            const playerId = Object.keys(this.players).find(id => 
                this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
            );
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const playerData = this.players[playerId];
            await message.reply(`🔍 Testing distance data for ${playerData.name}...`);
            
            // Get recent home run game
            try {
                const response = await axios.get(
                    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
                );
                
                if (response.data.stats && response.data.stats[0] && response.data.stats[0].splits) {
                    const gamesWithHR = response.data.stats[0].splits
                        .filter(game => game.stat.homeRuns > 0)
                        .sort((a, b) => new Date(b.date) - new Date(a.date))
                        .slice(0, 3); // Test last 3 HR games
                    
                    if (gamesWithHR.length > 0) {
                        await message.reply(`⚾ Testing distance data for ${gamesWithHR.length} recent home run games:`);
                        
                        for (const game of gamesWithHR) {
                            await message.reply(`📅 Game: ${game.date} (ID: ${game.gameId})`);
                            
                            // Test Statcast distance
                            const statcastDistance = await this.getHomeRunDetailsFromStatcast(playerId, game.gameId);
                            await message.reply(`📊 Statcast Distance: ${statcastDistance.distance}`);
                            await message.reply(`📊 Statcast RBI: ${statcastDistance.rbi} (${statcastDistance.rbiDescription})`);
                            
                            // Test game feed distance
                            try {
                                const gameFeedResponse = await axios.get(
                                    `https://statsapi.mlb.com/api/v1/game/${game.gameId}/feed/live`
                                );
                                
                                if (gameFeedResponse.data.liveData && gameFeedResponse.data.liveData.plays) {
                                    const homeRunPlays = gameFeedResponse.data.liveData.plays.allPlays.filter(play => 
                                        play.result && 
                                        (play.result.event === 'Home Run' || 
                                         play.result.eventType === 'home_run' ||
                                         (play.result.description && play.result.description.toLowerCase().includes('home run'))) &&
                                        play.matchup && play.matchup.batter && 
                                        play.matchup.batter.id.toString() === playerId
                                    );
                                    
                                    if (homeRunPlays.length > 0) {
                                        const hrPlay = homeRunPlays[0];
                                        let gameFeedDistance = "Not available";
                                        
                                        if (hrPlay.hitData && hrPlay.hitData.totalDistance) {
                                            gameFeedDistance = `${hrPlay.hitData.totalDistance} ft`;
                                        } else if (hrPlay.hitData && hrPlay.hitData.distance) {
                                            gameFeedDistance = `${hrPlay.hitData.distance} ft`;
                                        } else if (hrPlay.result && hrPlay.result.description && hrPlay.result.description.includes('ft')) {
                                            const distanceMatch = hrPlay.result.description.match(/(\d+)\s*ft/);
                                            if (distanceMatch) {
                                                gameFeedDistance = `${distanceMatch[1]} ft`;
                                            }
                                        }
                                        
                                        await message.reply(`📊 Game Feed Distance: ${gameFeedDistance}`);
                                    }
                                }
                            } catch (gameFeedError) {
                                await message.reply(`❌ Game feed error: ${gameFeedError.message}`);
                            }
                            
                            await message.reply(`---`);
                        }
                    } else {
                        await message.reply(`❌ No home run games found for ${playerData.name} this season`);
                    }
                }
            } catch (error) {
                await message.reply(`❌ Error: ${error.message}`);
            }
            
        } catch (error) {
            this.log(`Error in test distance data: ${error.message}`);
            await message.reply('Error testing distance data!');
        }
    }

    // Add this debug method to test with a specific game
    async debugTestSpecificGame(gameId, playerId) {
        try {
            console.log(`\n🔍 Testing game ${gameId} for player ${playerId}...\n`);
            
            // Try playByPlay endpoint
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
            );
            
            const plays = response.data.allPlays || [];
            console.log(`Found ${plays.length} plays in game`);
            
            let homeRunCount = 0;
            for (const play of plays) {
                if (this.isHomeRunByPlayer(play, playerId)) {
                    homeRunCount++;
                    console.log(`\n⚾ Home Run #${homeRunCount}:`);
                    console.log(`Description: ${play.result?.description}`);
                    
                    // Check playEvents
                    if (play.playEvents) {
                        console.log(`PlayEvents count: ${play.playEvents.length}`);
                        for (let i = 0; i < play.playEvents.length; i++) {
                            const event = play.playEvents[i];
                            if (event.hitData) {
                                console.log(`Event ${i} hitData:`, event.hitData);
                            }
                        }
                    }
                    
                    const distance = this.extractDistanceFromPlay(play);
                    const rbiInfo = this.extractRBIInfo(play);
                    
                    console.log(`Extracted Distance: ${distance}`);
                    console.log(`Extracted RBI: ${rbiInfo.rbi} (${rbiInfo.rbiDescription})`);
                }
            }
            
            if (homeRunCount === 0) {
                console.log('No home runs found for this player in this game');
            }
            
        } catch (error) {
            console.error(`Error testing game: ${error.message}`);
        }
    }

    async debugSpecificGame(gameId, playerName, message) {
        try {
            const playerId = Object.keys(this.players).find(id => 
                this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
            );
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            const playerData = this.players[playerId];
            await message.reply(`🔍 Debugging game ${gameId} for ${playerData.name}...`);
            
            // Call the debug method
            await this.debugTestSpecificGame(gameId, playerId);
            
            await message.reply(`✅ Debug complete! Check console for detailed output.`);
            
        } catch (error) {
            this.log(`Error in debug specific game: ${error.message}`);
            await message.reply('Error debugging specific game!');
        }
    }

    async testSpecificGame(gameId, playerName, message) {
        try {
            const playerId = Object.keys(this.players).find(id => 
                this.players[id].name.toLowerCase().includes(playerName.toLowerCase())
            );
            
            if (!playerId) {
                await message.reply(`Player "${playerName}" not found!`);
                return;
            }
            
            await message.reply(`🔍 Testing game ${gameId} for ${this.players[playerId].name}...`);
            
            // Use the debug method
            await this.debugTestSpecificGame(gameId, playerId);
            
            // Also test the actual extraction
            const response = await axios.get(
                `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
            );
            
            const plays = response.data.allPlays || [];
            let found = false;
            
            for (const play of plays) {
                if (this.isHomeRunByPlayer(play, playerId)) {
                    found = true;
                    const distance = this.extractDistanceFromPlay(play);
                    const rbiInfo = this.extractRBIInfo(play);
                    
                    const embed = new Discord.EmbedBuilder()
                        .setTitle(`⚾ Home Run Found!`)
                        .setDescription(play.result?.description || 'No description')
                        .addFields(
                            { name: 'Distance', value: distance, inline: true },
                            { name: 'RBI', value: `${rbiInfo.rbi} (${rbiInfo.rbiDescription})`, inline: true },
                            { name: 'Game ID', value: gameId.toString(), inline: true }
                        )
                        .setColor('#00FF00')
                        .setTimestamp();
                    
                    await message.reply({ embeds: [embed] });
                }
            }
            
            if (!found) {
                await message.reply(`No home runs found for ${this.players[playerId].name} in game ${gameId}`);
            }
            
        } catch (error) {
            await message.reply(`Error testing game: ${error.message}`);
        }
    }

    async findRecentHomeRunsWithDistance(message) {
        try {
            await message.reply('🔍 Finding recent home runs with distance data...');
            
            const results = [];
            
            for (const [playerId, playerData] of Object.entries(this.players)) {
                const response = await axios.get(
                    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
                );
                
                if (response.data.stats?.[0]?.splits) {
                    const hrGame = response.data.stats[0].splits
                        .find(game => game.stat.homeRuns > 0);
                    
                    if (hrGame) {
                        const gameId = hrGame.game?.gamePk;
                        if (gameId) {
                            try {
                                const details = await this.getRecentHomeRunDetails(playerId, 1);
                                const firstDetail = Array.isArray(details) ? details[0] : details;
                                results.push({
                                    player: playerData.name,
                                    date: hrGame.date,
                                    gameId: gameId,
                                    distance: firstDetail.distance,
                                    rbi: firstDetail.rbiDescription
                                });
                            } catch (err) {
                                this.log(`Error getting details for ${playerData.name}: ${err.message}`);
                            }
                        }
                    }
                }
                
                // Rate limit
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            if (results.length > 0) {
                const embed = new Discord.EmbedBuilder()
                    .setTitle('🏆 Recent Home Runs with Distance Data')
                    .setColor('#FFD700')
                    .setTimestamp();
                
                results.forEach(r => {
                    embed.addFields({
                        name: `${r.player} - ${r.date}`,
                        value: `Distance: ${r.distance}\nType: ${r.rbi}\nGame: ${r.gameId}`,
                        inline: false
                    });
                });
                
                await message.reply({ embeds: [embed] });
            } else {
                await message.reply('No recent home runs found with distance data');
            }
            
        } catch (error) {
            await message.reply(`Error finding recent home runs: ${error.message}`);
        }
    }

    async getStatcastFromPlayByPlay(playerId, season) {
        try {
            // Step 1: Find most recent HR game from game log
            const logResp = await axios.get(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${season}&group=hitting&gameType=R`
            );
            if (!logResp.data.stats?.[0]?.splits) return null;

            const hrGames = logResp.data.stats[0].splits
                .filter(g => g.stat.homeRuns > 0)
                .sort((a, b) => new Date(b.date) - new Date(a.date));

            if (hrGames.length === 0) return null;

            // Step 2: Get play-by-play data for the most recent HR game
            const gamePk = hrGames[0].game?.gamePk;
            const gameDate = hrGames[0].date;
            if (!gamePk) return null;

            const pbpResp = await axios.get(
                `https://statsapi.mlb.com/api/v1/game/${gamePk}/playByPlay`
            );
            const plays = pbpResp.data.allPlays || [];

            // Find the HR play by this batter
            let hitData = null;
            let pitcherName = 'Unknown';
            let plateZ = 3.5;
            let rbi = 1;
            for (const play of plays) {
                if (play.result?.event === 'Home Run' &&
                    play.matchup?.batter?.id?.toString() === playerId) {
                    pitcherName = play.matchup.pitcher?.fullName || 'Unknown';
                    rbi = play.result?.rbi || 1;
                    // hitData and plate_z are inside playEvents
                    for (const evt of (play.playEvents || [])) {
                        if (evt.hitData) {
                            hitData = evt.hitData;
                        }
                        // Get plate_z from the pitch that was hit
                        if (evt.pitchData?.coordinates?.pZ) {
                            plateZ = evt.pitchData.coordinates.pZ;
                        }
                    }
                    if (hitData) break;
                }
            }

            if (!hitData || !hitData.launchSpeed || !hitData.coordinates) return null;

            // Step 3: Get home/away teams from boxscore
            let homeTeam = '';
            let awayTeam = '';
            try {
                const boxResp = await axios.get(
                    `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`
                );
                homeTeam = boxResp.data.teams.home.team.abbreviation || '';
                awayTeam = boxResp.data.teams.away.team.abbreviation || '';
            } catch (e) {
                this.log(`Could not get boxscore for teams: ${e.message}`);
            }

            // Figure out pitcher's team (if batter is on home team, pitcher is away, and vice versa)
            const playerTeamAbbr = this.players[playerId]?.team || '';
            const pitcherTeam = (playerTeamAbbr === homeTeam) ? awayTeam : homeTeam;

            // Count season HR total from game log
            const allSplits = logResp.data.stats[0].splits;
            const seasonHRTotal = allSplits.reduce((sum, g) => sum + (g.stat.homeRuns || 0), 0);

            return {
                launch_speed: hitData.launchSpeed,
                launch_angle: hitData.launchAngle,
                hit_distance_sc: hitData.totalDistance,
                hc_x: hitData.coordinates.coordX,
                hc_y: hitData.coordinates.coordY,
                plate_z: plateZ,
                home_team: homeTeam,
                pitcher_name: pitcherName,
                pitcher_team: pitcherTeam,
                game_date: gameDate,
                rbi: rbi,
                rbi_description: this.getRbiDescription(rbi),
                season_hr_total: seasonHRTotal
            };
        } catch (error) {
            this.log(`Error fetching play-by-play Statcast for season ${season}: ${error.message}`);
            return null;
        }
    }

    async testEnhancedStatcast(message) {
        try {
            // Parse optional player name from command: !teststatcast [player]
            const args = message.content.slice('!teststatcast'.length).trim().toLowerCase();
            let playerId, playerData;

            if (args) {
                playerId = Object.keys(this.players).find(id =>
                    this.players[id].name.toLowerCase().includes(args)
                );
                if (!playerId) {
                    await message.reply(`Player "${args}" not found! Try: judge, soto, ohtani, etc.`);
                    return;
                }
                playerData = this.players[playerId];
            } else {
                // Pick a random tracked player
                const ids = Object.keys(this.players);
                playerId = ids[Math.floor(Math.random() * ids.length)];
                playerData = this.players[playerId];
            }

            await message.reply(`Fetching real Statcast data for ${playerData.name}...`);

            // Try current season first, then fall back to recent seasons
            let statcastData = null;
            let usedSeason = null;
            for (const season of [this.currentSeason, this.currentSeason - 1, this.currentSeason - 2]) {
                statcastData = await this.getStatcastFromPlayByPlay(playerId, season);
                if (statcastData) {
                    usedSeason = season;
                    break;
                }
            }

            if (!statcastData) {
                await message.reply(`No Statcast HR data found for ${playerData.name} in recent seasons.`);
                return;
            }

            const pitcherDisplay = statcastData.pitcher_team
                ? `${statcastData.pitcher_name} (${statcastData.pitcher_team})`
                : statcastData.pitcher_name;

            await message.reply(
                `Found HR from ${statcastData.game_date} (${usedSeason} season):\n` +
                `EV: ${statcastData.launch_speed} mph | LA: ${statcastData.launch_angle}\u00b0 | ` +
                `Dist: ${statcastData.hit_distance_sc} ft | Off: ${pitcherDisplay}\n` +
                `Running physics analysis...`
            );

            const combinedAnalysisResult = await this.runHRAnalysis(statcastData, playerData.name, playerId);
            if (!combinedAnalysisResult || !combinedAnalysisResult.success) {
                await message.reply('HR analysis failed! Check console for errors.');
                return;
            }

            const combinedFooterText = `TEST - Real data from ${statcastData.game_date}`;
            const combinedMessageOptions = this.buildAlertMessageOptions(
                playerId,
                playerData,
                statcastData.season_hr_total,
                {
                    rbiDescription: statcastData.rbi_description || 'Solo HR',
                    rbi: statcastData.rbi,
                    distance: `${Math.round(statcastData.hit_distance_sc)} ft`
                },
                {
                    statcastData,
                    analysisResult: combinedAnalysisResult,
                    footerText: combinedFooterText
                }
            );

            await message.channel.send(combinedMessageOptions);
            this.cleanupAnalysisImage(combinedAnalysisResult.image_path);
            await message.reply(`Test complete! ${combinedAnalysisResult.total_dongs}/30 parks cleared.`);
            return;

            // Step 1: Send a simulated basic HR alert (Message 1)
            const hrType = statcastData.rbi_description || 'Solo HR';
            const isNuke = statcastData.hit_distance_sc > 440;
            const titleText = hrType === 'Grand Slam!' ?
                `${playerData.name.toUpperCase()} GRAND SLAM!` :
                `${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}!`;
            const description = isNuke
                ? `${playerData.name} just hit a fucking NUKE!`
                : `${playerData.name} just hit a home run!`;

            const basicEmbed = new Discord.EmbedBuilder()
                .setTitle(titleText)
                .setDescription(description)
                .addFields(this.buildInitialAlertFields(
                    playerData,
                    statcastData.season_hr_total,
                    hrType,
                    `${Math.round(statcastData.hit_distance_sc)} ft`
                ))
                .setColor('#132448')
                .setTimestamp()
                .setFooter({ text: `TEST - Real data from ${statcastData.game_date}` });

            const headshotUrl = this.getPlayerHeadshotUrl(playerData.name);
            if (headshotUrl) {
                basicEmbed.setThumbnail(headshotUrl);
            }

            await message.channel.send({ embeds: [basicEmbed] });

            // Step 2: Run the full analysis pipeline (Message 2)
            const analysisResult = await this.runHRAnalysis(statcastData, playerData.name, playerId);
            if (!analysisResult || !analysisResult.success) {
                await message.reply('HR analysis failed! Check console for errors.');
                return;
            }

            const totalDongs = analysisResult.total_dongs;
            let embedColor;
            if (totalDongs >= 25) embedColor = '#FF2222';
            else if (totalDongs >= 15) embedColor = '#FFD700';
            else embedColor = '#888888';

            // Get wall height at home park from analysis results
            const homeParkDetail = analysisResult.park_details.find(p => p.team === statcastData.home_team);
            const wallHeight = homeParkDetail ? `${homeParkDetail.fence_height} ft` : 'N/A';
            const wallDist = homeParkDetail ? `${Math.round(homeParkDetail.wall_distance)} ft` : 'N/A';

            const embed = new Discord.EmbedBuilder()
                .setTitle(`Statcast Details: ${playerData.name} HR #${statcastData.season_hr_total}`)
                .addFields(this.buildCompactStatcastFields(
                    statcastData,
                    analysisResult,
                    wallHeight,
                    wallDist,
                    totalDongs,
                    pitcherDisplay
                ))
                .setColor(embedColor)
                .setTimestamp()
                .setFooter({ text: `TEST - Real data from ${statcastData.game_date}` });

            if (analysisResult.parks_not_cleared.length > 0 && analysisResult.parks_not_cleared.length <= 10) {
                embed.addFields({
                    name: `Not a HR in (${analysisResult.parks_not_cleared.length})`,
                    value: analysisResult.parks_not_cleared.join(', '),
                    inline: true
                });
            }

            const messageOptions = { embeds: [embed] };

            if (analysisResult.image_path && fs.existsSync(analysisResult.image_path)) {
                const attachment = new Discord.AttachmentBuilder(analysisResult.image_path, { name: 'ballpark_overlay.png' });
                embed.setImage('attachment://ballpark_overlay.png');
                messageOptions.files = [attachment];
            }

            await message.channel.send(messageOptions);

            // Cleanup
            if (analysisResult.image_path && fs.existsSync(analysisResult.image_path)) {
                fs.unlinkSync(analysisResult.image_path);
            }

            await message.reply(`Test complete! ${totalDongs}/30 parks cleared.`);
        } catch (error) {
            this.log(`Error in teststatcast: ${error.message}`);
            await message.reply(`Error testing enhanced Statcast: ${error.message}`);
        }
    }

    getParksBreakdown(homeRunParks) {
        const counts = { noDoubter: 0, tier24: 0, tier18: 0, tier12: 0, tier6: 0 };
        const values = Object.values(homeRunParks);

        for (const parksCleared of values) {
            if (parksCleared === 30) {
                counts.noDoubter++;
            } else if (parksCleared >= 24) {
                counts.tier24++;
            } else if (parksCleared >= 18) {
                counts.tier18++;
            } else if (parksCleared >= 12) {
                counts.tier12++;
            } else {
                counts.tier6++;
            }
        }

        return { total: values.length, counts };
    }

    formatParksBreakdown(playerName, breakdown) {
        const { total, counts } = breakdown;
        if (total === 0) {
            return `**${playerName}** — no parks data yet`;
        }

        const lines = [
            `**${playerName}** — ${total} HR with parks data`,
            `30/30 No Doubters: **${counts.noDoubter}**`,
            `24+/30 parks: **${counts.tier24}**`,
            `18+/30 parks: **${counts.tier18}**`,
            `12+/30 parks: **${counts.tier12}**`,
            `6 or fewer: **${counts.tier6}**`
        ];

        return lines.join('\n');
    }

    async sendParksBreakdown(message, playerName = null) {
        try {
            if (playerName) {
                const playerId = this.findPlayerIdByName(playerName);
                if (!playerId) {
                    await message.reply(`Could not find a tracked player matching "${playerName}".`);
                    return;
                }

                const playerData = this.players[playerId];
                const breakdown = this.getParksBreakdown(playerData.homeRunParks || {});
                const text = this.formatParksBreakdown(playerData.name, breakdown);

                const embed = new Discord.EmbedBuilder()
                    .setTitle(`${playerData.name} — ${this.currentSeason} Parks Breakdown`)
                    .setDescription(text)
                    .setColor('#132448')
                    .setTimestamp();

                const thumbnail = this.getPlayerHeadshotUrlById(playerId);
                if (thumbnail) {
                    embed.setThumbnail(thumbnail);
                }

                await message.reply({ embeds: [embed] });
                return;
            }

            // All players
            const sections = [];
            for (const [playerId, playerData] of Object.entries(this.players)) {
                const breakdown = this.getParksBreakdown(playerData.homeRunParks || {});
                sections.push(this.formatParksBreakdown(playerData.name, breakdown));
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle(`${this.currentSeason} Parks Breakdown — All Players`)
                .setDescription(sections.join('\n\n'))
                .setColor('#132448')
                .setTimestamp()
                .setFooter({ text: 'Based on Statcast data and ballpark analysis' });

            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in sendParksBreakdown:', error);
            await message.reply('Had trouble pulling parks breakdown data.');
        }
    }

    async sendPlayerStats(playerId, message) {
        try {
            const stats = await this.getPlayerStats(playerId);
            const playerData = this.players[playerId];
            
            if (!stats) {
                await message.reply(`Sorry, I couldn't get stats for ${playerData.name} right now!`);
                return;
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle(`${playerData.name} ${this.currentSeason} Stats`)
                .addFields(
                    { name: '⚾ Hitting', value: `**AVG:** ${stats.avg || 'N/A'} | **HR:** ${stats.homeRuns || 0} | **RBI:** ${stats.rbi || 0} | **R:** ${stats.runs || 0}`, inline: false },
                    { name: '📊 Advanced', value: `**OBP:** ${stats.obp || 'N/A'} | **SLG:** ${stats.slg || 'N/A'} | **OPS:** ${stats.ops || 'N/A'}`, inline: false },
                    { name: '🏃 Other', value: `**H:** ${stats.hits || 0} | **AB:** ${stats.atBats || 0} | **SB:** ${stats.stolenBases || 0} | **SO:** ${stats.strikeOuts || 0} | **BB:** ${stats.baseOnBalls || 0}`, inline: false },
                    { name: '🤖 Bot Tracking', value: `**Last Checked:** ${this.players[playerId].lastCheckedHR} HR`, inline: false }
                )
                .setColor('#132448')
                .setTimestamp()
                .setFooter({ text: `Team: ${playerData.team} | #${playerData.number}` });

            // Add player headshot
            const headshots = {
                'Aaron Judge': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current',
                'Jazz Chisholm Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665862/headshot/67/current',
                'Juan Soto': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665742/headshot/67/current',
                'Shohei Ohtani': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660271/headshot/67/current',
                'Kyle Schwarber': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/656941/headshot/67/current',
                'Bryce Harper': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/547180/headshot/67/current',
                'Gunnar Henderson': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/683002/headshot/67/current'
            };
            
            const statsThumbnail = this.getPlayerHeadshotUrlById(playerId) || headshots[playerData.name];
            if (statsThumbnail) {
                embed.setThumbnail(statsThumbnail);
            }
            
            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in sendPlayerStats:', error);
            await message.reply('Sorry, I had trouble getting the stats right now!');
        }
    }

    async sendTrackedPlayers(message) {
        const playerList = Object.values(this.players)
            .map(player => `• ${player.name} (${player.team} #${player.number})`)
            .join('\n');

        const embed = new Discord.EmbedBuilder()
            .setTitle('📊 Tracked Players')
            .setDescription(`Currently monitoring these players for home runs:\n\n${playerList}`)
            .addFields(
                { name: 'Player Commands', value: '!judge, !jazz, !soto, !ohtani, !schwarber, !harper, !gunnar, !trout', inline: false },
                { name: 'General Commands', value: '!hrstats, !parkstats, !players', inline: false },
                { name: 'Admin Commands', value: '!forcecheck, !testhr, !reset [player], !debug', inline: false },
                { name: 'Alert Channels', value: `Sending to ${this.channelIds.length} channel(s)`, inline: false }
            )
            .setColor('#132448')
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }

    async sendAllHomeRunStats(message) {
        try {
            const hrStats = [];
            
            for (const [playerId, playerData] of Object.entries(this.players)) {
                const homeRuns = await this.getPlayerHomeRuns(playerId);
                hrStats.push({
                    name: playerData.name,
                    team: playerData.team,
                    homeRuns: homeRuns,
                    tracked: playerData.lastCheckedHR
                });
            }
            
            // Sort by home runs (descending)
            hrStats.sort((a, b) => b.homeRuns - a.homeRuns);
            
            const statsText = hrStats
                .map((player, index) => `${index + 1}. ${player.name} (${player.team}): ${player.homeRuns} HR (tracking: ${player.tracked})`)
                .join('\n');

            const embed = new Discord.EmbedBuilder()
                .setTitle(`🏆 ${this.currentSeason} Home Run Leaderboard`)
                .setDescription(statsText)
                .setColor('#FFD700')
                .setTimestamp()
                .setFooter({ text: 'Numbers in parentheses show what the bot last recorded' });

            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in sendAllHomeRunStats:', error);
            await message.reply('Sorry, I had trouble getting the home run stats!');
        }
    }

    async sendTestHomeRunAlert(message) {
        try {
            // Pick a random player for the test
            const playerIds = Object.keys(this.players);
            const randomPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
            const playerData = this.players[randomPlayerId];
            
            // Create sample home run data
            const sampleDistances = ['415 ft', '438 ft', '462 ft', '395 ft', '441 ft', '478 ft'];
            const sampleRBIs = [1, 2, 3, 4];
            const sampleHRTypes = ['Solo HR', '2-run HR', '3-run HR', 'Grand Slam!'];
            
            const randomDistance = sampleDistances[Math.floor(Math.random() * sampleDistances.length)];
            const randomRBI = sampleRBIs[Math.floor(Math.random() * sampleRBIs.length)];
            const randomHRType = sampleHRTypes[randomRBI - 1];
            
            const testDetails = {
                distance: randomDistance,
                rbi: randomRBI,
                rbiDescription: randomHRType
            };
            
            // Create the embed for test (only send to current channel)
            const hrType = testDetails.rbiDescription || 'Solo HR';
            const titleText = hrType === 'Grand Slam!' ? 
                `${playerData.name.toUpperCase()} GRAND SLAM!` :
                `${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}!`;
            
            // Parse distance for nuke check
            let isNuke = false;
            if (randomDistance) {
                const match = randomDistance.match(/(\d+)/);
                if (match) {
                    const distanceNum = parseInt(match[1]);
                    isNuke = distanceNum > 440;
                }
            }
            
            // Always use singular description
            let description = `${playerData.name} just hit a home run!`;
            if (isNuke) {
                description = `${playerData.name} just hit a fucking NUKE!`;
            }
            
            const embed = new Discord.EmbedBuilder()
                .setTitle(titleText)
                .setDescription(description)
                .addFields(this.buildInitialAlertFields(
                    playerData,
                    `${Math.floor(Math.random() * 40) + 10}`,
                    hrType,
                    testDetails.distance
                ))
                .setColor('#132448')
                .setTimestamp();

            // Set footer if details pending
            if (testDetails.rbi === 'unknown') {
                embed.setFooter({ text: 'Details may update soon—check back!' });
            }

            // Set player headshot using MLB's official headshot URLs
            const headshots = {
                'Aaron Judge': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/592450/headshot/67/current',
                'Jazz Chisholm Jr.': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665862/headshot/67/current',
                'Juan Soto': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/665742/headshot/67/current',
                'Shohei Ohtani': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/660271/headshot/67/current',
                'Kyle Schwarber': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/656941/headshot/67/current',
                'Bryce Harper': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/547180/headshot/67/current',
                'Gunnar Henderson': 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/683002/headshot/67/current'
            };
            
            const testThumbnail = this.getPlayerHeadshotUrlById(randomPlayerId) || headshots[playerData.name];
            if (testThumbnail) {
                embed.setThumbnail(testThumbnail);
            }

            // Send only to the current channel where the command was issued
            await message.channel.send({ embeds: [embed] });
            
            await message.reply(`🧪 Test alert sent to this channel for ${playerData.name}!`);
        } catch (error) {
            this.log(`Error sending test message: ${error.message}`);
            await message.reply('Sorry, I had trouble sending the test alert!');
        }
    }
}

// Usage - Parse multiple channel IDs from environment
const botToken = process.env.BOT_TOKEN;
const channelIdString = process.env.CHANNEL_ID;
const adminUserIds = (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
const botUsername = process.env.BOT_USERNAME || 'home-run-bot';

if (!botToken || !channelIdString) {
    console.error('Missing required environment variables: BOT_TOKEN and/or CHANNEL_ID');
    process.exit(1);
}

// Parse comma-separated channel IDs
const channelIds = channelIdString.split(',').map(id => id.trim()).filter(id => id.length > 0);

if (channelIds.length === 0) {
    console.error('No valid channel IDs found in CHANNEL_ID environment variable');
    process.exit(1);
}

console.log(`Starting bot with ${channelIds.length} channel(s): ${channelIds.join(', ')}`);

const bot = new BaseballBot(botToken, channelIds, {
    adminUserIds,
    botUsername
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    bot.client.destroy();
    process.exit(0);
});

bot.initialize().catch(console.error);
