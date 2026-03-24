// Integration Example: Adding Ballpark Compatibility to Your Bot
// This shows how to integrate the BallparkCompatibilityTester into your existing bot.js

const BallparkCompatibilityTester = require('./ballpark_test');

// Add this to your BaseballBot class constructor
class BaseballBot {
    constructor(token, channelIds) {
        // ... existing code ...
        
        // Add the ballpark compatibility tester
        this.ballparkTester = new BallparkCompatibilityTester();
        
        // ... rest of existing code ...
    }
    
    // Add this method to your BaseballBot class
    async sendBallparkCompatibilityMessage(channel, playerName, distance, direction = 'center') {
        try {
            // Calculate ballpark compatibility
            const compatibility = this.ballparkTester.calculateBallparkCompatibility(distance, direction);
            
            // Generate the message
            const message = this.ballparkTester.generateCompatibilityMessage(distance, direction, compatibility);
            
            // Create an embed for the follow-up message
            const embed = new Discord.EmbedBuilder()
                .setTitle('🏟️ Ballpark Compatibility Analysis')
                .setDescription(message)
                .addFields(
                    { name: 'Distance', value: `${distance} ft`, inline: true },
                    { name: 'Direction', value: direction === 'center' ? 'Center Field' : 
                                           direction === 'left' ? 'Left Field' : 
                                           direction === 'right' ? 'Right Field' : 
                                           direction === 'leftcenter' ? 'Left-Center' : 
                                           direction === 'rightcenter' ? 'Right-Center' : 'Center Field', inline: true },
                    { name: 'Success Rate', value: `${compatibility.compatible}/${compatibility.total} parks (${compatibility.percentage}%)`, inline: true }
                )
                .setColor('#00FF00')
                .setTimestamp();
            
            // Add ballpark breakdown if not universal
            if (compatibility.compatible < 30) {
                const wouldNotClear = 30 - compatibility.compatible;
                embed.addFields({
                    name: '📊 Ballpark Breakdown',
                    value: `Would NOT clear ${wouldNotClear} parks`,
                    inline: false
                });
                
                // Show examples of parks it wouldn't clear
                const incompatibleExamples = [];
                for (const [team, park] of Object.entries(this.ballparkTester.ballparkDistances)) {
                    let fenceDistance;
                    switch (direction) {
                        case 'left': fenceDistance = park.leftField; break;
                        case 'center': fenceDistance = park.center; break;
                        case 'right': fenceDistance = park.rightField; break;
                        default: fenceDistance = park.center;
                    }
                    
                    if (distance < fenceDistance) {
                        incompatibleExamples.push(`${team} (${fenceDistance} ft)`);
                        if (incompatibleExamples.length >= 5) break; // Show first 5
                    }
                }
                
                if (incompatibleExamples.length > 0) {
                    embed.addFields({
                        name: 'Examples of Parks It Wouldn\'t Clear',
                        value: incompatibleExamples.join(', '),
                        inline: false
                    });
                }
            }
            
            // Send the follow-up message
            await channel.send({ embeds: [embed] });
            
        } catch (error) {
            this.log(`Error sending ballpark compatibility message: ${error.message}`);
        }
    }
    
    // Modify your existing sendHomeRunAlert method to include ballpark compatibility
    async sendHomeRunAlert(playerData, totalHomeRuns, newCount, details) {
        // ... existing code for the main home run alert ...
        
        // After sending the main alert, send the ballpark compatibility message
        try {
            const primaryDetails = Array.isArray(details) ? details[0] : details;
            
            if (primaryDetails.distance && primaryDetails.distance !== "Not yet available" && primaryDetails.distance !== "Distance not available") {
                const distance = this.ballparkTester.extractDistance(primaryDetails.distance);
                
                if (distance) {
                    // Determine direction (you can enhance this based on your existing data)
                    const direction = 'center'; // Default, but you can make this smarter
                    
                    // Send to all configured channels
                    for (const channelId of this.channelIds) {
                        try {
                            const channel = await this.client.channels.fetch(channelId);
                            
                            // Send main alert first
                            await channel.send({ embeds: [embed] });
                            
                            // Wait a moment, then send ballpark compatibility
                            setTimeout(async () => {
                                await this.sendBallparkCompatibilityMessage(channel, playerData.name, distance, direction);
                            }, 2000); // 2 second delay
                            
                        } catch (error) {
                            this.log(`❌ Error sending to channel ${channelId}: ${error.message}`);
                        }
                    }
                }
            }
        } catch (error) {
            this.log(`Error adding ballpark compatibility: ${error.message}`);
        }
    }
}

// Usage example:
// 1. Save the ballpark_test.js file
// 2. Add the BallparkCompatibilityTester import to your bot.js
// 3. Add the ballparkTester property to your constructor
// 4. Add the sendBallparkCompatibilityMessage method
// 5. Modify your sendHomeRunAlert method to call it

// The result will be:
// 1. Bot sends: "AARON JUDGE SOLO HOME RUN!" (existing functionality)
// 2. 2 seconds later, bot sends: "This 462 ft home run would be a home run in 28/30 MLB ballparks (93%) - MASSIVE SHOT! 🚀"
