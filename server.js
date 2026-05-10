require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { getDb } = require('./db/schema');
const StockDataService = require('./services/stockService');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Global Error Handlers (prevents server crash) ======
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught Exception: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Unhandled Rejection: ${reason}`);
});

// ====== Helper: Get local network IP ======
function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// View engine setup (for server-rendered pages)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== API Routes ====================

/**
 * GET / - Main dashboard page
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * GET /api/stocks - List all active stocks
 */
app.get('/api/stocks', (req, res) => {
  try {
    const db = getDb();
    const stocks = db.prepare(`
      SELECT * FROM stocks WHERE is_active = 1 ORDER BY created_at DESC
    `).all();

    // Get latest price records
    const stmt = db.prepare(`
      SELECT * FROM stock_prices 
      WHERE stock_id = ? 
      ORDER BY recorded_at DESC 
      LIMIT 1
    `);

    const stocksWithData = stocks.map(stock => {
      const latestPrice = stmt.get(stock.id);
      return {
        ...stock,
        price_history_count: latestPrice ? 1 : 0,
      };
    });

    res.json({ success: true, data: stocksWithData });
  } catch (error) {
    console.error('[API] Error fetching stocks:', error);
    res.status(500).json({ success: false, error: '获取股票列表失败' });
  }
});

/**
 * GET /api/stocks/:id/detail - Get stock detail with price history
 */
app.get('/api/stocks/:id/detail', (req, res) => {
  try {
    const db = getDb();
    const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(req.params.id);
    
    if (!stock) {
      return res.status(404).json({ success: false, error: '股票不存在' });
    }

    const priceHistory = db.prepare(`
      SELECT price, high, low, change_percent, recorded_at 
      FROM stock_prices 
      WHERE stock_id = ? 
      ORDER BY recorded_at ASC
    `).all(req.params.id);

    res.json({ success: true, data: { ...stock, priceHistory } });
  } catch (error) {
    console.error('[API] Error fetching stock detail:', error);
    res.status(500).json({ success: false, error: '获取股票详情失败' });
  }
});

/**
 * POST /api/stocks/search - Search stock by code, name, or pinyin
 * Uses fuzzy search when query is not a plain code
 */
app.post('/api/stocks/search', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, error: '请输入股票代码、名称或拼音' });
    }

    const query = code.toString().trim();
    
    // Try fuzzy search first (supports name, pinyin, code)
    const results = await StockDataService.searchStocks(query);
    
    if (results.length === 0) {
      // Fallback: try as direct stock code
      try {
        const cleanCode = query;
        const market = StockDataService.detectMarket(cleanCode);
        const stockData = await StockDataService.fetchStockData(cleanCode, market);
        
        const db = getDb();
        const existing = db.prepare('SELECT id, name FROM stocks WHERE code = ? AND is_active = 1').get(cleanCode);

        return res.json({
          success: true,
          data: {
            ...stockData,
            alreadyTracked: !!existing,
            searchResults: [],
          },
        });
      } catch (e) {
        return res.status(404).json({ success: false, error: `未找到股票"${query}"`, searchResults: [] });
      }
    }

    // Return search results - always, even with 1 result
    const searchResults = results.slice(0, 8);
    
    // Get real-time price for the first result
    const first = searchResults[0];
    let firstData = null;
    try {
      firstData = await StockDataService.fetchStockData(first.code, first.market);
    } catch (e) {
      // ignore real-time fetch error
    }

    // Check if any are already tracked
    const db = getDb();
    const trackedCodes = db.prepare('SELECT code FROM stocks WHERE is_active = 1').all()
      .map(s => s.code);

    res.json({
      success: true,
      data: {
        ...(firstData || searchResults[0]),
        searchResults: searchResults.map(s => ({
          ...s,
          alreadyTracked: trackedCodes.includes(s.code),
        })),
      },
    });
  } catch (error) {
    console.error('[API] Search error:', error);
    res.status(500).json({ success: false, error: `搜索失败: ${error.message}` });
  }
});

/**
 * POST /api/stocks/historical-price - Get historical closing price for a date
 */
app.post('/api/stocks/historical-price', async (req, res) => {
  try {
    const { code, market, date } = req.body;
    if (!code || !date) {
      return res.status(400).json({ success: false, error: '缺少股票代码或日期' });
    }

    const cleanCode = code.toString().trim();
    const mkt = market || StockDataService.detectMarket(cleanCode);
    const result = await StockDataService.fetchHistoricalPrice(cleanCode, mkt, date);

    if (!result) {
      return res.json({ success: false, error: `未找到 ${cleanCode} 在 ${date} 的价格数据` });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[API] Historical price error:', error);
    res.status(500).json({ success: false, error: '获取历史价格失败' });
  }
});

/**
 * POST /api/stocks/add - Add stock to watchlist (with optional joinDate)
 */
app.post('/api/stocks/add', async (req, res) => {
  try {
    const { code, name: clientName, market: inputMarket, reason, joinDate, category_id } = req.body;
    
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, error: '请输入股票代码' });
    }

    const cleanCode = code.toString().trim();
    const market = inputMarket || StockDataService.detectMarket(cleanCode);

    // Determine the join price based on date
    let joinPrice;
    let stockInfo = { code: cleanCode, market, name: clientName || '' };
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (!joinDate || joinDate === today) {
      // Today: use real-time price
      const stockData = await StockDataService.fetchStockData(cleanCode, market);
      joinPrice = stockData.price;
      stockInfo = { ...stockInfo, ...stockData };
      // Client-provided name takes priority
      if (clientName && clientName !== cleanCode) {
        stockInfo.name = clientName;
      }
    } else {
      // Past date: use historical closing price
      const histData = await StockDataService.fetchHistoricalPrice(cleanCode, market, joinDate);
      if (!histData) {
        return res.status(400).json({
          success: false,
          error: `未找到 ${cleanCode} 在 ${joinDate} 的交易数据，${joinDate} 可能为非交易日`,
        });
      }
      joinPrice = histData.close;
      
      // Try to get name: client provided > search API > real-time API > code
      let stockName = (clientName && clientName !== cleanCode) ? clientName : '';
      if (!stockName) {
        try {
          const searchResults = await StockDataService.searchStocks(cleanCode);
          if (searchResults.length > 0) {
            stockName = searchResults[0].name;
          }
        } catch (e) { /* ignore */ }
      }
      if (!stockName) {
        try {
          const rtData = await StockDataService.fetchStockData(cleanCode, market);
          stockName = rtData.name || cleanCode;
        } catch (e2) { stockName = cleanCode; }
      }
      
      stockInfo = {
        ...stockInfo,
        name: stockName,
        price: joinPrice,
        high: histData.high,
        low: histData.low,
        changePercent: 0, // will be recalculated on first refresh
      };
    }

    // Check duplicate
    const db = getDb();
    const existing = db.prepare('SELECT id FROM stocks WHERE code = ? AND is_active = 1').get(cleanCode);
    if (existing) {
      return res.status(409).json({ success: false, error: `"${stockInfo.name}(${cleanCode})" 已在追踪列表中` });
    }

    // Insert stock
    const result = db.prepare(`
      INSERT INTO stocks (code, market, name, reason, category_id, added_price, current_price, highest_price, lowest_price, change_percent, join_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleanCode,
      stockInfo.market || market,
      stockInfo.name || cleanCode,
      reason || '',
      category_id || null,
      joinPrice,
      joinPrice,
      stockInfo.high || joinPrice,
      stockInfo.low || joinPrice,
      stockInfo.changePercent || 0,
      joinDate || new Date().toISOString().split('T')[0]
    );

    // Record initial price
    db.prepare(`
      INSERT INTO stock_prices (stock_id, price, high, low, change_percent)
      VALUES (?, ?, ?, ?, ?)
    `).run(result.lastInsertRowid, joinPrice, stockInfo.high || joinPrice, stockInfo.low || joinPrice, stockInfo.changePercent || 0);

    res.json({
      success: true,
      message: `成功添加 "${stockInfo.name || cleanCode}(${cleanCode})" 到追踪列表`,
      data: { id: result.lastInsertRowid, ...stockInfo, price: joinPrice },
    });
  } catch (error) {
    console.error('[API] Add error:', error);
    res.status(500).json({ success: false, error: `添加失败: ${error.message}` });
  }
});

