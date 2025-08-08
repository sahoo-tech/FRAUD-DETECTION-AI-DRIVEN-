const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI
console.log('Initializing Gemini AI with API key:', process.env.GEMINI_API_KEY ? 'API key loaded' : 'API key missing');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.'
    }
});
app.use('/api', limiter);

// Fraud analysis rate limiting (more restrictive)
const fraudAnalysisLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 fraud analyses per minute
    message: {
        error: 'Too many fraud analysis requests, please wait before trying again.'
    }
});

// In-memory storage for demo (use Redis or database in production)
let transactionHistory = [];
let fraudPatterns = new Map();
let userRiskProfiles = new Map();

// Transaction validation middleware
const validateTransaction = (req, res, next) => {
    const { amount, currency, merchant, cardType, location, userId } = req.body;
    
    const errors = [];
    
    if (!amount || amount <= 0) errors.push('Invalid amount');
    if (!currency || !['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'].includes(currency)) errors.push('Invalid currency');
    if (!merchant || merchant.length < 2) errors.push('Invalid merchant name');
    if (!cardType || !['credit', 'debit', 'prepaid'].includes(cardType)) errors.push('Invalid card type');
    if (!location || location.length < 2) errors.push('Invalid location');
    if (!userId || userId.length < 3) errors.push('Invalid user ID');
    
    if (errors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    
    next();
};

// Enhanced fraud analysis function
async function performFraudAnalysis(transactionData) {
    try {
        // Get historical data for the user
        const userHistory = transactionHistory.filter(t => t.userId === transactionData.userId);
        const userProfile = userRiskProfiles.get(transactionData.userId) || createUserProfile(transactionData.userId);
        
        // Pre-analysis risk factors
        const preAnalysis = calculatePreAnalysisRisk(transactionData, userHistory, userProfile);
        
        // Construct enhanced prompt for Gemini
        const prompt = `As AEGIS, an advanced AI fraud detection engine, analyze this transaction with the provided context.

TRANSACTION DATA:
${JSON.stringify(transactionData, null, 2)}

USER CONTEXT:
- Historical transactions: ${userHistory.length}
- Average transaction amount: ${userHistory.length > 0 ? (userHistory.reduce((sum, t) => sum + t.amount, 0) / userHistory.length).toFixed(2) : 'N/A'}
- Most common locations: ${getMostCommonLocations(userHistory).join(', ') || 'N/A'}
- Most common merchants: ${getMostCommonMerchants(userHistory).join(', ') || 'N/A'}
- User risk level: ${userProfile.riskLevel}
- Recent suspicious activity: ${userProfile.recentSuspiciousActivity}

PRE-ANALYSIS RISK FACTORS:
${JSON.stringify(preAnalysis, null, 2)}

FRAUD PATTERNS DATABASE:
Current known fraud patterns: ${Array.from(fraudPatterns.keys()).join(', ')}

Your response MUST be a valid JSON object with this exact structure:
{
    "riskScore": number_between_0_and_100,
    "summary": "Detailed one-sentence explanation of the decision including key risk factors",
    "status": "Approved" | "Flagged" | "Denied",
    "confidence": number_between_0_and_100,
    "riskFactors": {
        "LocationAnomaly": number_between_0_and_100,
        "AmountDeviation": number_between_0_and_100,
        "MerchantRisk": number_between_0_and_100,
        "TimePattern": number_between_0_and_100,
        "CardUsage": number_between_0_and_100,
        "UserBehavior": number_between_0_and_100,
        "VelocityCheck": number_between_0_and_100
    },
    "recommendations": [
        "Specific recommendations based on the analysis"
    ],
    "alertLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
}

Consider:
1. Transaction amount vs user's spending patterns
2. Location consistency with user's history
3. Merchant category and reputation
4. Transaction timing patterns
5. Card usage frequency and patterns
6. Velocity of transactions
7. Known fraud indicators
8. Regional risk factors

Provide realistic, contextual analysis based on all available data.`;

        console.log('Sending request to Gemini AI...');
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const analysisText = response.text();
        console.log('Gemini AI response received successfully');
        
        // Clean and parse the response
        const cleanedText = analysisText.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(cleanedText);
        
        // Validate the analysis response
        if (!isValidAnalysis(analysis)) {
            throw new Error('Invalid analysis response format');
        }
        
        // Post-process the analysis
        const enhancedAnalysis = enhanceAnalysis(analysis, transactionData, preAnalysis);
        
        // Update user profile and fraud patterns
        updateUserProfile(transactionData.userId, transactionData, enhancedAnalysis);
        updateFraudPatterns(transactionData, enhancedAnalysis);
        
        return enhancedAnalysis;
        
    } catch (error) {
        console.error('Fraud analysis error:', error);
        console.error('Error details:', error.message);
        if (error.response) {
            console.error('API Response:', error.response.data);
        }
        
        // Fallback analysis if Gemini fails
        return generateFallbackAnalysis(transactionData);
    }
}

// Helper functions
function calculatePreAnalysisRisk(transaction, userHistory, userProfile) {
    const risks = {
        amountAnomaly: 0,
        locationAnomaly: 0,
        timeAnomaly: 0,
        velocityRisk: 0,
        merchantRisk: 0
    };
    
    if (userHistory.length > 0) {
        // Amount analysis
        const avgAmount = userHistory.reduce((sum, t) => sum + t.amount, 0) / userHistory.length;
        const amountDeviation = Math.abs(transaction.amount - avgAmount) / avgAmount;
        risks.amountAnomaly = Math.min(amountDeviation * 50, 100);
        
        // Location analysis
        const commonLocations = getMostCommonLocations(userHistory);
        risks.locationAnomaly = commonLocations.includes(transaction.location) ? 0 : 60;
        
        // Velocity analysis (transactions in last hour)
        const recentTransactions = userHistory.filter(t => 
            new Date(t.timestamp) > new Date(Date.now() - 3600000)
        );
        risks.velocityRisk = Math.min(recentTransactions.length * 25, 100);
    }
    
    // Time analysis
    const hour = new Date().getHours();
    risks.timeAnomaly = (hour < 6 || hour > 23) ? 40 : 0;
    
    // Merchant risk (simplified)
    const riskMerchants = ['casino', 'betting', 'crypto', 'atm', 'wire transfer'];
    risks.merchantRisk = riskMerchants.some(risk => 
        transaction.merchant.toLowerCase().includes(risk)
    ) ? 80 : 20;
    
    return risks;
}

function getMostCommonLocations(transactions) {
    const locationCounts = {};
    transactions.forEach(t => {
        locationCounts[t.location] = (locationCounts[t.location] || 0) + 1;
    });
    
    return Object.entries(locationCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(entry => entry[0]);
}

function getMostCommonMerchants(transactions) {
    const merchantCounts = {};
    transactions.forEach(t => {
        merchantCounts[t.merchant] = (merchantCounts[t.merchant] || 0) + 1;
    });
    
    return Object.entries(merchantCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(entry => entry[0]);
}

function createUserProfile(userId) {
    const profile = {
        userId,
        riskLevel: 'LOW',
        totalTransactions: 0,
        suspiciousTransactions: 0,
        recentSuspiciousActivity: false,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
    };
    
    userRiskProfiles.set(userId, profile);
    return profile;
}

function isValidAnalysis(analysis) {
    const required = ['riskScore', 'summary', 'status', 'riskFactors'];
    return required.every(field => analysis.hasOwnProperty(field)) &&
           typeof analysis.riskScore === 'number' &&
           analysis.riskScore >= 0 && analysis.riskScore <= 100 &&
           ['Approved', 'Flagged', 'Denied'].includes(analysis.status);
}

function enhanceAnalysis(analysis, transaction, preAnalysis) {
    // Add additional metadata
    analysis.timestamp = new Date().toISOString();
    analysis.transactionId = generateTransactionId();
    analysis.processingTime = Math.random() * 500 + 100; // Simulated processing time
    analysis.version = '2.1';
    analysis.preAnalysisRisk = preAnalysis;
    
    // Ensure all required risk factors are present
    const defaultRiskFactors = {
        LocationAnomaly: 0,
        AmountDeviation: 0,
        MerchantRisk: 0,
        TimePattern: 0,
        CardUsage: 0,
        UserBehavior: 0,
        VelocityCheck: 0
    };
    
    analysis.riskFactors = { ...defaultRiskFactors, ...analysis.riskFactors };
    
    return analysis;
}

function updateUserProfile(userId, transaction, analysis) {
    const profile = userRiskProfiles.get(userId) || createUserProfile(userId);
    
    profile.totalTransactions++;
    profile.lastUpdated = new Date().toISOString();
    
    if (analysis.riskScore > 70) {
        profile.suspiciousTransactions++;
        profile.recentSuspiciousActivity = true;
    }
    
    // Update risk level based on suspicious transaction ratio
    const suspiciousRatio = profile.suspiciousTransactions / profile.totalTransactions;
    if (suspiciousRatio > 0.3) profile.riskLevel = 'HIGH';
    else if (suspiciousRatio > 0.1) profile.riskLevel = 'MEDIUM';
    else profile.riskLevel = 'LOW';
    
    userRiskProfiles.set(userId, profile);
}

function updateFraudPatterns(transaction, analysis) {
    if (analysis.riskScore > 80) {
        const patternKey = `${transaction.merchant}-${transaction.location}-${Math.floor(transaction.amount / 100) * 100}`;
        const existingPattern = fraudPatterns.get(patternKey) || { count: 0, avgRisk: 0 };
        
        existingPattern.count++;
        existingPattern.avgRisk = (existingPattern.avgRisk + analysis.riskScore) / 2;
        existingPattern.lastSeen = new Date().toISOString();
        
        fraudPatterns.set(patternKey, existingPattern);
    }
}

function generateFallbackAnalysis(transaction) {
    // Simple rule-based fallback
    let riskScore = 20; // Base risk
    
    // High amount check
    if (transaction.amount > 5000) riskScore += 30;
    else if (transaction.amount > 1000) riskScore += 15;
    
    // Time check
    const hour = new Date().getHours();
    if (hour < 6 || hour > 22) riskScore += 20;
    
    // Merchant check
    const riskMerchants = ['casino', 'betting', 'crypto'];
    if (riskMerchants.some(risk => transaction.merchant.toLowerCase().includes(risk))) {
        riskScore += 40;
    }
    
    let status = 'Approved';
    if (riskScore > 70) status = 'Denied';
    else if (riskScore > 40) status = 'Flagged';
    
    return {
        riskScore: Math.min(riskScore, 100),
        summary: `Fallback analysis: ${status} based on rule-based evaluation`,
        status,
        confidence: 75,
        riskFactors: {
            LocationAnomaly: 25,
            AmountDeviation: transaction.amount > 1000 ? 60 : 20,
            MerchantRisk: 30,
            TimePattern: hour < 6 || hour > 22 ? 70 : 10,
            CardUsage: 20,
            UserBehavior: 25,
            VelocityCheck: 15
        },
        recommendations: ['Manual review recommended', 'Verify user identity'],
        alertLevel: riskScore > 70 ? 'HIGH' : riskScore > 40 ? 'MEDIUM' : 'LOW',
        fallback: true
    };
}

function generateTransactionId() {
    return 'TXN-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        uptime: process.uptime()
    });
});

