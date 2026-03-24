require('dotenv').config();
const axios = require('axios');

class BallparkCompatibilityTester {
    constructor() {
        this.currentSeason = new Date().getFullYear();
        this.ballparkDistances = {
            // AL East
            'BAL': { name: 'Oriole Park at Camden Yards', leftField: 333, leftCenter: 364, center: 400, rightCenter: 373, rightField: 318 },
            'BOS': { name: 'Fenway Park', leftField: 310, leftCenter: 379, center: 420, rightCenter: 380, rightField: 302 },
            'NYY': { name: 'Yankee Stadium', leftField: 318, leftCenter: 399, center: 408, rightCenter: 385, rightField: 314 },
            'TB': { name: 'Tropicana Field', leftField: 315, leftCenter: 370, center: 404, rightCenter: 370, rightField: 322 },
            'TOR': { name: 'Rogers Centre', leftField: 328, leftCenter: 375, center: 400, rightCenter: 375, rightField: 328 },
            
            // AL Central
            'CWS': { name: 'Guaranteed Rate Field', leftField: 330, leftCenter: 375, center: 400, rightCenter: 375, rightField: 335 },
            'CLE': { name: 'Progressive Field', leftField: 325, leftCenter: 370, center: 400, rightCenter: 375, rightField: 325 },
            'DET': { name: 'Comerica Park', leftField: 345, leftCenter: 370, center: 420, rightCenter: 365, rightField: 330 },
            'KC': { name: 'Kauffman Stadium', leftField: 330, leftCenter: 375, center: 410, rightCenter: 375, rightField: 330 },
            'MIN': { name: 'Target Field', leftField: 339, leftCenter: 377, center: 404, rightCenter: 365, rightField: 328 },
            
            // AL West
            'HOU': { name: 'Minute Maid Park', leftField: 315, leftCenter: 362, center: 409, rightCenter: 373, rightField: 326 },
            'LAA': { name: 'Angel Stadium', leftField: 347, leftCenter: 382, center: 400, rightCenter: 365, rightField: 330 },
            'OAK': { name: 'Oakland Coliseum', leftField: 330, leftCenter: 362, center: 400, rightCenter: 362, rightField: 330 },
            'SEA': { name: 'T-Mobile Park', leftField: 331, leftCenter: 378, center: 401, rightCenter: 365, rightField: 326 },
            'TEX': { name: 'Globe Life Field', leftField: 329, leftCenter: 374, center: 400, rightCenter: 374, rightField: 326 },
            
            // NL East
            'ATL': { name: 'Truist Park', leftField: 335, leftCenter: 380, center: 400, rightCenter: 375, rightField: 325 },
            'MIA': { name: 'loanDepot park', leftField: 344, leftCenter: 384, center: 407, rightCenter: 392, rightField: 335 },
            'NYM': { name: 'Citi Field', leftField: 335, leftCenter: 358, center: 408, rightCenter: 375, rightField: 330 },
            'PHI': { name: 'Citizens Bank Park', leftField: 329, leftCenter: 374, center: 401, rightCenter: 369, rightField: 330 },
            'WSH': { name: 'Nationals Park', leftField: 336, leftCenter: 377, center: 402, rightCenter: 370, rightField: 335 },
            
            // NL Central
            'CHC': { name: 'Wrigley Field', leftField: 355, leftCenter: 368, center: 400, rightCenter: 368, rightField: 353 },
            'CIN': { name: 'Great American Ball Park', leftField: 328, leftCenter: 379, center: 400, rightCenter: 370, rightField: 325 },
            'MIL': { name: 'American Family Field', leftField: 344, leftCenter: 374, center: 400, rightCenter: 374, rightField: 345 },
            'PIT': { name: 'PNC Park', leftField: 325, leftCenter: 375, center: 399, rightCenter: 375, rightField: 320 },
            'STL': { name: 'Busch Stadium', leftField: 336, leftCenter: 375, center: 400, rightCenter: 375, rightField: 335 },
            
            // NL West
            'ARI': { name: 'Chase Field', leftField: 330, leftCenter: 374, center: 407, rightCenter: 374, rightField: 334 },
            'COL': { name: 'Coors Field', leftField: 347, leftCenter: 390, center: 415, rightCenter: 375, rightField: 350 },
            'LAD': { name: 'Dodger Stadium', leftField: 330, leftCenter: 375, center: 395, rightCenter: 375, rightField: 330 },
            'SD': { name: 'Petco Park', leftField: 334, leftCenter: 378, center: 396, rightCenter: 387, rightField: 322 },
            'SF': { name: 'Oracle Park', leftField: 339, leftCenter: 364, center: 399, rightCenter: 365, rightField: 309 }
        };
    }

