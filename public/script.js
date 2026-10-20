const API_URL = '/api';

// State
let products = [];
let cart = [];
let soldCost = 0; // Costo de lo ya vendido (para el total invertido)
let realizedProfit = 0; // Ganancia ya obtenida de las ventas

// DOM Elements
const posProducts = document.getElementById('pos-products');
const cartItemsContainer = document.getElementById('cart-items');
const cartTotalEl = document.getElementById('cart-total');
const checkoutBtn = document.getElementById('btn-checkout');
const toastEl = document.getElementById('toast');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadProducts();
    loadSales();
    initRealtime();
});

// Realtime: refresh when anyone (you or your friend) changes data
async function initRealtime() {
    try {
        const { url, anonKey } = await (await fetch(`${API_URL}/config`)).json();
        const client = window.supabase.createClient(url, anonKey);
        let timer;
        const refresh = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 300); };
        client.channel('erp-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => refresh(loadProducts))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => refresh(() => { loadSales(); loadProducts(); loadReports(); }))
            .subscribe();
    } catch (e) {
        console.error('Realtime no disponible', e);
    }
}

// Navigation Logic
function initNavigation() {
    const navLinks = document.querySelectorAll('.nav-links li');
    const views = document.querySelectorAll('.view');

    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navLinks.forEach(l => l.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));

            link.classList.add('active');
            const targetId = link.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');

            if (targetId === 'inventory-view') loadProducts();
            if (targetId === 'sales-view') loadSales();
            if (targetId === 'pos-view') loadProducts();
            if (targetId === 'reports-view') loadReports();
        });
    });
}

// Format Currency
function formatMoney(amount) {
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount);
}

// Show Toast
function showToast(message, isError = false) {
    toastEl.textContent = message;
    if (isError) toastEl.classList.add('error');
    else toastEl.classList.remove('error');
    
    toastEl.classList.add('show');
    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3000);
}

// Load Products from API
async function loadProducts() {
    try {
        const res = await fetch(`${API_URL}/products`);
        products = await res.json();
        renderPOSProducts();
        renderInventory();
    } catch (error) {
        console.error('Error loading products:', error);
        showToast('Error conectando con la base de datos', true);
    }
}

// POS View Render
function renderPOSProducts() {
    posProducts.innerHTML = '';
    
    products.forEach(p => {
        const isOutOfStock = p.stock <= 0;
        
        const card = document.createElement('div');
        card.className = `product-card ${isOutOfStock ? 'out-of-stock' : ''}`;
        card.innerHTML = `
            <div>
                <div class="product-cat">${p.category}</div>
                <h3 class="product-name">${p.name}</h3>
            </div>
            <div class="product-footer">
                <span class="product-price">${formatMoney(p.price)}</span>
                <span class="product-stock">${p.stock} disp.</span>
            </div>
        `;
        
        if (!isOutOfStock) {
            card.addEventListener('click', () => addToCart(p));
        }
        
        posProducts.appendChild(card);
    });
}

// Cart Logic
function addToCart(product) {
    const existing = cart.find(item => item.id === product.id);
    
    if (existing) {
        if (existing.quantity < product.stock) {
            existing.quantity++;
        } else {
            showToast('No hay más stock disponible', true);
            return;
        }
    } else {
        cart.push({ ...product, quantity: 1 });
    }
    
    renderCart();
}

function updateCartItem(id, delta) {
    const item = cart.find(i => i.id === id);
    if (!item) return;
    
    const product = products.find(p => p.id === id);
    
    const newQuantity = item.quantity + delta;
    
    if (newQuantity <= 0) {
        cart = cart.filter(i => i.id !== id);
    } else if (newQuantity > product.stock) {
        showToast('No hay más stock disponible', true);
        return;
    } else {
        item.quantity = newQuantity;
    }
    
    renderCart();
}

