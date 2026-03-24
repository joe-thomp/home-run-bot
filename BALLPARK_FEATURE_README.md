# 🏟️ Ballpark Compatibility Feature

This feature adds ballpark analysis to your home run bot, showing how many MLB ballparks each home run would clear.

## 🎯 What It Does

When a player hits a home run, your bot will:
1. Send the usual home run alert (existing functionality)
2. **NEW**: Send a follow-up message showing ballpark compatibility

**Example Output:**
```
🚨 AARON JUDGE SOLO HOME RUN!
Distance: 462 ft | Type: Solo HR | Team: NYY

🏟️ Ballpark Compatibility Analysis
This 462 ft home run would be a home run in 28/30 MLB ballparks (93%) - MASSIVE SHOT! 🚀
```

## 🏟️ Ballpark Data

The feature includes accurate fence distances for all 30 MLB ballparks:
- **Left Field** distances
- **Left-Center** distances  
- **Center Field** distances
- **Right-Center** distances
- **Right Field** distances

## 🚀 Features

### Smart Direction Detection
- Uses Statcast hit location data when available
- Falls back to launch angle analysis
- Defaults to center field if direction unknown

### Ballpark Compatibility Calculation
- Calculates how many parks the HR would clear
- Shows success percentage
- Provides fun emojis and descriptions based on success rate

### Success Rate Categories
- **30/30 parks** → "UNIVERSAL BOMB! 💣"
- **25-29 parks** → "MASSIVE SHOT! 🚀"  
- **20-24 parks** → "POWER SHOW! 💪"
- **15-19 parks** → "SOLID BLAST! ⚾"
- **10-14 parks** → "PARK DEPENDENT 🏟️"
- **<10 parks** → "JUST BARELY 😅"

## 📁 Files

1. **`ballpark_test.js`** - Main feature class with all functionality
2. **`integration_example.js`** - Shows how to integrate with your existing bot
3. **`BALLPARK_FEATURE_README.md`** - This documentation

## 🔧 Integration Steps

### Step 1: Add to Your Bot Constructor
```javascript
const BallparkCompatibilityTester = require('./ballpark_test');

class BaseballBot {
    constructor(token, channelIds) {
        // ... existing code ...
        
        // Add this line
        this.ballparkTester = new BallparkCompatibilityTester();
        
        // ... rest of existing code ...
    }
}
```

### Step 2: Add the Ballpark Message Method
```javascript
async sendBallparkCompatibilityMessage(channel, playerName, distance, direction = 'center') {
    // ... copy the method from integration_example.js ...
}
```

### Step 3: Modify Your sendHomeRunAlert Method
```javascript
async sendHomeRunAlert(playerData, totalHomeRuns, newCount, details) {
    // ... existing code for main alert ...
    
    // Add this after sending the main alert
    try {
        const primaryDetails = Array.isArray(details) ? details[0] : details;
        
        if (primaryDetails.distance && primaryDetails.distance !== "Not yet available") {
            const distance = this.ballparkTester.extractDistance(primaryDetails.distance);
            
            if (distance) {
                // Send ballpark compatibility message after 2 second delay
                setTimeout(async () => {
                    await this.sendBallparkCompatibilityMessage(channel, playerData.name, distance, 'center');
                }, 2000);
            }
        }
    } catch (error) {
        this.log(`Error adding ballpark compatibility: ${error.message}`);
    }
}
```

## 🧪 Testing

### Run the Test File
```bash
node ballpark_test.js
```

This will test:
- Ballpark distance calculations
- Direction detection
- Message generation
- Real player data from Baseball Savant

### Test Specific Scenarios
```javascript
const tester = new BallparkCompatibilityTester();

// Test a 450 ft home run to center field
const compatibility = tester.calculateBallparkCompatibility(450, 'center');
const message = tester.generateCompatibilityMessage(450, 'center', compatibility);
console.log(message);
```

## 📊 Example Calculations

| Distance | Direction | Parks Cleared | Success Rate | Description |
|----------|-----------|----------------|--------------|-------------|
| 350 ft   | Left      | 8/30          | 27%          | PARK DEPENDENT 🏟️ |
| 400 ft   | Center    | 15/30         | 50%          | SOLID BLAST! ⚾ |
| 450 ft   | Right     | 25/30         | 83%          | MASSIVE SHOT! 🚀 |
| 500 ft   | Center    | 30/30         | 100%         | UNIVERSAL BOMB! 💣 |

## 🔍 Advanced Features

### Hit Location Detection
The system can determine direction from Statcast data:
- Position 7 = Left Field
- Position 8 = Center Field  
- Position 9 = Right Field

### Launch Angle Fallback
If hit location isn't available:
- Negative launch angle = Left Field
- Positive launch angle = Right Field
- Near 0° = Center Field

### Real-Time Data
- Fetches latest home run data from Baseball Savant
- Includes exit velocity, launch angle, and hit location
- Updates automatically with current season data

## 🚨 Error Handling

The feature gracefully handles:
- Missing distance data
- API failures
- Invalid ballpark data
- Network timeouts

## 📈 Future Enhancements

Potential improvements:
- **Weather conditions** (wind, temperature, humidity)
- **Altitude adjustments** (Coors Field, etc.)
- **Historical ballpark data** (different eras)
- **Player-specific analysis** (lefty vs righty parks)
- **Seasonal adjustments** (ball changes, etc.)

## 🤝 Contributing

To improve the feature:
1. Update ballpark distances in `ballparkDistances` object
2. Enhance direction detection algorithms
3. Add new ballpark compatibility metrics
4. Improve error handling and logging

## 📞 Support

If you need help integrating this feature:
1. Check the integration example
2. Run the test file to verify functionality
3. Review the error logs for debugging
4. Ensure all dependencies are installed (`axios`, `dotenv`)

---

**Happy Home Run Tracking! ⚾💪**
