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
            '592450': { name: 'Aaron Judge', team: 'NYY', number: '99', lastCheckedHR: 0, sentHomeRuns: new Set() },
            '665862': { name: 'Jazz Chisholm Jr.', team: 'NYY', number: '13', lastCheckedHR: 0, sentHomeRuns: new Set() },
            '665742': { name: 'Juan Soto', team: 'NYM', number: '22', lastCheckedHR: 0, sentHomeRuns: new Set() },
            '660271': { name: 'Shohei Ohtani', team: 'LAD', number: '17', lastCheckedHR: 0, sentHomeRuns: new Set() },
            '656941': { name: 'Kyle Schwarber', team: 'PHI', number: '12', lastCheckedHR: 0, sentHomeRuns: new Set() },
            '547180': { name: 'Bryce Harper', team: 'PHI', number: '3', lastCheckedHR: 0, sentHomeRuns: new Set() },
            '683002': { name: 'Gunnar Henderson', team: 'BAL', number: '2', lastCheckedHR: 0, sentHomeRuns: new Set() }
        };

        this.statePath = options.statePath || path.join(__dirname, 'data', 'bot_state.json');
        this.botUsername = options.botUsername || null;
        this.adminUserIds = new Set((options.adminUserIds || []).map(id => id.toString()));

        this.debugging = true;
        this.lastCheckTime = null;
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
                this.players[playerId].sentHomeRuns = new Set(
                    Array.isArray(savedState.sentHomeRuns) ? savedState.sentHomeRuns : []
                );
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
                serializedPlayers[playerId] = {
                    lastCheckedHR: playerData.lastCheckedHR,
                    sentHomeRuns: Array.from(playerData.sentHomeRuns)
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

    createHomeRunDetail(overrides = {}) {
        return {
            distance: 'Distance not available',
            rbi: 1,
            rbiDescription: 'Solo HR',
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
            eventKey: `${playerId}_${this.currentSeason}_fallback_${index + 1}`
        }));
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
            return detailsList.length > 0 ? detailsList : this.createFallbackHomeRunDetails(1, playerId);
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
        this.lastCheckTime = new Date();
        this.log(`Starting home run check at ${this.lastCheckTime.toISOString()}`);
        
        let alertsSent = 0;
        
        for (const [playerId, playerData] of Object.entries(this.players)) {
            try {
                const currentHomeRuns = await this.getPlayerHomeRuns(playerId);
                
                this.log(`${playerData.name}: Current=${currentHomeRuns}, Last=${playerData.lastCheckedHR}`);
                
                if (currentHomeRuns > playerData.lastCheckedHR) {
                    const newHomeRuns = currentHomeRuns - playerData.lastCheckedHR;
                    this.log(`🚨 NEW HOME RUN DETECTED! ${playerData.name} went from ${playerData.lastCheckedHR} to ${currentHomeRuns} (+${newHomeRuns})`);
                    
                    // Get ALL home run details for the season
                    let allHomeRunDetails = await this.getRecentHomeRunDetails(playerId, currentHomeRuns);
                    
                    // Filter out home runs we've already sent alerts for
                    const unseenHomeRuns = [];
                    for (const hrDetail of allHomeRunDetails) {
                        const hrId = this.buildHomeRunId(hrDetail);
                        
                        // Check if we've already sent this home run
                        if (!playerData.sentHomeRuns.has(hrId)) {
                            unseenHomeRuns.push(hrDetail);
                            playerData.sentHomeRuns.add(hrId);
                        }
                    }
                    
                    this.log(`Found ${unseenHomeRuns.length} new home runs out of ${allHomeRunDetails.length} total for ${playerData.name}`);
                    
                    // If details pending, log for potential retry
                    if (unseenHomeRuns.some(d => d.rbi === 'unknown')) {
                        this.log(`Details pending for ${playerData.name} - will retry on next check`);
                    }
                    
                    // Send an alert for each NEW home run only
                    let hrNumber = playerData.lastCheckedHR;
                    for (const hrDetail of unseenHomeRuns) {
                        hrNumber++;
                        if (hrDetail.gameId) {
                            this.scheduleCombinedAlert(playerId, playerData, hrNumber, hrDetail)
                                .catch(err => this.log(`Combined alert error for ${playerData.name}: ${err.message}`));
                        } else {
                            await this.sendHomeRunAlert(playerId, playerData, hrNumber, 1, hrDetail);
                        }
                        alertsSent++;
                    }
                    
                    this.players[playerId].lastCheckedHR = currentHomeRuns;
                    this.saveState();
                }
            } catch (error) {
                this.log(`Error checking ${playerData.name}: ${error.message}`);
                console.error(`Full error for ${playerData.name}:`, error);
            }
        }
        
        this.saveState();
        this.log(`Home run check completed. Alerts sent: ${alertsSent}`);
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

    buildCombinedFollowUpFields(totalDongs, pitcherDisplay) {
        return [
            { name: 'Parks Cleared', value: `${totalDongs}/30`, inline: true },
            { name: 'Off Pitcher', value: pitcherDisplay || 'N/A', inline: true }
        ];
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
                pitcherDisplay
            ));
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

    async sendToConfiguredChannels(messageOptions, logLabel) {
        let successCount = 0;
        for (const channelId of this.channelIds) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                await channel.send(messageOptions);
                this.log(`Sent ${logLabel} to channel ${channelId}`);
                successCount++;
            } catch (error) {
                this.log(`Error sending ${logLabel} to channel ${channelId}: ${error.message}`);
                console.error(`Full error for channel ${channelId}:`, error);
            }
        }

        return successCount;
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
        return [
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

    async sendHomeRunAlert(playerIdOrPlayerData, playerDataOrTotalHomeRuns, totalHomeRunsOrNewCount, newCountOrDetails, maybeDetails) {
        const hasExplicitPlayerId = typeof playerIdOrPlayerData === 'string' || typeof playerIdOrPlayerData === 'number';
        const playerId = hasExplicitPlayerId ? String(playerIdOrPlayerData) : Object.keys(this.players).find(id => this.players[id].name === playerIdOrPlayerData?.name);
        const playerData = hasExplicitPlayerId ? playerDataOrTotalHomeRuns : playerIdOrPlayerData;
        const totalHomeRuns = hasExplicitPlayerId ? totalHomeRunsOrNewCount : playerDataOrTotalHomeRuns;
        const details = hasExplicitPlayerId ? maybeDetails : newCountOrDetails;

        {
            this.log(`Sending home run alert for ${playerData.name} to ${this.channelIds.length} channel(s)...`);
            const alertPresentation = this.getHomeRunAlertPresentation(playerData, details);
            const basicMessageOptions = this.buildAlertMessageOptions(
                playerId,
                playerData,
                totalHomeRuns,
                alertPresentation.primaryDetails
            );

            const deliveredCount = await this.sendToConfiguredChannels(basicMessageOptions, 'alert');
            this.log(`Alert summary: ${deliveredCount}/${this.channelIds.length} channels notified for ${playerData.name} (Total: ${totalHomeRuns} HR, Distance: ${alertPresentation.primaryDetails.distance})`);
            return;
        }
        
        // Handle both single object and array of details
        const primaryDetails = Array.isArray(details) ? details : details;
        
        // Parse distance for nuke check
        let isNuke = false;
        if (primaryDetails.distance && primaryDetails.distance !== "Not yet available" && primaryDetails.distance !== "Distance not available") {
            const match = primaryDetails.distance.match(/(\d+)/);
            if (match) {
                const distanceNum = parseInt(match[1]);
                isNuke = distanceNum > 440;
            }
        }
        
        const hrType = primaryDetails.rbiDescription || 'Solo HR';
        const titleText = hrType === 'Grand Slam!' ? 
            `${playerData.name.toUpperCase()} GRAND SLAM!` :
            `${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}!`;
        
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
                totalHomeRuns,
                hrType,
                primaryDetails.distance
            ))
            .setColor('#132448')
            .setTimestamp();

        // Set footer if details pending
        if (primaryDetails.rbi === 'unknown') {
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
        
        const alertPlayerId = Object.keys(this.players).find(id => this.players[id].name === playerData.name);
        const alertThumbnail = this.getPlayerHeadshotUrlById(alertPlayerId) || headshots[playerData.name];
        if (alertThumbnail) {
            embed.setThumbnail(alertThumbnail);
        }

        // Send to all configured channels
        let successCount = 0;
        for (const channelId of this.channelIds) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                await channel.send({ embeds: [embed] });
                this.log(`✅ Successfully sent alert to channel ${channelId}`);
                successCount++;
            } catch (error) {
                this.log(`❌ Error sending message to channel ${channelId}: ${error.message}`);
                console.error(`Full error for channel ${channelId}:`, error);
            }
        }
        
        this.log(`📊 Alert summary: ${successCount}/${this.channelIds.length} channels notified for ${playerData.name} (Total: ${totalHomeRuns} HR, Distance: ${primaryDetails.distance})`);
    }

    // ── Enhanced Statcast Follow-Up Methods ────────────────────────────────

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
                pitcher_team: pitcherTeam
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

            execFile('python', args, { timeout: 30000 }, (error, stdout, stderr) => {
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

    async sendCombinedHomeRunAlert(playerId, playerData, totalHRs, hrDetail, statcastData, analysisResult, footerText = null) {
        this.log(`Sending combined home run alert for ${playerData.name}...`);

        const messageOptions = this.buildAlertMessageOptions(
            playerId,
            playerData,
            totalHRs,
            hrDetail,
            {
                statcastData,
                analysisResult,
                footerText
            }
        );

        const successCount = await this.sendToConfiguredChannels(messageOptions, 'combined alert');
        this.log(`Combined alert sent to ${successCount}/${this.channelIds.length} channels for ${playerData.name}`);
        this.cleanupAnalysisImage(analysisResult?.image_path);
    }

    async scheduleCombinedAlert(playerId, playerData, totalHRs, hrDetail) {
        const INITIAL_DELAY = 30000;
        const RETRY_INTERVAL = 60000;
        const MAX_RETRIES = 6;
        const gameId = hrDetail?.gameId;

        this.log(`Scheduling combined alert for ${playerData.name} (game ${gameId})`);

        await new Promise(resolve => setTimeout(resolve, INITIAL_DELAY));

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                this.log(`Retry ${attempt}/${MAX_RETRIES} for ${playerData.name} Statcast data...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
            }

            try {
                const statcastData = await this.getStatcastDataForHR(playerId, hrDetail);
                if (!statcastData) {
                    this.log(`Statcast data not yet available for ${playerData.name} (attempt ${attempt + 1})`);
                    continue;
                }

                this.log(`Got Statcast data for ${playerData.name}: EV=${statcastData.launch_speed}, LA=${statcastData.launch_angle}, Dist=${statcastData.hit_distance_sc}`);

                const analysisResult = await this.runHRAnalysis(statcastData, playerData.name, playerId);
                if (!analysisResult || !analysisResult.success) {
                    this.log(`HR analysis failed for ${playerData.name}`);
                    continue;
                }

                this.log(`HR analysis complete for ${playerData.name}: ${analysisResult.total_dongs}/30 parks`);
                await this.sendCombinedHomeRunAlert(playerId, playerData, totalHRs, hrDetail, statcastData, analysisResult);
                return;
            } catch (error) {
                this.log(`Combined alert attempt ${attempt + 1} error: ${error.message}`);
            }
        }

        this.log(`Gave up on combined alert data for ${playerData.name} after ${MAX_RETRIES + 1} attempts; sending basic alert`);
        await this.sendHomeRunAlert(playerId, playerData, totalHRs, 1, hrDetail);
    }

    async sendEnhancedFollowUp(playerData, totalHRs, statcastData, analysisResult) {
        this.log(`Sending enhanced follow-up for ${playerData.name}...`);

        const totalDongs = analysisResult.total_dongs;

        // Color-coded embed
        let embedColor;
        if (totalDongs >= 25) {
            embedColor = '#FF2222';  // Red — monster dong
        } else if (totalDongs >= 15) {
            embedColor = '#FFD700';  // Gold — solid dong
        } else {
            embedColor = '#888888';  // Gray — park-dependent
        }

        // Get wall height at home park from analysis results
        const homeParkDetail = analysisResult.park_details.find(p => p.team === statcastData.home_team);
        const wallHeight = homeParkDetail ? `${homeParkDetail.fence_height} ft` : 'N/A';
        const wallDist = homeParkDetail ? `${Math.round(homeParkDetail.wall_distance)} ft` : 'N/A';

        // Pitcher display with team abbreviation
        const pitcherDisplay = (statcastData.pitcher_name && statcastData.pitcher_name !== 'Unknown')
            ? (statcastData.pitcher_team ? `${statcastData.pitcher_name} (${statcastData.pitcher_team})` : statcastData.pitcher_name)
            : null;

        const embed = new Discord.EmbedBuilder()
            .setTitle(`Statcast Details: ${playerData.name} HR #${totalHRs}`)
            .addFields(this.buildCompactStatcastFields(
                statcastData,
                analysisResult,
                wallHeight,
                wallDist,
                totalDongs,
                pitcherDisplay
            ))
            .setColor(embedColor)
            .setTimestamp();

        // List parks where it would NOT be a HR (if 10 or fewer)
        if (analysisResult.parks_not_cleared.length > 0 && analysisResult.parks_not_cleared.length <= 10) {
            embed.addFields({
                name: `Not a HR in (${analysisResult.parks_not_cleared.length})`,
                value: analysisResult.parks_not_cleared.join(', '),
                inline: true
            });
        }

        // Prepare message options
        const messageOptions = { embeds: [embed] };

        // Attach image if available
        if (analysisResult.image_path && fs.existsSync(analysisResult.image_path)) {
            const attachment = new Discord.AttachmentBuilder(analysisResult.image_path, { name: 'ballpark_overlay.png' });
            embed.setImage('attachment://ballpark_overlay.png');
            messageOptions.files = [attachment];
        }

        // Send to all channels
        let successCount = 0;
        for (const channelId of this.channelIds) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                await channel.send(messageOptions);
                successCount++;
            } catch (error) {
                this.log(`Error sending enhanced follow-up to channel ${channelId}: ${error.message}`);
            }
        }

        this.log(`Enhanced follow-up sent to ${successCount}/${this.channelIds.length} channels for ${playerData.name}`);

        // Clean up temp image
        if (analysisResult.image_path) {
            try {
                if (fs.existsSync(analysisResult.image_path)) {
                    fs.unlinkSync(analysisResult.image_path);
                }
            } catch (cleanupError) {
                this.log(`Image cleanup error: ${cleanupError.message}`);
            }
        }
    }

    async scheduleEnhancedFollowUp(playerId, playerData, totalHRs, hrDetail) {
        const INITIAL_DELAY = 30000;   // 30 seconds
        const RETRY_INTERVAL = 60000;  // 60 seconds
        const MAX_RETRIES = 6;
        const gameId = hrDetail?.gameId;

        this.log(`Scheduling enhanced follow-up for ${playerData.name} (game ${gameId})`);

        // Wait initial delay
        await new Promise(resolve => setTimeout(resolve, INITIAL_DELAY));

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                this.log(`Retry ${attempt}/${MAX_RETRIES} for ${playerData.name} Statcast data...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
            }

            try {
                const statcastData = await this.getStatcastDataForHR(playerId, hrDetail);
                if (!statcastData) {
                    this.log(`Statcast data not yet available for ${playerData.name} (attempt ${attempt + 1})`);
                    continue;
                }

                this.log(`Got Statcast data for ${playerData.name}: EV=${statcastData.launch_speed}, LA=${statcastData.launch_angle}, Dist=${statcastData.hit_distance_sc}`);

                const analysisResult = await this.runHRAnalysis(statcastData, playerData.name, playerId);
                if (!analysisResult || !analysisResult.success) {
                    this.log(`HR analysis failed for ${playerData.name}`);
                    continue;
                }

                this.log(`HR analysis complete for ${playerData.name}: ${analysisResult.total_dongs}/30 parks`);
                await this.sendEnhancedFollowUp(playerData, totalHRs, statcastData, analysisResult);
                return; // Success — done
            } catch (error) {
                this.log(`Enhanced follow-up attempt ${attempt + 1} error: ${error.message}`);
            }
        }

        this.log(`Gave up on enhanced follow-up for ${playerData.name} after ${MAX_RETRIES + 1} attempts`);
    }

    startMonitoring() {
        cron.schedule('*/5 * * * *', async () => {
            try {
                await this.checkForNewHomeRuns();
            } catch (error) {
                this.log(`Scheduled check failed: ${error.message}`);
            }
        });
        
        this.log('Started monitoring for home runs from your selected star players!');
        this.log('Checking every 5 minutes year-round so Opening Day and late-season games are not missed');
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

        if (command === '!players') {
            await this.sendTrackedPlayers(message);
            return;
        }

        if (command === '!hrstats') {
            await this.sendAllHomeRunStats(message);
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
            this.players[playerId].sentHomeRuns.clear(); // Clear the sent home runs tracking
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
                { name: 'Player Commands', value: '!judge, !jazz, !soto, !ohtani, !schwarber, !harper, !gunnar', inline: false },
                { name: 'General Commands', value: '!hrstats, !testhr, !players', inline: false },
                { name: 'Admin Commands', value: '!debug, !forcecheck, !reset [player], !testdetails [player], !testrbi [player], !testdistance [player], !debuggame [gameId] [player], !testgame [gameId] [player], !findrecent, !teststatcast', inline: false },
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
            
            // Create the embed for test (same as sendHomeRunAlert but only send to current channel)
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