function renderCart() {
    cartItemsContainer.innerHTML = '';
    
    if (cart.length === 0) {
        cartItemsContainer.innerHTML = '<div class="empty-cart">El carrito está vacío</div>';
        checkoutBtn.disabled = true;
        cartTotalEl.textContent = '$0';
        return;
    }
    
    let total = 0;
    
    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        total += itemTotal;
        
        const el = document.createElement('div');
        el.className = 'cart-item';
        el.innerHTML = `
            <div class="cart-item-info">
                <h4>${item.name}</h4>
                <p>${formatMoney(item.price)} x ${item.quantity}</p>
            </div>
            <div class="cart-item-actions">
                <button class="qty-btn" onclick="updateCartItem(${item.id}, -1)">-</button>
                <span style="width: 20px; text-align: center; font-weight: bold;">${item.quantity}</span>
                <button class="qty-btn" onclick="updateCartItem(${item.id}, 1)">+</button>
            </div>
        `;
        cartItemsContainer.appendChild(el);
    });
    
    cartTotalEl.textContent = formatMoney(total);
    checkoutBtn.disabled = false;
}

// Make updateCartItem available globally for inline onclick
window.updateCartItem = updateCartItem;

// Checkout
checkoutBtn.addEventListener('click', async () => {
    if (cart.length === 0) return;
    
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const total_cost = cart.reduce((sum, item) => sum + (item.cost * item.quantity), 0);
    const profit = total - total_cost;
    const paymentMethod = document.querySelector('input[name="payment"]:checked').value;
    
    const items = cart.map(item => ({
        product_id: item.id,
        quantity: item.quantity,
        price: item.price,
        cost: item.cost
    }));
    
    try {
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = 'Procesando...';
        
        const res = await fetch(`${API_URL}/sales`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ total, total_cost, profit, payment_method: paymentMethod, items })
        });
        
        if (res.ok) {
            showToast('¡Venta completada con éxito!');
            cart = [];
            renderCart();
            await loadProducts(); // Refresh stock
        } else {
            throw new Error('Error al guardar la venta');
        }
    } catch (error) {
        console.error(error);
        showToast('Error al procesar la venta', true);
    } finally {
        checkoutBtn.textContent = 'Completar Venta';
    }
});

