require('dotenv').config();
const axios = require('axios');

// Simple test to see what data Baseball Savant actually provides
async function testRealData() {
    console.log('🔍 Testing Real Baseball Savant Data');
    console.log('====================================\n');
    
    try {
        // Test with Aaron Judge (ID: 592450)
        const playerId = '592450';
        const currentSeason = new Date().getFullYear();
        
        const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=home%5C.run%7C&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfC=&hfSea=${currentSeason}%7C&hfSit=&player_type=batter&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=&game_date_lt=&hfInning=&hfRO=&team=&position=&hfOutfieldDirection=&hfInn=&min_pitches=0&min_results=0&min_pas=0&sort_col=game_date&player_event_sort=game_date&sort_order=desc&type=details&player_id=${playerId}&limit=3`;
        
        console.log('📡 Fetching data from Baseball Savant...');
        console.log(`URL: ${url}\n`);
        
        const response = await axios.get(url);
        
        const lines = response.data.split('\n');
        if (lines.length < 2) {
            console.log('❌ No data found');
            return;
        }
        
        const headers = lines[0].split(',');
        console.log('📊 Available Data Fields:');
        headers.forEach((header, index) => {
            console.log(`   ${index}: ${header}`);
        });
        
        console.log('\n📋 Sample Home Run Data:');
        console.log('─'.repeat(80));
        
        // Show first few home runs
        for (let i = 1; i < Math.min(lines.length, 4); i++) {
            const values = lines[i].split(',');
            const events = values[headers.indexOf('events')];
            
            if (events === 'home_run') {
                console.log(`\n⚾ Home Run #${i}:`);
                console.log(`   Game Date: ${values[headers.indexOf('game_date')] || 'N/A'}`);
                console.log(`   Home Team: ${values[headers.indexOf('home_team')] || 'N/A'}`);
                console.log(`   Away Team: ${values[headers.indexOf('away_team')] || 'N/A'}`);
                console.log(`   Distance: ${values[headers.indexOf('hit_distance_sc')] || 'N/A'} ft`);
                console.log(`   RBI: ${values[headers.indexOf('rbi')] || 'N/A'}`);
                console.log(`   Hit Location: ${values[headers.indexOf('hit_location')] || 'N/A'}`);
                console.log(`   Launch Angle: ${values[headers.indexOf('launch_angle')] || 'N/A'}°`);
                console.log(`   Exit Velocity: ${values[headers.indexOf('launch_speed')] || 'N/A'} mph`);
                console.log(`   Hit Coord X: ${values[headers.indexOf('hit_coord_x')] || 'N/A'}`);
                console.log(`   Hit Coord Y: ${values[headers.indexOf('hit_coord_y')] || 'N/A'}`);
                console.log(`   Game PK: ${values[headers.indexOf('game_pk')] || 'N/A'}`);
                console.log('─'.repeat(40));
            }
        }
        
        // Test specific coordinates
        console.log('\n🎯 Testing Coordinate Data:');
        for (let i = 1; i < Math.min(lines.length, 4); i++) {
            const values = lines[i].split(',');
            const events = values[headers.indexOf('events')];
            
            if (events === 'home_run') {
                const coordX = values[headers.indexOf('hit_coord_x')];
                const coordY = values[headers.indexOf('hit_coord_y')];
                const distance = values[headers.indexOf('hit_distance_sc')];
                const hitLocation = values[headers.indexOf('hit_location')];
                
                if (coordX && coordY && coordX !== 'null' && coordY !== 'null') {
                    console.log(`\n📍 Home Run with Coordinates:`);
                    console.log(`   X: ${coordX}, Y: ${coordY}`);
                    console.log(`   Distance: ${distance} ft`);
                    console.log(`   Hit Location: ${hitLocation}`);
                    
                    // Show what this means
                    const x = parseFloat(coordX);
                    const y = parseFloat(coordY);
                    
                    if (x < 0) {
                        console.log(`   → Hit to LEFT field (negative X coordinate)`);
                    } else if (x > 0) {
                        console.log(`   → Hit to RIGHT field (positive X coordinate)`);
                    } else {
                        console.log(`   → Hit to CENTER field (X = 0)`);
                    }
                    
                    if (y > 0) {
                        console.log(`   → Hit DEEP (positive Y coordinate)`);
                    } else {
                        console.log(`   → Hit SHALLOW (negative Y coordinate)`);
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// Run the test
testRealData();
