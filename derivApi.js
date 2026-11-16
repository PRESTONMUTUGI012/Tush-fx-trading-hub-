class DerivAPIConnector {
    constructor(numericAppId = "1089") {
        this.appId = /^\d+$/.test(String(numericAppId)) ? String(numericAppId) : "1089";
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.liveWsReceiving = {};
        this.activeToken = null;
        this.accounts = [];
        this.subscribers = {};
        this.multiSubscribers = {};
        this.fallbackInterval = null;
        this.simPrices = {};
        this.simPips = {};
        this.onBalanceUpdate = null;
        this.onContractPurchased = null;
    }

    extractOAuthTokensFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const accounts = [];
        let i = 1;
        while (params.has(`acct${i}`) && params.has(`token${i}`)) {
            const acct = params.get(`acct${i}`);
            const token = params.get(`token${i}`);
            const cur = params.get(`cur${i}`) || "USD";
            const isVirtual = acct.startsWith("VRTC");
            accounts.push({ account: acct, token: token, currency: cur, isVirtual });
            i++;
        }
        if (accounts.length > 0) {
            this.accounts = accounts;
            localStorage.setItem("elhadart_deriv_accounts", JSON.stringify(accounts));
            window.history.replaceState({}, document.title, window.location.pathname);
        } else {
            const saved = localStorage.getItem("elhadart_deriv_accounts");
            if (saved) {
                try { this.accounts = JSON.parse(saved); } catch (e) {}
            }
        }
        return this.accounts;
    }

    connect(assetList = []) {
        this.extractOAuthTokensFromUrl();
        this.startHybridFallback(assetList);
        return new Promise((resolve) => {
            const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
            try {
                this.ws = new WebSocket(endpoint);
            } catch (e) {
                resolve(true);
                return;
            }

            this.ws.onopen = () => {
                this.isConnected = true;
                if (this.accounts.length > 0) {
                    const demoAcc = this.accounts.find(a => a.isVirtual) || this.accounts[0];
                    this.authorize(demoAcc.token);
                }
                Object.keys(this.multiSubscribers).forEach((sym, i) => {
                    setTimeout(() => {
                        if (this.ws.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
                        }
                    }, i * 35);
                });
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.msg_type === 'authorize' && data.authorize) {
                        this.isAuthorized = true;
                        this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
                        if (this.onBalanceUpdate) {
                            this.onBalanceUpdate({ balance: data.authorize.balance, loginid: data.authorize.loginid });
                        }
                    } else if (data.msg_type === 'tick' && data.tick) {
                        this.liveWsReceiving[data.tick.symbol] = Date.now();
                        this.processTick(data.tick);
                    } else if (data.msg_type === 'balance' && data.balance && this.onBalanceUpdate) {
                        this.onBalanceUpdate(data.balance);
                    } else if (data.msg_type === 'buy' && data.buy && this.onContractPurchased) {
                        this.onContractPurchased(data.buy);
                    }
                } catch (err) {}
            };

            this.ws.onclose = () => {
                this.isConnected = false;
            };

            resolve(true);
        });
    }

    switchAccountMode(mode) {
        if (this.accounts.length === 0) return null;
        const target = mode === 'real'
            ? this.accounts.find(a => !a.isVirtual)
            : this.accounts.find(a => a.isVirtual);
        if (target) {
            this.authorize(target.token);
            return target;
        }
        return null;
    }

    authorize(token) {
        if (!token) return;
        this.activeToken = token;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ authorize: token }));
        }
    }

    buyContract({ symbol, contractType, stake, duration = 5, durationUnit = "t", barrier = null, currency = "USD" }) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) return false;
        const parameters = {
            amount: Number(stake),
            basis: "stake",
            contract_type: contractType,
            currency: currency,
            duration: Number(duration),
            duration_unit: durationUnit,
            symbol: symbol
        };
        if (barrier !== null && barrier !== undefined && !["DIGITEVEN", "DIGITODD", "CALL", "PUT", "MULTUP"].includes(contractType)) {
            parameters.barrier = String(barrier);
        }
        if (contractType === "ACCU") {
            parameters.growth_rate = Number(barrier) || 0.03;
            delete parameters.barrier;
        }
        this.ws.send(JSON.stringify({ buy: 1, price: Number(stake), parameters: parameters }));
        return true;
    }

    startHybridFallback(assetList = []) {
        if (this.fallbackInterval) return;
        assetList.forEach(a => {
            this.simPrices[a.symbol] = a.base;
            this.simPips[a.symbol] = a.pip;
        });

        this.fallbackInterval = setInterval(() => {
            const now = Date.now();
            Object.keys(this.simPrices).forEach(sym => {
                if (this.liveWsReceiving[sym] && (now - this.liveWsReceiving[sym] < 2500)) return;
                const pip = this.simPips[sym] || 2;
                const volatilityFactor = pip >= 5 ? 0.00018 : (pip === 3 ? 0.015 : 0.28);
                const step = (Math.random() - 0.48) * volatilityFactor;
                this.simPrices[sym] = Number(Math.max(0.0001, this.simPrices[sym] + step).toFixed(pip));
                this.processTick({
                    symbol: sym,
                    quote: this.simPrices[sym],
                    epoch: Math.floor(now / 1000),
                    pip_size: pip
                });
            });
        }, 280);
    }

    processTick(tick) {
        if (this.subscribers[tick.symbol]) this.subscribers[tick.symbol](tick);
        if (this.multiSubscribers[tick.symbol]) this.multiSubscribers[tick.symbol](tick);
    }

    subscribeTicks(symbol, cb) {
        this.subscribers[symbol] = cb;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        }
    }

    subscribeMultipleTicks(arr, cb) {
        arr.forEach((sym, i) => {
            this.multiSubscribers[sym] = cb;
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                setTimeout(() => { this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 })); }, i * 35);
            }
        });
    }
}