// Inventory Management
function renderInventory() {
    const tbody = document.getElementById('inventory-table-body');
    const costEl = document.getElementById('inventory-cost');
    const profitEl = document.getElementById('inventory-profit');
    
    if (!tbody) return;
    
    tbody.innerHTML = '';
    let totalCost = 0;
    let expectedProfit = 0;
    
    products.forEach(p => {
        // Calculate valuation
        totalCost += (p.cost * p.stock);
        expectedProfit += ((p.price - p.cost) * p.stock);
        
        const tr = document.createElement('tr');
        
        const stockStatus = p.stock > 10 ? 'badge-success' : 'badge-warning';
        
        tr.innerHTML = `
            <td style="font-weight: 600;">${p.name}</td>
            <td><span class="badge" style="background: rgba(255,255,255,0.1); border: 1px solid var(--border)">${p.category}</span></td>
            <td>
                <div style="display: flex; align-items: center; gap: 4px;">
                    <span style="color: var(--text-muted)">$</span>
                    <input type="number" class="stock-input" style="width: 70px;" id="cost-${p.id}" value="${p.cost}" min="0" step="0.01">
                </div>
            </td>
            <td>
                <div style="display: flex; align-items: center; gap: 4px;">
                    <span style="color: var(--text-muted)">$</span>
                    <input type="number" class="stock-input" style="width: 70px;" id="price-${p.id}" value="${p.price}" min="0" step="0.01">
                </div>
            </td>
            <td>
                <span class="badge ${stockStatus}">${p.stock}</span>
            </td>
            <td>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="number" class="stock-input" id="stock-${p.id}" value="${p.stock}" min="0">
                    <button class="btn-sm" onclick="updateProduct(${p.id})">Guardar</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    // Invertido = costo del stock actual + costo de lo ya vendido
    if (costEl) costEl.textContent = formatMoney(totalCost + soldCost);
    if (profitEl) profitEl.textContent = formatMoney(expectedProfit);
    const realizedEl = document.getElementById('inventory-realized');
    if (realizedEl) realizedEl.textContent = formatMoney(realizedProfit);
}

window.updateProduct = async function(id) {
    const newStock = parseInt(document.getElementById(`stock-${id}`).value, 10);
    const newCost = parseFloat(document.getElementById(`cost-${id}`).value);
    const newPrice = parseFloat(document.getElementById(`price-${id}`).value);
    
    if (isNaN(newStock) || newStock < 0 || isNaN(newCost) || isNaN(newPrice)) {
        showToast('Valores inválidos', true);
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/products/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stock: newStock, cost: newCost, price: newPrice })
        });
        
        if (res.ok) {
            showToast('Producto actualizado');
            loadProducts();
        } else {
            throw new Error('Update failed');
        }
    } catch (err) {
        showToast('Error actualizando producto', true);
    }
}

// Sales History
async function loadSales() {
    try {
        const res = await fetch(`${API_URL}/sales`);
        const sales = await res.json();

        const summary = await (await fetch(`${API_URL}/sales/sold-cost`)).json();
        soldCost = summary.soldCost || 0;
        realizedProfit = summary.realizedProfit || 0;
        renderInventory();
        
        const tbody = document.getElementById('sales-table-body');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        sales.forEach(s => {
            const date = new Date(s.date).toLocaleString('es-CL');
            const paymentIcon = s.payment_method === 'Efectivo' ? '💵 Efectivo' : '💳 Transferencia';
            
            const detailText = s.items && s.items.length > 0 
                ? s.items.map(i => `<span style="white-space: nowrap;">${i.quantity}x ${i.name}</span>`).join('<br>') 
                : 'Sin detalles';
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="color: var(--text-muted)">#${s.id.toString().padStart(4, '0')}</td>
                <td>${date}</td>
                <td style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.4;">${detailText}</td>
                <td><span class="badge" style="background: rgba(138, 43, 226, 0.1); color: var(--primary-light); border: 1px solid rgba(138, 43, 226, 0.2)">${paymentIcon}</span></td>
                <td style="font-weight: 800; color: var(--primary-light)">${formatMoney(s.total)}</td>
                <td style="font-weight: 600; color: var(--success)">${formatMoney(s.profit || 0)}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error('Error loading sales:', error);
    }
}

// Add Product Modal Logic
const addProductModal = document.getElementById('add-product-modal');
const btnOpenAddProduct = document.getElementById('btn-open-add-product');
const btnCloseModal = document.getElementById('btn-close-modal');
const addProductForm = document.getElementById('add-product-form');

if (btnOpenAddProduct) {
    btnOpenAddProduct.addEventListener('click', () => {
        addProductModal.classList.add('show');
    });
}

if (btnCloseModal) {
    btnCloseModal.addEventListener('click', () => {
        addProductModal.classList.remove('show');
    });
}

if (addProductForm) {
    addProductForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('new-product-name').value;
        const category = document.getElementById('new-product-category').value;
        const cost = parseFloat(document.getElementById('new-product-cost').value);
        const price = parseFloat(document.getElementById('new-product-price').value);
        const stock = parseInt(document.getElementById('new-product-stock').value, 10);
        
        try {
            const submitBtn = addProductForm.querySelector('button[type="submit"]');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Guardando...';
            
            const res = await fetch(`${API_URL}/products`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, category, cost, price, stock })
            });
            
            if (res.ok) {
                showToast('Producto añadido exitosamente');
                addProductForm.reset();
                addProductModal.classList.remove('show');
                loadProducts(); // Refresh tables and POS
            } else {
                throw new Error('Error al añadir producto');
            }
        } catch (error) {
            console.error(error);
            showToast('Error guardando el producto', true);
        } finally {
            const submitBtn = addProductForm.querySelector('button[type="submit"]');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Guardar Producto';
        }
    });
}

// ===== Reports =====
let reportSales = [];
let reportPeriod = 'day';

document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        reportPeriod = btn.dataset.period;
        renderReports();
    });
});

async function loadReports() {
    try {
        reportSales = await (await fetch(`${API_URL}/reports/sales`)).json();
        renderReports();
    } catch (e) {
        console.error('Error cargando reportes', e);
    }
}

const pad = n => String(n).padStart(2, '0');
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Returns { key (sortable), label } for a date in the chosen period (local time)
function periodOf(date, period) {
    const d = new Date(date);
    if (period === 'month') {
        return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
    }
    if (period === 'week') {
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // lunes
        const end = new Date(start); end.setDate(start.getDate() + 6);
        const f = x => `${pad(x.getDate())}/${pad(x.getMonth() + 1)}`;
        return { key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, label: `${f(start)} - ${f(end)}` };
    }
    return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` };
}

function renderReports() {
    const groups = {};
    let tot = { revenue: 0, cost: 0, profit: 0, sales: 0, units: 0 };

    reportSales.forEach(s => {
        const { key, label } = periodOf(s.date, reportPeriod);
        const g = groups[key] || (groups[key] = { label, revenue: 0, cost: 0, profit: 0, sales: 0, units: 0, products: {} });
        const units = (s.items || []).reduce((n, i) => n + i.quantity, 0);
        g.revenue += Number(s.total) || 0;
        g.cost += Number(s.total_cost) || 0;
        g.profit += Number(s.profit) || 0;
        g.sales += 1;
        g.units += units;
        (s.items || []).forEach(i => { g.products[i.name] = (g.products[i.name] || 0) + i.quantity; });
        tot.revenue += Number(s.total) || 0;
        tot.cost += Number(s.total_cost) || 0;
        tot.profit += Number(s.profit) || 0;
        tot.sales += 1;
        tot.units += units;
    });

    document.getElementById('rep-revenue').textContent = formatMoney(tot.revenue);
    document.getElementById('rep-cost').textContent = formatMoney(tot.cost);
    document.getElementById('rep-profit').textContent = formatMoney(tot.profit);
    document.getElementById('rep-count').textContent = `${tot.sales} / ${tot.units}`;

    const keys = Object.keys(groups).sort();
    const chart = document.getElementById('report-chart');
    const tbody = document.getElementById('report-table-body');

    if (keys.length === 0) {
        chart.innerHTML = '<p class="subtitle" style="text-align:center; width:100%;">Aún no hay ventas registradas.</p>';
        tbody.innerHTML = '';
        return;
    }

    // Chart: last 12 periods, bars = ingresos, inner bar = ganancia
    const recent = keys.slice(-12);
    const max = Math.max(...recent.map(k => groups[k].revenue), 1);
    chart.innerHTML = recent.map(k => {
        const g = groups[k];
        return `
            <div class="chart-col" title="${g.label}\nIngresos: ${formatMoney(g.revenue)}\nGanancia: ${formatMoney(g.profit)}">
                <span class="chart-value">${formatMoney(g.profit)}</span>
                <div class="chart-bar" style="height: ${(g.revenue / max) * 100}%">
                    <div class="chart-bar-profit" style="height: ${g.revenue ? (g.profit / g.revenue) * 100 : 0}%"></div>
                </div>
                <span class="chart-label">${g.label}</span>
            </div>`;
    }).join('') + `
        <div class="chart-legend"><span><i class="lg-rev"></i>Ingresos</span><span><i class="lg-pro"></i>Ganancia</span></div>`;

    // Table: newest first
    tbody.innerHTML = keys.slice().reverse().map(k => {
        const g = groups[k];
        const top = Object.entries(g.products).sort((a, b) => b[1] - a[1])[0];
        return `
            <tr>
                <td style="font-weight: 600;">${g.label}</td>
                <td>${g.sales}</td>
                <td>${g.units}</td>
                <td style="font-weight: 800; color: var(--primary-light)">${formatMoney(g.revenue)}</td>
                <td style="color: var(--text-muted)">${formatMoney(g.cost)}</td>
                <td style="font-weight: 600; color: var(--success)">${formatMoney(g.profit)}</td>
                <td style="font-size: 0.85rem; color: var(--text-muted)">${top ? `${top[0]} (${top[1]})` : '-'}</td>
            </tr>`;
    }).join('');
}
