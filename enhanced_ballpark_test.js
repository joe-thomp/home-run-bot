require('dotenv').config();
const axios = require('axios');

class EnhancedBallparkCompatibilityTester {
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

    // Get enhanced home run data with spray chart coordinates
    async getEnhancedHomeRunData(playerId, limit = 5) {
        try {
            const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=home%5C.run%7C&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfC=&hfSea=${this.currentSeason}%7C&hfSit=&player_type=batter&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=&game_date_lt=&hfInning=&hfRO=&team=&position=&hfOutfieldDirection=&hfInn=&min_pitches=0&min_results=0&min_pas=0&sort_col=game_date&player_event_sort=game_date&sort_order=desc&type=details&player_id=${playerId}&limit=${limit}`;
            
            this.log(`Fetching enhanced Statcast data for player ${playerId}...`);
            
            const response = await axios.get(url);
            
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
            const hitCoordXIndex = headers.indexOf('hit_coord_x');
            const hitCoordYIndex = headers.indexOf('hit_coord_y');
            const homeTeamIndex = headers.indexOf('home_team');
            const awayTeamIndex = headers.indexOf('away_team');
            const gamePkIndex = headers.indexOf('game_pk');
            
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
                            parseFloat(values[exitVelocityIndex]) : null,
                        hitCoordX: values[hitCoordXIndex] && values[hitCoordXIndex] !== 'null' ? 
                            parseFloat(values[hitCoordXIndex]) : null,
                        hitCoordY: values[hitCoordYIndex] && values[hitCoordYIndex] !== 'null' ? 
                            parseFloat(values[hitCoordYIndex]) : null,
                        homeTeam: values[homeTeamIndex] || 'unknown',
                        awayTeam: values[awayTeamIndex] || 'unknown',
                        gamePk: values[gamePkIndex] || 'unknown'
                    };
                    
                    homeRuns.push(homeRun);
                }
            }
            
            this.log(`Found ${homeRuns.length} home runs with enhanced data`);
            return homeRuns;
            
        } catch (error) {
            this.log(`Error fetching enhanced Statcast data: ${error.message}`);
            return [];
        }
    }

    // Generate a text-based field representation with home run location
    generateFieldMap(hitCoordX, hitCoordY, direction, distance) {
        if (!hitCoordX || !hitCoordY) {
            return this.generateSimpleFieldMap(direction, distance);
        }
        
        // Create a simple ASCII field representation
        const field = [
            "                    ╭─────────────╮                    ",
            "                   ╱             ╲                   ",
            "                  ╱               ╲                  ",
            "                 ╱                 ╲                 ",
            "                ╱                   ╲                ",
            "               ╱                     ╲               ",
            "              ╱                       ╲              ",
            "             ╱                         ╲             ",
            "            ╱                           ╲            ",
            "           ╱                             ╲           ",
            "          ╱                               ╲          ",
            "         ╱                                 ╲         ",
            "        ╱                                   ╲        ",
            "       ╱                                     ╲       ",
            "      ╱                                       ╲      ",
            "     ╱                                         ╲     ",
            "    ╱                                           ╲    ",
            "   ╱                                             ╲   ",
            "  ╱                                               ╲  ",
            " ╱                                                 ╲ ",
            "╱                                                   ╲",
            "│                     HOME PLATE                    │",
            "╲                                                   ╱",
            " ╲                                                 ╱ ",
            "  ╲                                               ╱  ",
            "   ╲                                             ╱   ",
            "    ╲                                           ╱    ",
            "     ╲                                         ╱     ",
            "      ╲                                       ╱      ",
            "       ╲                                     ╱       ",
            "        ╲                                   ╱        ",
            "         ╲                                 ╱         ",
            "          ╲                               ╱          ",
            "           ╲                             ╱           ",
            "            ╲                           ╱            ",
            "             ╲                         ╱             ",
            "              ╲                       ╱              ",
            "               ╲                     ╱               ",
            "                ╲                   ╱                ",
            "                 ╲                 ╱                 ",
            "                  ╲               ╱                  ",
            "                   ╲             ╱                   ",
            "                    ╰─────────────╯                    "
        ];
        
        // Calculate position on the field (simplified)
        const fieldWidth = 40;
        const fieldHeight = 40;
        
        // Convert coordinates to field position
        // This is a simplified mapping - real coordinates would need more complex math
        let x = Math.floor((hitCoordX + 125) / 250 * fieldWidth);
        let y = Math.floor((hitCoordY + 125) / 250 * fieldHeight);
        
        // Clamp to field boundaries
        x = Math.max(0, Math.min(fieldWidth - 1, x));
        y = Math.max(0, Math.min(fieldHeight - 1, y));
        
        // Place the home run marker
        if (y < field.length && x < field[y].length) {
            const row = field[y];
            const newRow = row.substring(0, x) + '💥' + row.substring(x + 1);
            field[y] = newRow;
        }
        
        // Add distance and direction info
        field.push(`\n💥 Home Run Location: ${direction} field`);
        field.push(`📏 Distance: ${distance} ft`);
        field.push(`📍 Coordinates: (${hitCoordX}, ${hitCoordY})`);
        
        return field.join('\n');
    }

    // Generate a simple field map when coordinates aren't available
    generateSimpleFieldMap(direction, distance) {
        const field = [
            "                    ╭─────────────╮                    ",
            "                   ╱             ╲                   ",
            "                  ╱               ╲                  ",
            "                 ╱                 ╲                 ",
            "                ╱                   ╲                ",
            "               ╱                     ╲               ",
            "              ╱                       ╲              ",
            "             ╱                         ╲             ",
            "            ╱                           ╲            ",
            "           ╱                             ╲           ",
            "          ╱                               ╲          ",
            "         ╱                                 ╲         ",
            "        ╱                                   ╲        ",
            "       ╱                                     ╲       ",
            "      ╱                                       ╲      ",
            "     ╱                                         ╲     ",
            "    ╱                                           ╲    ",
            "   ╱                                             ╲   ",
            "  ╱                                               ╲  ",
            " ╱                                                 ╲ ",
            "╱                                                   ╲",
            "│                     HOME PLATE                    │",
            "╲                                                   ╱",
            " ╲                                                 ╱ ",
            "  ╲                                               ╱  ",
            "   ╲                                             ╱   ",
            "    ╲                                           ╱    ",
            "     ╲                                         ╱     ",
            "      ╲                                       ╱      ",
            "       ╲                                     ╱       ",
            "        ╲                                   ╱        ",
            "         ╲                                 ╱         ",
            "          ╲                               ╱          ",
            "           ╲                             ╱           ",
            "            ╲                           ╱            ",
            "             ╲                         ╱             ",
            "              ╲                       ╱              ",
            "               ╲                     ╱               ",
            "                ╲                   ╱                ",
            "                 ╲                 ╱                 ",
            "                  ╲               ╱                  ",
            "                   ╲             ╱                   ",
            "                    ╰─────────────╯                    "
        ];
        
        // Add direction indicator
        let directionMarker = '';
        if (direction === 'left') {
            directionMarker = "💥";
            field[15] = field[15].substring(0, 10) + '💥' + field[15].substring(11);
        } else if (direction === 'right') {
            directionMarker = "💥";
            field[15] = field[15].substring(0, 30) + '💥' + field[15].substring(31);
        } else {
            directionMarker = "💥";
            field[15] = field[15].substring(0, 20) + '💥' + field[15].substring(21);
        }
        
        field.push(`\n💥 Home Run Location: ${direction} field`);
        field.push(`📏 Distance: ${distance} ft`);
        field.push(`📍 Direction: ${direction}`);
        
        return field.join('\n');
    }

    // Test the enhanced features
    async testEnhancedFeatures() {
        this.log('🧪 Testing Enhanced Ballpark Features');
        this.log('====================================');
        
        // Test with Aaron Judge's recent home runs
        this.log('\n🔍 Testing with real Aaron Judge data:');
        const judgeHomeRuns = await this.getEnhancedHomeRunData('592450', 3);
        
        if (judgeHomeRuns.length > 0) {
            for (const hr of judgeHomeRuns) {
                this.log(`\n📅 ${hr.gameDate}: ${hr.homeTeam} vs ${hr.awayTeam}`);
                this.log(`   Distance: ${hr.distance} ft`);
                this.log(`   Direction: ${hr.hitLocation || 'unknown'}`);
                this.log(`   RBI: ${hr.rbi}`);
                
                if (hr.hitCoordX && hr.hitCoordY) {
                    this.log(`   Coordinates: (${hr.hitCoordX}, ${hr.hitCoordY})`);
                    
                    // Generate field map
                    const fieldMap = this.generateFieldMap(hr.hitCoordX, hr.hitCoordY, hr.hitLocation || 'center', hr.distance);
                    this.log('\n🏟️ Field Map:');
                    this.log(fieldMap);
                } else {
                    // Generate simple field map
                    const direction = this.determineDirection(hr.hitLocation, hr.launchAngle);
                    const fieldMap = this.generateSimpleFieldMap(direction, hr.distance);
                    this.log('\n🏟️ Field Map (Simple):');
                    this.log(fieldMap);
                }
                
                this.log('─'.repeat(50));
            }
        }
        
        // Test field map generation
        this.log('\n🎯 Testing Field Map Generation:');
        this.log('Left Field HR:');
        this.log(this.generateSimpleFieldMap('left', 350));
        
        this.log('\nCenter Field HR:');
        this.log(this.generateSimpleFieldMap('center', 450));
        
        this.log('\nRight Field HR:');
        this.log(this.generateSimpleFieldMap('right', 400));
    }

    // Determine direction from hit location or launch angle
    determineDirection(hitLocation, launchAngle) {
        if (hitLocation && hitLocation !== 'unknown') {
            const position = parseInt(hitLocation);
            if (position === 7) return 'left';
            if (position === 8) return 'center';
            if (position === 9) return 'right';
        }
        
        if (launchAngle !== null) {
            if (launchAngle < -15) return 'left';
            if (launchAngle > 15) return 'right';
            return 'center';
        }
        
        return 'center';
    }

    // Calculate ballpark compatibility (same as before)
    calculateBallparkCompatibility(distance, direction = 'center') {
        if (!distance) {
            return { compatible: 0, total: 30, percentage: 0, ballparks: [] };
        }

        let compatibleBallparks = [];
        let totalBallparks = 0;

        for (const [team, park] of Object.entries(this.ballparkDistances)) {
            totalBallparks++;
            
            let fenceDistance;
            switch (direction.toLowerCase()) {
                case 'left': fenceDistance = park.leftField; break;
                case 'leftcenter': fenceDistance = park.leftCenter; break;
                case 'center': fenceDistance = park.center; break;
                case 'rightcenter': fenceDistance = park.rightCenter; break;
                case 'right': fenceDistance = park.rightField; break;
                default: fenceDistance = park.center;
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

    // Generate ballpark compatibility message
    generateCompatibilityMessage(distance, direction, compatibility) {
        if (!distance) {
            return "Distance data not available for ballpark analysis";
        }

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
}

// Test the enhanced features
async function runEnhancedTests() {
    const tester = new EnhancedBallparkCompatibilityTester();
    
    try {
        await tester.testEnhancedFeatures();
    } catch (error) {
        console.error('Enhanced test failed:', error);
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    runEnhancedTests();
}

module.exports = EnhancedBallparkCompatibilityTester;