// Main fraud analysis endpoint
app.post('/api/analyze-fraud', fraudAnalysisLimiter, validateTransaction, async (req, res) => {
    try {
        const transactionData = {
            ...req.body,
            timestamp: new Date().toISOString(),
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
        };
        
        console.log('Processing fraud analysis for transaction:', transactionData.userId);
        
        const analysis = await performFraudAnalysis(transactionData);
        
        // Store transaction in history
        transactionHistory.push({
            ...transactionData,
            analysis
        });
        
        // Keep only last 1000 transactions in memory
        if (transactionHistory.length > 1000) {
            transactionHistory = transactionHistory.slice(-1000);
        }
        
        res.json({
            success: true,
            analysis,
            metadata: {
                processedAt: new Date().toISOString(),
                processingTime: analysis.processingTime
            }
        });
        
    } catch (error) {
        console.error('Fraud analysis error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error during fraud analysis',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Analysis temporarily unavailable'
        });
    }
});

// Get user transaction history
app.get('/api/user/:userId/history', (req, res) => {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    const userTransactions = transactionHistory
        .filter(t => t.userId === userId)
        .slice(offset, offset + parseInt(limit))
        .map(t => ({
            ...t,
            // Remove sensitive data
            ipAddress: undefined,
            userAgent: undefined
        }));
    
    res.json({
        success: true,
        transactions: userTransactions,
        total: transactionHistory.filter(t => t.userId === userId).length
    });
});

