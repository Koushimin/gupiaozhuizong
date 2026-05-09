const axios = require('axios');
const iconv = require('iconv-lite');

/**
 * Stock Data Service
 * Fetches real-time stock data from Tencent Finance API (qt.gtimg.cn)
 * Supports Shanghai (sh) and Shenzhen (sz) A-shares
 * 
 * API response is GBK encoded, pipe-delimited format:
 * v_sh600519="1~name~code~currentPrice~yesterdayClose~open~...~..."
 */

class StockDataService {
  /**
   * Auto-detect market prefix from stock code
   * 6xxxxx, 688xxx -> sh (Shanghai Main + STAR)
   * 0xxxxx, 3xxxxx -> sz (Shenzhen)
   * 4xxxxx, 8xxxxx -> bj (Beijing)
   */
  static detectMarket(code) {
    const cleanCode = code.toString().trim();
    if (cleanCode.startsWith('6')) return 'sh';
    if (cleanCode.startsWith('0') || cleanCode.startsWith('3')) return 'sz';
    if (cleanCode.startsWith('4') || cleanCode.startsWith('8')) return 'bj';
    return 'sh';
  }

  /**
   * Fetch real-time stock data from Tencent API
   * @param {string} code - Stock code (e.g., '600519')
   * @param {string} market - Market prefix ('sh' or 'sz')
   * @returns {Object} Stock data { name, price, high, low, previousClose, changePercent, changeAmount }
   */
  static async fetchStockData(code, market = null) {
    if (!market) {
      market = this.detectMarket(code);
    }

    const cleanCode = code.toString().trim();
    const url = `https://qt.gtimg.cn/q=${market}${cleanCode}`;

    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://qt.gtimg.cn/',
        },
        responseType: 'arraybuffer',
      });

      // Convert GBK to UTF-8
      const utf8Data = iconv.decode(Buffer.from(response.data), 'GBK');
      return this.parseTencentResponse(utf8Data, cleanCode, market);
    } catch (error) {
      console.error(`[StockService] Error fetching ${market}${cleanCode}:`, error.message);
      throw new Error(`无法获取股票 ${market}${cleanCode} 的数据`);
    }
  }

  /**
   * Parse Tencent API response
   * Response format: v_sh600519="1~name~code~currentPrice~...~..."
   * Pipe-delimited fields (0-indexed):
   *   1=name, 3=currentPrice, 4=yesterdayClose, 5=open,
   *   6=volume, ... , 30=datetime, 31=changeAmount,
   *   32=changePercent, 33=high, 34=low, 
   *   37=turnover(万), 38= turnoverRate
   */
  static parseTencentResponse(utf8Data, code, market) {
    // Extract the value between quotes
    const match = utf8Data.match(/"([^"]+)"/);
    if (!match || !match[1]) {
      throw new Error(`无法解析股票 ${market}${code} 的数据`);
    }

    const fields = match[1].split('~');

    if (fields.length < 40 || !fields[1] || fields[1].trim() === '') {
      throw new Error(`股票 ${market}${code} 数据异常或不存在`);
    }

    const name = fields[1];
    const currentPrice = parseFloat(fields[3]) || 0;
    const previousClose = parseFloat(fields[4]) || 0;
    const open = parseFloat(fields[5]) || 0;
    const high = parseFloat(fields[33]) || 0;
    const low = parseFloat(fields[34]) || 0;
    const changeAmount = parseFloat(fields[31]) || 0;
    const changePercent = parseFloat(fields[32]) || 0;

    return {
      code,
      market,
      name,
      price: currentPrice,
      open,
      high,
      low,
      previousClose,
      changePercent,
      changeAmount,
    };
  }

  /**
   * Fetch batch stock data
   * @param {Array} stocks - Array of { code, market } objects
   * @returns {Object} Map of stock data keyed by "market+code"
   */
  static async fetchBatchStocks(stocks) {
    if (!stocks || stocks.length === 0) return {};

    // Build batch query: q=sh600519,sz000001
    const codes = stocks.map(s => `${s.market}${s.code}`).join(',');
    const url = `https://qt.gtimg.cn/q=${codes}`;

    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://qt.gtimg.cn/',
        },
        responseType: 'arraybuffer',
      });

      // Convert GBK to UTF-8
      const utf8Data = iconv.decode(Buffer.from(response.data), 'GBK');

      const results = {};
      const lines = utf8Data.split('\n').filter(l => l.trim());

      for (const stock of stocks) {
        const key = `${stock.market}${stock.code}`;
        const line = lines.find(l => l.includes(key));
        if (line) {
          try {
            results[key] = this.parseTencentResponse(line, stock.code, stock.market);
          } catch (e) {
            console.error(`[StockService] Failed to parse ${key}:`, e.message);
          }
        }
      }

      return results;
    } catch (error) {
      console.error('[StockService] Batch fetch error:', error.message);
      return {};
    }
  }

  /**
   * ===== FUZZY SEARCH =====
   * Search stocks by code, name, or pinyin initials via East Money API
   * @param {string} query - Search query (code, name, or pinyin)
   * @returns {Array} Matching stocks [{ code, name, pinyin, market }]
   */
  static async searchStocks(query) {
    if (!query || query.trim().length === 0) return [];

    const cleanQuery = query.toString().trim();
    const url = 'https://searchadapter.eastmoney.com/api/suggest/get';

    try {
      const response = await axios.get(url, {
        params: {
          input: cleanQuery,
          type: 14,
          token: 'D43BF722C8E33BDC906FB84D85E326E8',
        },
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        responseType: 'arraybuffer',
      });

      // East Money API returns UTF-8
      const utf8Data = Buffer.from(response.data).toString('utf-8');
      const result = JSON.parse(utf8Data);
      if (!result || !result.QuotationCodeTable || !result.QuotationCodeTable.Data) {
        return [];
      }

      // Filter to A-share stocks (various types for different boards)
      return result.QuotationCodeTable.Data
        .filter(item => {
          // SecurityType: 1=主板A, 2=中小板, 25=科创板, 27=北交所
          const validTypes = ['1', '2', '25', '27'];
          return validTypes.includes(item.SecurityType);
        })
        .map(item => ({
          code: item.Code,
          name: item.Name,
          pinyin: item.PinYin,
          market: item.MarketType === '1' || item.MarketType === '25' ? 'sh' 
                : item.MarketType === '2' || item.MarketType === '0' ? 'sz'
                : 'bj',
          quoteId: item.QuoteID,
        }));
    } catch (error) {
      console.error('[StockService] Search error:', error.message);
      return [];
    }
  }

  /**
   * ===== HISTORICAL PRICE =====
   * Fetch historical daily closing price for a specific date via Sina Finance API
   * @param {string} code - Stock code (e.g., '600519')
   * @param {string} market - 'sh' or 'sz'
   * @param {string} date - Date string in 'YYYY-MM-DD' format
   * @returns {Object|null} { date, close, open, high, low } or null
   */
  static async fetchHistoricalPrice(code, market, date) {
    const cleanCode = code.toString().trim();
    const symbol = `${market}${cleanCode}`;
    
    // Fetch enough daily data to find the target date
    const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

    try {
      const response = await axios.get(url, {
        params: {
          symbol,
          scale: 240, // daily
          datalen: 60, // fetch 60 trading days to cover ~3 months
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://finance.sina.com.cn',
        },
      });

      if (!Array.isArray(response.data) || response.data.length === 0) {
        return null;
      }

      // Try to find exact date match
      const match = response.data.find(d => d.day === date);
      if (match) {
        return {
          date: match.day,
          close: parseFloat(match.close),
          open: parseFloat(match.open),
          high: parseFloat(match.high),
          low: parseFloat(match.low),
          volume: parseInt(match.volume),
        };
      }

      // If exact date not found (e.g., weekend/holiday), use the nearest previous trading day
      const dates = response.data.sort((a, b) => b.day.localeCompare(a.day));
      for (const d of dates) {
        if (d.day < date) {
          return {
            date: d.day,
            close: parseFloat(d.close),
            open: parseFloat(d.open),
            high: parseFloat(d.high),
            low: parseFloat(d.low),
            volume: parseInt(d.volume),
          };
        }
      }

      return null;
    } catch (error) {
      console.error(`[StockService] Historical price error for ${symbol}:`, error.message);
      return null;
    }
  }

  /**
   * ===== K-LINE DATA =====
   * Fetch K-line chart data from Sina Finance API
   * @param {string} code - Stock code
   * @param {string} market - 'sh' or 'sz'
   * @param {string} type - 'daily'|'weekly'|'monthly'|'intraday'
   * @param {number} limit - Number of records to fetch
   * @returns {Array} [{ date, open, close, high, low, volume }]
   */
  static async fetchKLineData(code, market, type = 'daily', limit = 60) {
    const symbol = `${market}${code}`;
    const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

    // Fetch more daily data for aggregation
    const dailyLimit = type === 'monthly' ? 400 : (type === 'weekly' ? 200 : limit);

    try {
      const response = await axios.get(url, {
        params: { symbol, scale: 240, datalen: dailyLimit },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://finance.sina.com.cn',
        },
      });

      if (!Array.isArray(response.data) || response.data.length === 0) {
        return [];
      }

      // Parse daily data
      const dailyData = response.data.map(item => ({
        date: item.day,
        open: parseFloat(item.open) || 0,
        close: parseFloat(item.close) || 0,
        high: parseFloat(item.high) || 0,
        low: parseFloat(item.low) || 0,
        volume: parseInt(item.volume) || 0,
      }));

      // For weekly/monthly, aggregate
      if (type === 'weekly') {
        return this.aggregateKLine(dailyData, 5);
      } else if (type === 'monthly') {
        return this.aggregateKLine(dailyData, 20);
      }

      return dailyData.slice(-limit);
    } catch (error) {
      console.error(`[StockService] K-line error for ${symbol}:`, error.message);
      return [];
    }
  }

  /**
   * Aggregate daily K-line data into larger timeframes
   */
  static aggregateKLine(dailyData, periodDays) {
    const result = [];
    // Data is sorted by date ascending
    for (let i = 0; i < dailyData.length; i += periodDays) {
      const chunk = dailyData.slice(i, i + periodDays);
      if (chunk.length === 0) continue;
      result.push({
        date: chunk[0].date,
        open: chunk[0].open,
        close: chunk[chunk.length - 1].close,
        high: Math.max(...chunk.map(d => d.high)),
        low: Math.min(...chunk.map(d => d.low)),
        volume: chunk.reduce((sum, d) => sum + d.volume, 0),
      });
    }
    return result;
  }

  /**
   * ===== INTRADAY DATA =====
   * Fetch intraday 5-minute K-line data from Sina Finance API
   * @param {string} code - Stock code
   * @param {string} market - 'sh' or 'sz'
   * @returns {Array} [{ time, price }] for time-sharing chart
   */
  static async fetchIntradayData(code, market) {
    const symbol = `${market}${code}`;
    const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

    try {
      const response = await axios.get(url, {
        params: { symbol, scale: 5, datalen: 48 }, // 5-minute candles
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://finance.sina.com.cn',
        },
      });

      if (!Array.isArray(response.data)) return [];

      return response.data.map(item => ({
        time: item.day,
        price: parseFloat(item.close) || 0,
        open: parseFloat(item.open) || 0,
        high: parseFloat(item.high) || 0,
        low: parseFloat(item.low) || 0,
        volume: parseInt(item.volume) || 0,
      }));
    } catch (error) {
      console.error(`[StockService] Intraday error for ${symbol}:`, error.message);
      return [];
    }
  }
}

module.exports = StockDataService;