/**
 * GET /api/stocks/:id/kline - Get K-line chart data
 * Query params: type=daily|weekly|monthly|intraday, limit=number
 */
app.get('/api/stocks/:id/kline', async (req, res) => {
  try {
    const db = getDb();
    const stock = db.prepare('SELECT id, code, market FROM stocks WHERE id = ?').get(req.params.id);
    if (!stock) {
      return res.status(404).json({ success: false, error: '股票不存在' });
    }

    const type = req.query.type || 'daily';
    const limit = parseInt(req.query.limit) || 60;

    if (type === 'intraday') {
      let data = await StockDataService.fetchIntradayData(stock.code, stock.market);
      // If no intraday data (weekend/holiday), try last few trading days
      if (!data || data.length === 0) {
        // Try fetching daily K-line to find the last trading day
        const dailyData = await StockDataService.fetchKLineData(stock.code, stock.market, 'daily', 5);
        if (dailyData && dailyData.length > 0) {
          // Get the last trading day's date and fetch intraday for that day
          const lastDay = dailyData[dailyData.length - 1];
          // For last trading day, we don't have intraday data, so return the daily candles as a line
          data = dailyData.slice(-5).map(d => ({
            time: d.date,
            price: d.close,
            open: d.open,
            high: d.high,
            low: d.low,
            volume: d.volume,
          }));
        }
      }
      return res.json({ success: true, data });
    }

    const data = await StockDataService.fetchKLineData(stock.code, stock.market, type, limit);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[API] K-line error:', error);
    res.status(500).json({ success: false, error: '获取K线数据失败' });
  }
});

