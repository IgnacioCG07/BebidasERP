require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Auth (contraseña compartida) ---
const APP_PASSWORD = process.env.APP_PASSWORD;
const SECRET = process.env.SUPABASE_SERVICE_KEY || 'dev';
const TOKEN = crypto.createHmac('sha256', SECRET).update(String(APP_PASSWORD)).digest('hex');
const getCookie = (req, name) => (req.headers.cookie || '').split(';').map(c => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

app.post('/api/login', (req, res) => {
    if (!APP_PASSWORD || req.body.password !== APP_PASSWORD) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `erp_auth=${TOKEN}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
    res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'erp_auth=; HttpOnly; Path=/; Max-Age=0');
    res.json({ success: true });
});

app.use((req, res, next) => {
    if (!APP_PASSWORD) return next(); // sin contraseña configurada = modo local abierto
    if (req.path === '/login.html' || getCookie(req, 'erp_auth') === TOKEN) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
    res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// Initialize Supabase (server uses service_role key for writes)
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
    console.error('Faltan variables en .env (ver .env.example)');
    process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Public config for the browser (Realtime). Only the anon key is exposed.
app.get('/api/config', (req, res) => {
    res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// Get all products
app.get('/api/products', async (req, res) => {
    const { data, error } = await db.from('products').select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Update product (stock, price, cost)
app.put('/api/products/:id', async (req, res) => {
    const { stock, price, cost } = req.body;
    const { data, error } = await db.from('products')
        .update({ stock, price, cost }).eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ updated: data.length });
});

// Add new product
app.post('/api/products', async (req, res) => {
    const { name, category, cost, price, stock } = req.body;
    const { data, error } = await db.from('products')
        .insert({ name, category, cost, price, stock }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data.id });
});

// Register a sale (atomic, via Postgres function)
app.post('/api/sales', async (req, res) => {
    const { total, total_cost, profit, payment_method, items } = req.body;
    const { data, error } = await db.rpc('register_sale', {
        p_total: total, p_total_cost: total_cost, p_profit: profit,
        p_payment_method: payment_method, p_items: items
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, saleId: data });
});

// Get recent sales
app.get('/api/sales', async (req, res) => {
    const { data, error } = await db.from('sales')
        .select('*, sale_items(sale_id, quantity, products(name))')
        .order('date', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });

    res.json(data.map(({ sale_items, ...sale }) => ({
        ...sale,
        items: sale_items.map(i => ({ sale_id: i.sale_id, quantity: i.quantity, name: i.products?.name }))
    })));
});

// Total cost of everything sold (all sales, not limited)
app.get('/api/sales/sold-cost', async (req, res) => {
    const { data, error } = await db.from('sales').select('total_cost, profit');
    if (error) return res.status(500).json({ error: error.message });
    res.json({
        soldCost: data.reduce((sum, s) => sum + (Number(s.total_cost) || 0), 0),
        realizedProfit: data.reduce((sum, s) => sum + (Number(s.profit) || 0), 0)
    });
});

// All sales with items, for reports (grouped in the browser)
app.get('/api/reports/sales', async (req, res) => {
    const { data, error } = await db.from('sales')
        .select('id, date, total, total_cost, profit, sale_items(quantity, products(name))')
        .order('date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map(({ sale_items, ...s }) => ({
        ...s,
        items: sale_items.map(i => ({ quantity: i.quantity, name: i.products?.name }))
    })));
});

app.listen(port, () => {
    console.log(`ERP Server running at http://localhost:${port}`);
});