// Get user risk profile
app.get('/api/user/:userId/profile', (req, res) => {
    const { userId } = req.params;
    const profile = userRiskProfiles.get(userId);
    
    if (!profile) {
        return res.status(404).json({
            success: false,
            error: 'User profile not found'
        });
    }
    
    res.json({
        success: true,
        profile
    });
});

// Get fraud statistics
app.get('/api/stats', (req, res) => {
    const stats = {
        totalTransactions: transactionHistory.length,
        approvedTransactions: transactionHistory.filter(t => t.analysis.status === 'Approved').length,
        flaggedTransactions: transactionHistory.filter(t => t.analysis.status === 'Flagged').length,
        deniedTransactions: transactionHistory.filter(t => t.analysis.status === 'Denied').length,
        averageRiskScore: transactionHistory.length > 0 
            ? transactionHistory.reduce((sum, t) => sum + t.analysis.riskScore, 0) / transactionHistory.length 
            : 0,
        uniqueUsers: new Set(transactionHistory.map(t => t.userId)).size,
        fraudPatternsDetected: fraudPatterns.size,
        highRiskUsers: Array.from(userRiskProfiles.values()).filter(p => p.riskLevel === 'HIGH').length
    };
    
    res.json({
        success: true,
        stats,
        generatedAt: new Date().toISOString()
    });
});

// Get recent transactions (for dashboard)
app.get('/api/recent-transactions', (req, res) => {
    const { limit = 20 } = req.query;
    
    const recentTransactions = transactionHistory
        .slice(-limit)
        .reverse()
        .map(t => ({
            id: t.analysis.transactionId,
            amount: t.amount,
            currency: t.currency,
            merchant: t.merchant,
            location: t.location,
            status: t.analysis.status,
            riskScore: t.analysis.riskScore,
            timestamp: t.timestamp
        }));
    
    res.json({
        success: true,
        transactions: recentTransactions
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 AEGIS Fraud Detection Server running on port ${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    console.log(`🔍 API Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;