/**
 * GET /api/chart-image - Proxy Sina Finance chart images (bypass mixed content)
 * Query params: type=min|daily|weekly|monthly, symbol=sh600519
 */
app.get('/api/chart-image', async (req, res) => {
  const { type, symbol } = req.query;
  if (!type || !symbol) return res.status(400).end();
  // Redirect to Sina Finance CDN - works in browsers over HTTP
  res.redirect(`https://image.sinajs.cn/newchart/${type}/n/${symbol}.gif`);
});

// ====== Research Reports ======

/**
 * GET /api/research - List research reports
 */
app.get('/api/research', (req, res) => {
  try {
    const db = getDb();
    const { stock_code, search } = req.query;
    let sql = 'SELECT * FROM research_reports';
    const conditions = [];
    const params = [];

    if (stock_code) {
      conditions.push('stock_code = ?');
      params.push(stock_code);
    }
    if (search) {
      conditions.push('(title LIKE ? OR stock_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    const reports = db.prepare(sql).all(...params);
    // Return only needed fields
    const simplified = reports.map(r => ({
      id: r.id, title: r.title, stock_name: r.stock_name,
      summary: r.summary, created_at: r.created_at,
    }));
    res.json({ success: true, data: simplified });
  } catch (error) {
    console.error('[API] Research list error:', error);
    res.status(500).json({ success: false, error: '获取研报列表失败' });
  }
});

/**
 * POST /api/research - Add research report
 */
app.post('/api/research', (req, res) => {
  try {
    const { title, stock_name, summary } = req.body;
    
    // 标题改为可选，摘要为必填
    if (!summary || !summary.trim()) {
      return res.status(400).json({ success: false, error: '请输入内容摘要' });
    }

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO research_reports (title, stock_name, summary)
      VALUES (?, ?, ?)
    `).run(
      (title || '').trim() || '无标题',
      (stock_name || '').trim(),
      summary.trim(),
    );

    const report = db.prepare('SELECT id, title, stock_name, summary, created_at FROM research_reports WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, message: '研报已添加', data: report });
  } catch (error) {
    console.error('[API] Research add error:', error);
    res.status(500).json({ success: false, error: '添加研报失败' });
  }
});

/**
 * DELETE /api/research/:id - Delete research report
 */
app.delete('/api/research/:id', (req, res) => {
  try {
    const db = getDb();
    const report = db.prepare('SELECT * FROM research_reports WHERE id = ?').get(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, error: '研报不存在' });
    }
    db.prepare('DELETE FROM research_reports WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: '研报已删除' });
  } catch (error) {
    console.error('[API] Research delete error:', error);
    res.status(500).json({ success: false, error: '删除研报失败' });
  }
});

// ====== Data Import / Export ======

/**
 * GET /api/export - Export all data as JSON
 */
app.get('/api/export', (req, res) => {
  try {
    const db = getDb();
    const exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      categories: db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all(),
      stocks: db.prepare('SELECT * FROM stocks WHERE is_active = 1 ORDER BY created_at ASC').all(),
      stock_prices: db.prepare('SELECT sp.* FROM stock_prices sp JOIN stocks s ON sp.stock_id = s.id WHERE s.is_active = 1 ORDER BY sp.recorded_at ASC').all(),
      research_reports: db.prepare('SELECT * FROM research_reports ORDER BY created_at DESC').all(),
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="stock-tracker-backup-${new Date().toISOString().split('T')[0]}.json"`);
    res.json({ success: true, data: exportData });
  } catch (error) {
    console.error('[API] Export error:', error);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

/**
 * POST /api/import - Import data from JSON backup
 * Expects: { data: { version, categories, stocks, stock_prices, research_reports } }
 */
app.post('/api/import', (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !data.stocks) {
      return res.status(400).json({ success: false, error: '无效的导入数据格式' });
    }

    const db = getDb();
    
    // Use transaction for atomic import
    const doImport = db.transaction(() => {
      // Clear existing data (order matters for FK constraints)
      db.prepare('DELETE FROM stock_prices').run();
      db.prepare('DELETE FROM stocks').run();
      db.prepare('DELETE FROM categories').run();
      db.prepare('DELETE FROM research_reports').run();

      // Import categories
      const insertCat = db.prepare(`
        INSERT INTO categories (id, name, color, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      if (data.categories) {
        for (const cat of data.categories) {
          insertCat.run(cat.id, cat.name, cat.color || '#6366f1', cat.sort_order || 0, cat.created_at || new Date().toISOString());
        }
      }

      // Import stocks
      const insertStock = db.prepare(`
        INSERT INTO stocks (id, code, market, name, category_id, reason, notes, tag,
          added_price, current_price, highest_price, lowest_price, max_drawdown,
          change_percent, daily_change, join_date, alert_threshold, alert_type, alert_direction, alert_triggered,
          is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      for (const stock of data.stocks) {
        insertStock.run(
          stock.id, stock.code, stock.market || 'sh', stock.name,
          stock.category_id || null, stock.reason || '', stock.notes || '', stock.tag || '',
          stock.added_price, stock.current_price || stock.added_price,
          stock.highest_price || stock.added_price, stock.lowest_price || stock.added_price,
          stock.max_drawdown || 0, stock.change_percent || 0, stock.daily_change || 0,
          stock.join_date || '', stock.alert_threshold || null,
          stock.alert_type || 'percent', stock.alert_direction || 'down', stock.alert_triggered || 0,
          1, stock.created_at || new Date().toISOString()
        );
      }

      // Import stock_prices
      const insertPrice = db.prepare(`
        INSERT INTO stock_prices (stock_id, price, high, low, change_percent, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      if (data.stock_prices) {
        for (const p of data.stock_prices) {
          insertPrice.run(p.stock_id, p.price, p.high || p.price, p.low || p.price, p.change_percent || 0, p.recorded_at || new Date().toISOString());
        }
      }

      // Import research reports
      const insertReport = db.prepare(`
        INSERT INTO research_reports (id, title, stock_name, summary, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      if (data.research_reports) {
        for (const r of data.research_reports) {
          insertReport.run(r.id, r.title || '无标题', r.stock_name || '', r.summary || '', r.created_at || new Date().toISOString());
        }
      }
    });

    doImport();
    res.json({ success: true, message: `成功导入 ${data.stocks.length} 只股票、${data.categories?.length || 0} 个分类、${data.research_reports?.length || 0} 篇研报` });
  } catch (error) {
    console.error('[API] Import error:', error);
    res.status(500).json({ success: false, error: `导入失败: ${error.message}` });
  }
});

// ====== Tunnel Management (external/public access) ======
let tunnelUrl = null;
let tunnelProcess = null;

/**
 * POST /api/tunnel/start - Start a public tunnel
 * Tries cloudflared first, falls back to localtunnel
 */
app.post('/api/tunnel/start', async (req, res) => {
  // If tunnel already running, return existing URL
  if (tunnelUrl) {
    return res.json({ success: true, url: tunnelUrl });
  }

  // Try cloudflared first (more stable)
  try {
    const { spawn } = require('child_process');
    
    // Check if cloudflared is available
    const cloudflared = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        cloudflared.kill();
        tryLocaltunnel(res);
      }
    }, 15000);

    cloudflared.stderr.on('data', (data) => {
      const output = data.toString();
      console.log('[Cloudflared]', output);
      
      // Parse URL from cloudflared output
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = match[0];
        tunnelProcess = cloudflared;
        
        cloudflared.on('close', () => {
          console.log('[Tunnel] Cloudflared closed');
          tunnelUrl = null;
          tunnelProcess = null;
        });
        
        res.json({ success: true, url: tunnelUrl });
      }
    });

    cloudflared.on('error', () => {
      if (!resolved) {
        clearTimeout(timeout);
        tryLocaltunnel(res);
      }
    });

  } catch (e) {
    // cloudflared not available, try localtunnel
    tryLocaltunnel(res);
  }
});

/**
 * Fallback: try localtunnel
 */
function tryLocaltunnel(res) {
  try {
    const localtunnel = require('localtunnel');
    
    Promise.race([
      localtunnel({ port: PORT }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('超时')), 15000)
      )
    ]).then(tunnel => {
      tunnelUrl = tunnel.url;
      tunnelProcess = tunnel;
      
      console.log(`[Tunnel] Localtunnel URL: ${tunnel.url}`);
      
      tunnel.on('close', () => {
        console.log('[Tunnel] Closed');
        tunnelUrl = null;
        tunnelProcess = null;
      });
      
      res.json({ success: true, url: tunnel.url });
    }).catch(error => {
      console.error('[Tunnel] Localtunnel error:', error.message);
      res.status(500).json({ 
        success: false, 
        error: '无法启动对外分享，请确保已安装 cloudflared 或网络可以访问 localtunnel'
      });
    });
  } catch (e) {
    res.status(500).json({ 
      success: false, 
      error: '未检测到 tunnel 服务，请安装 cloudflared: winget install Cloudflare.cloudflared'
    });
  }
}

