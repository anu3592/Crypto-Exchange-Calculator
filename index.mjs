import express from 'express';
import ccxt from 'ccxt';
import axios from 'axios';

import rateLimit from 'express-rate-limit';

const app = express();
const PORT = 3000;




const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 50, 
    message: { error: "Too many requests, please try again after a minute." }
});
app.use('/api/', limiter);

const priorityIds = ['binance', 'bybit', 'okx', 'kucoin', 'gateio'];
const exchangeInstances = {};
priorityIds.forEach(id => {
    if (ccxt.exchanges.includes(id)) {
        exchangeInstances[id] = new ccxt[id]({ enableRateLimit: true });
    }
});

async function getForexRates() {
    try {
        const res = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
        return res.data.rates;
    } catch (e) { return { "INR": 83.50, "AED": 3.67, "USD": 1 }; }
}

app.get('/api/v1/arbitrage/:coin', async (req, res) => {
    const coin = req.params.coin.toUpperCase();
    const inputAmount = parseFloat(req.query.amount) || 100000;
    const localCurr = (req.query.currency || 'INR').toUpperCase();
    
    
    const forexFeePercent = req.query.forex_fee ? parseFloat(req.query.forex_fee) : 2.5;
    const forexFeeDecimal = forexFeePercent / 100;

    try {
        const rates = await getForexRates();
        const usdToLocal = rates[localCurr] || 1;

        
        const initialUSDT = (inputAmount / usdToLocal) * (1 - forexFeeDecimal);

        
        const fetchWithTimeout = async (id) => {
            const timeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), 12000)
            );
            const request = exchangeInstances[id].fetchTicker(`${coin}/USDT`);
            return Promise.race([request, timeout]);
        };
        const pricePromises = Object.keys(exchangeInstances).map(async (id) => {
            try {
                
                const ticker = await fetchWithTimeout(id);
                return { id, price: ticker.last, status: 'success' };
            } catch (e) { return { id, status: 'error' }; }
        });
        
        const results = await Promise.all(pricePromises);
        const validMarkets = results.filter(r => r.status === 'success');

        if (validMarkets.length < 2) throw new Error("Not enough market data");

        const sorted = validMarkets.sort((a, b) => a.price - b.price);
        const bestBuy = sorted[0];
        const bestSell = sorted[sorted.length - 1];

        
        const cryptoFees = 0.006; 
        const finalUSDT = (initialUSDT / bestBuy.price) * bestSell.price * (1 - cryptoFees);
        const netProfitUSDT = finalUSDT - initialUSDT;

        
        const exitFee = localCurr === 'INR' ? (0.01 + forexFeeDecimal) : forexFeeDecimal; 
        const finalLocalAmount = (finalUSDT * usdToLocal) * (1 - exitFee);
        const netProfitLocal = finalLocalAmount - inputAmount;

        res.json({
            config: {
                coin,
                investment: `${inputAmount} ${localCurr}`,
                applied_forex_fee: `${forexFeePercent}%`
            },
            input_summary: {
                initial_investment: `${inputAmount} ${localCurr}`,
                converted_to_usdt: `${initialUSDT.toFixed(2)} USDT`
            },
            arbitrage_deal: {
                route: `Buy on ${bestBuy.id.toUpperCase()} ➔ Sell on ${bestSell.id.toUpperCase()}`,
                buy_price: `$${bestBuy.price}`,
                sell_price: `$${bestSell.price}`,
                gross_gap: `${((bestSell.price - bestBuy.price) / bestBuy.price * 100).toFixed(2)}%`
            },
            profit_loss_report: {
                net_usdt_profit: `${netProfitUSDT.toFixed(2)} USDT`,
                net_local_profit: `${netProfitLocal.toFixed(2)} ${localCurr}`,
                roi_percentage: `${((netProfitLocal / inputAmount) * 100).toFixed(2)}%`
            },
            execution_checklist: [
                `1. Buy USDT using your local bank (Est. ${forexFeePercent}% fee applied)`,
                `2. Transfer USDT to ${bestBuy.id}`,
                `3. Execute trade and transfer to ${bestSell.id}`,
                "4. Convert back to local currency and withdraw",
                localCurr === 'INR' ? "Note: 1% TDS is included in local profit calculation." : "Note: Standard exit fees applied."
            ]
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    console.log("Ping received: Server is Warm!");
    res.status(200).json({
        status: "Active",
        message: "Server is awake and ready for arbitrage!",
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => console.log(`Master API: http://localhost:${PORT}/api/v1/arbitrage/BTC?amount=100000&currency=INR&forex_fee=2`));