    log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }

    // Extract distance from home run details
    extractDistance(distanceString) {
        if (!distanceString || distanceString === "Distance not available" || distanceString === "Not yet available") {
            return null;
        }
        
        const match = distanceString.match(/(\d+)/);
        return match ? parseInt(match[1]) : null;
    }

    // Determine which ballparks a home run would clear
    calculateBallparkCompatibility(distance, direction = 'center') {
        if (!distance) {
            return { compatible: 0, total: 30, percentage: 0, ballparks: [] };
        }

        let compatibleBallparks = [];
        let totalBallparks = 0;

        for (const [team, park] of Object.entries(this.ballparkDistances)) {
            totalBallparks++;
            
            // Determine which fence distance to check based on direction
            let fenceDistance;
            switch (direction.toLowerCase()) {
                case 'left':
                case 'leftfield':
                case 'lf':
                    fenceDistance = park.leftField;
                    break;
                case 'leftcenter':
                case 'lc':
                    fenceDistance = park.leftCenter;
                    break;
                case 'center':
                case 'cf':
                    fenceDistance = park.center;
                    break;
                case 'rightcenter':
                case 'rc':
                    fenceDistance = park.rightCenter;
                    break;
                case 'right':
                case 'rightfield':
                case 'rf':
                    fenceDistance = park.rightField;
                    break;
                default:
                    // Default to center field if direction unknown
                    fenceDistance = park.center;
            }

            if (distance >= fenceDistance) {
                compatibleBallparks.push({
                    team: team,
                    name: park.name,
                    fenceDistance: fenceDistance
                });
            }
        }

        const compatible = compatibleBallparks.length;
        const percentage = Math.round((compatible / totalBallparks) * 100);

        return {
            compatible: compatible,
            total: totalBallparks,
            percentage: percentage,
            ballparks: compatibleBallparks
        };
    }

    // Get home run data from Baseball Savant for a specific player
    async getHomeRunDataFromStatcast(playerId, limit = 5) {
        try {
            const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=home%5C.run%7C&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfC=&hfSea=${this.currentSeason}%7C&hfSit=&player_type=batter&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=&game_date_lt=&hfInning=&hfRO=&team=&position=&hfOutfieldDirection=&hfInn=&min_pitches=0&min_results=0&min_pas=0&sort_col=game_date&player_event_sort=game_date&sort_order=desc&type=details&player_id=${playerId}&limit=${limit}`;
            
            this.log(`Fetching Statcast data from: ${url}`);
            
            const response = await axios.get(url);
            
            // Parse CSV response
            const lines = response.data.split('\n');
            if (lines.length < 2) {
                this.log('No data found in Statcast response');
                return [];
            }
            
            const headers = lines[0].split(',');
            const gameDateIndex = headers.indexOf('game_date');
            const eventsIndex = headers.indexOf('events');
            const distanceIndex = headers.indexOf('hit_distance_sc');
            const rbiIndex = headers.indexOf('rbi');
            const hitLocationIndex = headers.indexOf('hit_location');
            const launchAngleIndex = headers.indexOf('launch_angle');
            const exitVelocityIndex = headers.indexOf('launch_speed');
            
            const homeRuns = [];
            
            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                if (values[eventsIndex] === 'home_run') {
                    const homeRun = {
                        gameDate: values[gameDateIndex],
                        distance: values[distanceIndex] && values[distanceIndex] !== 'null' ? 
                            parseInt(values[distanceIndex]) : null,
                        rbi: values[rbiIndex] && values[rbiIndex] !== 'null' ? 
                            parseInt(values[rbiIndex]) : 1,
                        hitLocation: values[hitLocationIndex] || 'unknown',
                        launchAngle: values[launchAngleIndex] && values[launchAngleIndex] !== 'null' ? 
                            parseFloat(values[launchAngleIndex]) : null,
                        exitVelocity: values[exitVelocityIndex] && values[exitVelocityIndex] !== 'null' ? 
                            parseFloat(values[exitVelocityIndex]) : null
                    };
                    
                    homeRuns.push(homeRun);
                }
            }
            
            this.log(`Found ${homeRuns.length} home runs in Statcast data`);
            return homeRuns;
            
        } catch (error) {
            this.log(`Error fetching Statcast data: ${error.message}`);
            return [];
        }
    }

    // Determine direction from hit location or launch angle
    determineDirection(hitLocation, launchAngle) {
        if (hitLocation && hitLocation !== 'unknown') {
            // Parse hit location (e.g., "7", "8", "9" for outfield positions)
            const position = parseInt(hitLocation);
            if (position === 7) return 'left';
            if (position === 8) return 'center';
            if (position === 9) return 'right';
        }
        
        // Fallback to launch angle analysis
        if (launchAngle !== null) {
            if (launchAngle < -15) return 'left';
            if (launchAngle > 15) return 'right';
            return 'center';
        }
        
        // Default to center if we can't determine
        return 'center';
    }

    // Generate ballpark compatibility message
    generateCompatibilityMessage(distance, direction, compatibility) {
        if (!distance) {
            return "Distance data not available for ballpark analysis";
        }

        const directionText = direction === 'center' ? 'center field' : 
                             direction === 'left' ? 'left field' : 
                             direction === 'right' ? 'right field' : 
                             direction === 'leftcenter' ? 'left-center' : 
                             direction === 'rightcenter' ? 'right-center' : 'center field';

        let message = `This ${distance} ft home run would be a home run in **${compatibility.compatible}/${compatibility.total}** MLB ballparks (${compatibility.percentage}%)`;
        
        if (compatibility.compatible === 30) {
            message += " - **UNIVERSAL BOMB!** 💣";
        } else if (compatibility.compatible >= 25) {
            message += " - **MASSIVE SHOT!** 🚀";
        } else if (compatibility.compatible >= 20) {
            message += " - **POWER SHOW!** 💪";
        } else if (compatibility.compatible >= 15) {
            message += " - **SOLID BLAST!** ⚾";
        } else if (compatibility.compatible >= 10) {
            message += " - **PARK DEPENDENT** 🏟️";
        } else {
            message += " - **JUST BARELY** 😅";
        }

        return message;
    }

    // Test the ballpark compatibility feature
    async testBallparkCompatibility() {
        this.log('🧪 Testing Ballpark Compatibility Feature');
        this.log('=====================================');
        
        // Test with sample distances
        const testDistances = [350, 400, 450, 500];
        const testDirections = ['left', 'center', 'right'];
        
        for (const distance of testDistances) {
            for (const direction of testDirections) {
                this.log(`\n📏 Testing ${distance} ft home run to ${direction} field:`);
                const compatibility = this.calculateBallparkCompatibility(distance, direction);
                const message = this.generateCompatibilityMessage(distance, direction, compatibility);
                this.log(message);
                
                if (compatibility.ballparks.length > 0) {
                    this.log(`🏟️ Would clear: ${compatibility.ballparks.map(b => `${b.team} (${b.fenceDistance} ft)`).join(', ')}`);
                }
            }
        }
        
        // Test with real player data (Aaron Judge)
        this.log('\n🔍 Testing with real player data (Aaron Judge):');
        const judgeHomeRuns = await this.getHomeRunDataFromStatcast('592450', 3);
        
        if (judgeHomeRuns.length > 0) {
            for (const hr of judgeHomeRuns) {
                if (hr.distance) {
                    const direction = this.determineDirection(hr.hitLocation, hr.launchAngle);
                    const compatibility = this.calculateBallparkCompatibility(hr.distance, direction);
                    const message = this.generateCompatibilityMessage(hr.distance, direction, compatibility);
                    
                    this.log(`\n📅 ${hr.gameDate}: ${message}`);
                    this.log(`   Distance: ${hr.distance} ft | Direction: ${direction} | RBI: ${hr.rbi}`);
                }
            }
        }
    }

    // Simulate what the bot would send for a home run
    async simulateHomeRunAlert(playerName, distance, direction = 'center', rbi = 1) {
        this.log(`\n🚨 SIMULATED HOME RUN ALERT`);
        this.log(`========================`);
        this.log(`Player: ${playerName}`);
        this.log(`Distance: ${distance} ft`);
        this.log(`Direction: ${direction}`);
        this.log(`RBI: ${rbi}`);
        
        // Calculate ballpark compatibility
        const compatibility = this.calculateBallparkCompatibility(distance, direction);
        
        // Generate the main home run message (what the bot currently sends)
        const mainMessage = `${playerName.toUpperCase()} ${rbi > 1 ? `${rbi}-RUN ` : ''}HOME RUN!`;
        this.log(`\n📢 Main Alert: ${mainMessage}`);
        this.log(`   Distance: ${distance} ft`);
        this.log(`   Type: ${rbi === 1 ? 'Solo HR' : rbi === 2 ? '2-run HR' : rbi === 3 ? '3-run HR' : 'Grand Slam!'}`);
        
        // Generate the ballpark compatibility follow-up message
        const compatibilityMessage = this.generateCompatibilityMessage(distance, direction, compatibility);
        this.log(`\n🏟️ Follow-up Message: ${compatibilityMessage}`);
        
        // Show detailed breakdown
        if (compatibility.ballparks.length > 0) {
            this.log(`\n📊 Ballpark Breakdown:`);
            this.log(`   Would clear: ${compatibility.compatible}/${compatibility.total} parks`);
            this.log(`   Success rate: ${compatibility.percentage}%`);
            
            if (compatibility.compatible < 30) {
                const wouldNotClear = 30 - compatibility.compatible;
                this.log(`   Would NOT clear: ${wouldNotClear} parks`);
                
                // Find a few parks it wouldn't clear
                const incompatibleParks = [];
                for (const [team, park] of Object.entries(this.ballparkDistances)) {
                    let fenceDistance;
                    switch (direction) {
                        case 'left': fenceDistance = park.leftField; break;
                        case 'center': fenceDistance = park.center; break;
                        case 'right': fenceDistance = park.rightField; break;
                        default: fenceDistance = park.center;
                    }
                    
                    if (distance < fenceDistance) {
                        incompatibleParks.push(`${team} (${fenceDistance} ft)`);
                        if (incompatibleParks.length >= 3) break; // Just show first 3
                    }
                }
                
                if (incompatibleParks.length > 0) {
                    this.log(`   Examples of parks it wouldn't clear: ${incompatibleParks.join(', ')}`);
                }
            }
        }
    }
}

// Test the feature
async function runTests() {
    const tester = new BallparkCompatibilityTester();
    
    try {
        // Test basic ballpark compatibility
        await tester.testBallparkCompatibility();
        
        // Test simulated home run alerts
        console.log('\n\n🎯 SIMULATED HOME RUN ALERTS');
        console.log('============================');
        
        await tester.simulateHomeRunAlert('Aaron Judge', 462, 'center', 1);
        await tester.simulateHomeRunAlert('Shohei Ohtani', 450, 'left', 2);
        await tester.simulateHomeRunAlert('Pete Alonso', 500, 'right', 1);
        await tester.simulateHomeRunAlert('Juan Soto', 380, 'center', 3);
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTests();
}

module.exports = BallparkCompatibilityTester;