/**
 * POST /api/tunnel/stop - Stop the public tunnel
 */
app.post('/api/tunnel/stop', (req, res) => {
  if (tunnelProcess) {
    tunnelProcess.close();
    tunnelProcess = null;
    tunnelUrl = null;
  }
  res.json({ success: true });
});

/**
 * GET /api/tunnel/status - Get tunnel status
 */
app.get('/api/tunnel/status', (req, res) => {
  res.json({ success: true, running: !!tunnelUrl, url: tunnelUrl });
});

/**
 * PUT /api/stocks/:id - Edit stock info (name, reason, notes)
 */
app.put('/api/stocks/:id', (req, res) => {
  try {
    const db = getDb();
    const stock = db.prepare('SELECT * FROM stocks WHERE id = ? AND is_active = 1').get(req.params.id);
    
    if (!stock) {
      return res.status(404).json({ success: false, error: '股票不存在' });
    }

    const { name, reason, notes, tag, alert_threshold, alert_type, alert_direction } = req.body;
    const updateFields = [];
    const updateParams = [];

    if (name !== undefined) {
      updateFields.push('name = ?');
      updateParams.push(name.trim());
    }
    if (reason !== undefined) {
      updateFields.push('reason = ?');
      updateParams.push(reason.trim());
    }
    if (notes !== undefined) {
      updateFields.push('notes = ?');
      updateParams.push(notes.trim());
    }
    if (tag !== undefined) {
      updateFields.push('tag = ?');
      updateParams.push(tag);
    }
    if (alert_threshold !== undefined) {
      updateFields.push('alert_threshold = ?');
      updateParams.push(alert_threshold !== null ? parseFloat(alert_threshold) : null);
      // Reset trigger when threshold changes
      updateFields.push('alert_triggered = 0');
    }
    if (alert_direction !== undefined) {
      updateFields.push('alert_direction = ?');
      updateParams.push(alert_direction);
    }
    if (alert_type !== undefined) {
      updateFields.push('alert_type = ?');
      updateParams.push(alert_type);
    }

    if (updateFields.length === 0) {
      return res.json({ success: true, message: '没有需要更新的字段' });
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateParams.push(req.params.id);

    db.prepare(`UPDATE stocks SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateParams);

    const updated = db.prepare('SELECT * FROM stocks WHERE id = ?').get(req.params.id);
    res.json({ success: true, message: '股票信息已更新', data: updated });
  } catch (error) {
    console.error('[API] Edit error:', error);
    res.status(500).json({ success: false, error: '编辑失败' });
  }
});

/**
 * PUT /api/stocks/:id/category - Move stock to category
 */
app.put('/api/stocks/:id/category', (req, res) => {
  try {
    const db = getDb();
    const stock = db.prepare('SELECT * FROM stocks WHERE id = ? AND is_active = 1').get(req.params.id);
    
    if (!stock) {
      return res.status(404).json({ success: false, error: '股票不存在' });
    }

    const { category_id } = req.body;
    // category_id can be null (uncategorized) or a valid category id
    if (category_id !== null && category_id !== undefined) {
      const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
      if (!cat) {
        return res.status(400).json({ success: false, error: '分类不存在' });
      }
    }

    db.prepare('UPDATE stocks SET category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(category_id || null, req.params.id);

    res.json({ success: true, message: '分类已更新' });
  } catch (error) {
    console.error('[API] Category change error:', error);
    res.status(500).json({ success: false, error: '更新分类失败' });
  }
});

/**
 * POST /api/stocks/:id/alert-reset - Reset alert trigger for a stock
 */
app.post('/api/stocks/:id/alert-reset', (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE stocks SET alert_triggered = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.params.id);
    res.json({ success: true, message: '预警已重置' });
  } catch (error) {
    console.error('[API] Alert reset error:', error);
    res.status(500).json({ success: false, error: '重置预警失败' });
  }
});

/**
 * ===== Category Routes =====
 */

/**
 * GET /api/categories - List all categories with their stocks
 */
app.get('/api/categories', (req, res) => {
  try {
    const db = getDb();
    const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
    
    // Get stocks grouped by category
    const stocksByCategory = {};
    const uncategorizedStocks = db.prepare(`
      SELECT * FROM stocks WHERE is_active = 1 AND category_id IS NULL ORDER BY created_at DESC
    `).all();

    const catStmt = db.prepare(`
      SELECT * FROM stocks WHERE is_active = 1 AND category_id = ? ORDER BY created_at DESC
    `);

    const result = categories.map(cat => {
      const stocks = catStmt.all(cat.id);
      return { ...cat, stocks };
    });

    res.json({
      success: true,
      data: {
        categories: result,
        uncategorized: uncategorizedStocks,
      },
    });
  } catch (error) {
    console.error('[API] Categories error:', error);
    res.status(500).json({ success: false, error: '获取分类列表失败' });
  }
});

/**
 * POST /api/categories - Create a new category
 */
app.post('/api/categories', (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: '请输入分类名称' });
    }

    const db = getDb();
    
    // Get max sort_order
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM categories').get();
    const nextOrder = (maxOrder?.max_order || 0) + 1;

    const result = db.prepare(`
      INSERT INTO categories (name, color, sort_order)
      VALUES (?, ?, ?)
    `).run(name.trim(), color || '#6366f1', nextOrder);

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, message: `分类 "${name}" 已创建`, data: category });
  } catch (error) {
    console.error('[API] Create category error:', error);
    res.status(500).json({ success: false, error: '创建分类失败' });
  }
});

/**
 * PUT /api/categories/:id - Update category
 */
app.put('/api/categories/:id', (req, res) => {
  try {
    const db = getDb();
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!cat) {
      return res.status(404).json({ success: false, error: '分类不存在' });
    }

    const { name, color, sort_order } = req.body;
    const updateFields = [];
    const updateParams = [];

    if (name !== undefined) { updateFields.push('name = ?'); updateParams.push(name.trim()); }
    if (color !== undefined) { updateFields.push('color = ?'); updateParams.push(color); }
    if (sort_order !== undefined) { updateFields.push('sort_order = ?'); updateParams.push(sort_order); }
    
    if (updateFields.length === 0) {
      return res.json({ success: true, message: '没有需要更新的字段' });
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateParams.push(req.params.id);

    db.prepare(`UPDATE categories SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateParams);

    const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    res.json({ success: true, message: '分类已更新', data: updated });
  } catch (error) {
    console.error('[API] Update category error:', error);
    res.status(500).json({ success: false, error: '更新分类失败' });
  }
});

/**
 * DELETE /api/categories/:id - Delete category (stocks become uncategorized)
 */
app.delete('/api/categories/:id', (req, res) => {
  try {
    const db = getDb();
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!cat) {
      return res.status(404).json({ success: false, error: '分类不存在' });
    }

    // Move stocks to uncategorized
    db.prepare('UPDATE stocks SET category_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE category_id = ?')
      .run(req.params.id);
    
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);

    res.json({ success: true, message: `分类 "${cat.name}" 已删除` });
  } catch (error) {
    console.error('[API] Delete category error:', error);
    res.status(500).json({ success: false, error: '删除分类失败' });
  }
});

/**
 * POST /api/categories/reorder - Reorder categories
 * Expects: { order: [{ id: 1, sort_order: 0 }, ...] }
 */
app.post('/api/categories/reorder', (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ success: false, error: '无效的排序数据' });
    }

    const db = getDb();
    const stmt = db.prepare('UPDATE categories SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const reorder = db.transaction((items) => {
      for (const item of items) {
        stmt.run(item.sort_order, item.id);
      }
    });
    reorder(order);
    res.json({ success: true, message: '分类排序已更新' });
  } catch (error) {
    console.error('[API] Reorder error:', error);
    res.status(500).json({ success: false, error: '排序更新失败' });
  }
});

/**
 * DELETE /api/stocks/:id - Remove stock from watchlist
 */
app.delete('/api/stocks/:id', (req, res) => {
  try {
    const db = getDb();
    const stock = db.prepare('SELECT * FROM stocks WHERE id = ? AND is_active = 1').get(req.params.id);
    
    if (!stock) {
      return res.status(404).json({ success: false, error: '股票不存在或已删除' });
    }

    db.prepare('UPDATE stocks SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

    res.json({
      success: true,
      message: `已移除 "${stock.name}(${stock.code})" 从追踪列表`,
    });
  } catch (error) {
    console.error('[API] Delete error:', error);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

/**
 * POST /api/stocks/refresh - Refresh all active stock prices
 */
app.post('/api/stocks/refresh', async (req, res) => {
  try {
    const db = getDb();
    const stocks = db.prepare('SELECT id, code, market, highest_price, lowest_price, added_price, change_percent, alert_threshold, alert_type, alert_direction, alert_triggered FROM stocks WHERE is_active = 1').all();

    if (stocks.length === 0) {
      return res.json({ success: true, message: '没有需要更新的股票' });
    }

    const batchData = await StockDataService.fetchBatchStocks(stocks);
    let updatedCount = 0;

    const updateStmt = db.prepare(`
      UPDATE stocks 
      SET current_price = ?,
          highest_price = ?,
          lowest_price = ?,
          max_drawdown = ?,
          change_percent = ?,
          daily_change = ?,
          alert_triggered = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const insertPriceStmt = db.prepare(`
      INSERT INTO stock_prices (stock_id, price, high, low, change_percent)
      VALUES (?, ?, ?, ?, ?)
    `);

    const updateMany = db.transaction((updates) => {
      for (const update of updates) {
        updateStmt.run(...update.stockParams);
        insertPriceStmt.run(...update.priceParams);
      }
    });

    const updates = [];
    for (const stock of stocks) {
      const key = `${stock.market}${stock.code}`;
      const data = batchData[key];
      
      if (data && data.price > 0) {
        const currentPrice = data.price;
        const highestPrice = Math.max(stock.highest_price || currentPrice, data.high || currentPrice, currentPrice);
        const lowestPrice = Math.min(stock.lowest_price || currentPrice, data.low || currentPrice, currentPrice);
        
        // Max drawdown = (lowest - highest) / highest * 100 (negative value)
        const maxDrawdown = highestPrice > 0 
          ? parseFloat(((lowestPrice - highestPrice) / highestPrice * 100).toFixed(2))
          : 0;

        // ALWAYS calculate change from added price, not from API's daily change
        const changeFromAdded = stock.added_price > 0
          ? parseFloat(((currentPrice - stock.added_price) / stock.added_price * 100).toFixed(2))
          : 0;

        // Check alert threshold (percent or price based)
        let alertTriggered = stock.alert_triggered || 0;
        if (stock.alert_threshold !== null && !alertTriggered) {
          const threshold = parseFloat(stock.alert_threshold);
          const isPriceType = stock.alert_type === 'price';
          if (isPriceType) {
            // Price-based: compare current price to threshold price
            if (stock.alert_direction === 'down' && currentPrice <= threshold) {
              alertTriggered = 1;
            } else if (stock.alert_direction === 'up' && currentPrice >= threshold) {
              alertTriggered = 1;
            }
          } else {
            // Percentage-based: compare change from added price
            if (stock.alert_direction === 'down' && changeFromAdded <= threshold) {
              alertTriggered = 1;
            } else if (stock.alert_direction === 'up' && changeFromAdded >= threshold) {
              alertTriggered = 1;
            }
          }
        }

        updates.push({
          stockParams: [
            currentPrice,
            highestPrice,
            lowestPrice,
            maxDrawdown,
            changeFromAdded,
            data.changePercent || 0,
            alertTriggered,
            stock.id,
          ],
          priceParams: [
            stock.id,
            currentPrice,
            data.high || currentPrice,
            data.low || currentPrice,
            changeFromAdded,
          ],
        });

        updatedCount++;
      }
    }

    if (updates.length > 0) {
      updateMany(updates);
    }

    res.json({
      success: true,
      message: `成功更新 ${updatedCount} 只股票价格`,
    });
  } catch (error) {
    console.error('[API] Refresh error:', error);
    res.status(500).json({ success: false, error: '更新价格失败' });
  }
});

/**
 * GET /api/stocks/refresh-prices - Server-side scheduled refresh
 */
app.get('/api/stocks/refresh-prices', async (req, res) => {
  // This endpoint is called by the scheduler
  try {
    const db = getDb();
    const stocks = db.prepare('SELECT id, code, market, highest_price, lowest_price, added_price, change_percent, alert_threshold, alert_type, alert_direction, alert_triggered FROM stocks WHERE is_active = 1').all();

    if (stocks.length === 0) {
      return res.status(200).end('ok');
    }

    const batchData = await StockDataService.fetchBatchStocks(stocks);

    const updateStmt = db.prepare(`
      UPDATE stocks 
      SET current_price = ?,
          highest_price = ?,
          lowest_price = ?,
          max_drawdown = ?,
          change_percent = ?,
          daily_change = ?,
          alert_triggered = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const insertPriceStmt = db.prepare(`
      INSERT INTO stock_prices (stock_id, price, high, low, change_percent)
      VALUES (?, ?, ?, ?, ?)
    `);

    const updateMany = db.transaction((updates) => {
      for (const update of updates) {
        updateStmt.run(...update.stockParams);
        insertPriceStmt.run(...update.priceParams);
      }
    });

    const updates = [];
    for (const stock of stocks) {
      const key = `${stock.market}${stock.code}`;
      const data = batchData[key];
      
      if (data && data.price > 0) {
        const currentPrice = data.price;
        const highestPrice = Math.max(stock.highest_price || currentPrice, data.high || currentPrice, currentPrice);
        const lowestPrice = Math.min(stock.lowest_price || currentPrice, data.low || currentPrice, currentPrice);
        const maxDrawdown = highestPrice > 0 
          ? parseFloat(((lowestPrice - highestPrice) / highestPrice * 100).toFixed(2))
          : 0;
        const changeFromAdded = stock.added_price > 0
          ? parseFloat(((currentPrice - stock.added_price) / stock.added_price * 100).toFixed(2))
          : 0;

        // Check alert threshold (percent or price based)
        let alertTriggered = stock.alert_triggered || 0;
        if (stock.alert_threshold !== null && !alertTriggered) {
          const threshold = parseFloat(stock.alert_threshold);
          const isPriceType = stock.alert_type === 'price';
          if (isPriceType) {
            // Price-based: compare current price to threshold price
            if (stock.alert_direction === 'down' && currentPrice <= threshold) {
              alertTriggered = 1;
            } else if (stock.alert_direction === 'up' && currentPrice >= threshold) {
              alertTriggered = 1;
            }
          } else {
            // Percentage-based: compare change from added price
            if (stock.alert_direction === 'down' && changeFromAdded <= threshold) {
              alertTriggered = 1;
            } else if (stock.alert_direction === 'up' && changeFromAdded >= threshold) {
              alertTriggered = 1;
            }
          }
        }

        updates.push({
          stockParams: [
            currentPrice, highestPrice, lowestPrice, maxDrawdown,
            changeFromAdded, data.changePercent || 0, alertTriggered, stock.id,
          ],
          priceParams: [
            stock.id, currentPrice, data.high || currentPrice,
            data.low || currentPrice, changeFromAdded,
          ],
        });
      }
    }

    if (updates.length > 0) {
      updateMany(updates);
    }

    res.status(200).end('ok');
  } catch (error) {
    console.error('[Scheduler] Refresh error:', error);
    res.status(200).end('error');
  }
});

// ==================== Start Server ====================

const HOST = '0.0.0.0'; // Bind to all network interfaces
const localIP = getNetworkIP();

app.listen(PORT, HOST, () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       📈 股票追踪助手 v1.0                           ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  本机访问:    http://localhost:${PORT}                    ║`);
  if (localIP) {
    console.log(`║  局域网访问:  http://${localIP}:${PORT}             ║`);
    console.log('║  分享给同一Wi-Fi/局域网下的其他人使用此地址          ║');
  }
  console.log('║  数据源: 腾讯财经 (qt.gtimg.cn)                      ║');
  console.log('║  自动刷新: 每5分钟                                   ║');
  console.log('║                                                      ║');
  console.log('║  ⚠ 关闭此窗口 = 服务停止                              ║');
  console.log('╚══════════════════════════════════════════════════════╝');
});

// Set up auto-refresh every 5 minutes
const REFRESH_INTERVAL = parseInt(process.env.STOCK_UPDATE_INTERVAL) || 300000;
setInterval(async () => {
  console.log(`[${new Date().toLocaleTimeString()}] 自动更新股票价格...`);
  try {
    const db = getDb();
    const stocks = db.prepare('SELECT id, code, market, highest_price, lowest_price, added_price, change_percent, alert_threshold, alert_type, alert_direction, alert_triggered FROM stocks WHERE is_active = 1').all();

    if (stocks.length === 0) return;

    const batchData = await StockDataService.fetchBatchStocks(stocks);

    const updateStmt = db.prepare(`
      UPDATE stocks 
      SET current_price = ?,
          highest_price = ?,
          lowest_price = ?,
          max_drawdown = ?,
          change_percent = ?,
          daily_change = ?,
          alert_triggered = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const insertPriceStmt = db.prepare(`
      INSERT INTO stock_prices (stock_id, price, high, low, change_percent)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const stock of stocks) {
      const key = `${stock.market}${stock.code}`;
      const data = batchData[key];
      
      if (data && data.price > 0) {
        const currentPrice = data.price;
        const highestPrice = Math.max(stock.highest_price || currentPrice, data.high || currentPrice, currentPrice);
        const lowestPrice = Math.min(stock.lowest_price || currentPrice, data.low || currentPrice, currentPrice);
        const maxDrawdown = highestPrice > 0 
          ? parseFloat(((lowestPrice - highestPrice) / highestPrice * 100).toFixed(2))
          : 0;
        const changeFromAdded = stock.added_price > 0
          ? parseFloat(((currentPrice - stock.added_price) / stock.added_price * 100).toFixed(2))
          : 0;

        // Check alert
        let alertTriggered = stock.alert_triggered || 0;
        if (stock.alert_threshold !== null && !alertTriggered) {
          const t = parseFloat(stock.alert_threshold);
          if (stock.alert_direction === 'down' && changeFromAdded <= t) alertTriggered = 1;
          else if (stock.alert_direction === 'up' && changeFromAdded >= t) alertTriggered = 1;
        }

        updateStmt.run(currentPrice, highestPrice, lowestPrice, maxDrawdown,
          changeFromAdded, data.changePercent || 0, alertTriggered, stock.id);
        insertPriceStmt.run(stock.id, currentPrice, data.high || currentPrice,
          data.low || currentPrice, changeFromAdded);
      }
    }

    console.log(`[${new Date().toLocaleTimeString()}] 更新完成`);
  } catch (error) {
    console.error('[Scheduler] Error:', error.message);
  }
}, REFRESH_INTERVAL);
