// Job orders: spectacles made to a prescription, tracked from "Ordered" through the lab to delivery.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, today, waLink, debounce } from '../core/utils.js';
import { money, pager } from '../core/views.js';
import { getSettings } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Optical from '../services/optical.js';
import { rxTable } from '../optical/rx.js';
import { printDocument } from '../printer/printer.js';

const $ = window.jQuery;
const { ORDER_STATUS: ST, ORDER_FLOW } = Optical;
const TABS = [['active', 'Active'], ['new', 'Ordered'], ['lab', 'In lab'], ['ready', 'Ready'], ['delivered', 'Delivered']];

const dueInfo = (o) => {
  if (o.orderStatus === 'delivered') return { text: o.order.deliveredAt ? `Delivered ${fmtDate(o.order.deliveredAt.slice(0, 10))}` : 'Delivered', cls: 'ok' };
  if (!o.order.deliveryDate) return { text: 'No date set', cls: 'muted' };
  const d = Optical.daysUntil(o.order.deliveryDate);
  if (o.orderStatus === 'ready') return { text: `Ready · due ${fmtDate(o.order.deliveryDate)}`, cls: 'ok' };
  if (d < 0) return { text: `${-d} day${d === -1 ? '' : 's'} overdue`, cls: 'late' };
  if (d === 0) return { text: 'Due today', cls: 'soon' };
  if (d === 1) return { text: 'Due tomorrow', cls: 'soon' };
  return { text: `Due ${fmtDate(o.order.deliveryDate)}`, cls: 'muted' };
};

// Urdu WhatsApp messages (customers read Urdu script on WhatsApp). Amounts stay in Latin digits.
function message(o, due) {
  const shop = getSettings().business.name; const cur = getSettings().currency;
  const dueLine = due > 0.004 ? `\nباقی رقم: ${cur} ${fmtNum(due)}` : '';
  if (o.orderStatus === 'ready') return `السلام علیکم ${o.customerName}،\nآپ کا چشمہ (آرڈر ${o.number}) تیار ہے۔ براہِ کرم ${shop} سے وصول کر لیں۔${dueLine}\nشکریہ`;
  if (o.orderStatus === 'delivered') return `السلام علیکم ${o.customerName}،\nہم سے خریداری کا شکریہ۔ ${shop}`;
  return `السلام علیکم ${o.customerName}،\nآپ کا آرڈر ${o.number} تیار ہو رہا ہے۔ ڈیلیوری کی تاریخ: ${fmtDate(o.order.deliveryDate)}۔\n${shop}`;
}

async function render(el, route) {
  const $el = $(el).off();
  let tab = TABS.some(([k]) => k === route[0]) ? route[0] : 'active';
  $el.html(UI.pageHeader('Job Orders', Auth.can('sale.create') ? '<a class="btn btn-primary btn-sm" href="#/pos"><i class="bi bi-plus-lg"></i> New sale</a>' : '') + `
    <div class="order-tabs chips mb-2"></div>
    <div class="input-group mb-3"><span class="input-group-text bg-body"><i class="bi bi-search"></i></span><input type="search" class="form-control q" placeholder="Search customer, phone or order no…"></div>
    <div class="orders-list"></div>`);

  let orders = []; let items = new Map(); let bal = new Map();
  const load = async () => {
    const [active, delivered] = await Promise.all([
      Optical.ordersByStatus(['new', 'lab', 'ready']),
      Optical.ordersByStatus(['delivered']),
    ]);
    delivered.sort((a, b) => (b.order.deliveredAt || '').localeCompare(a.order.deliveredAt || ''));
    orders = [...active, ...delivered.slice(0, 40)];
    const ids = orders.map((o) => o.id);
    const all = await idb.read(['saleItems'], (t) => Promise.all(ids.map((id) => t.getAllByIndex('saleItems', 'saleId', id))));
    items = new Map(ids.map((id, i) => [id, all[i].sort((a, b) => a.line - b.line)]));
    bal = await Posting.allBalances();
    draw();
  };

  const draw = () => {
    const q = ($el.find('.q').val() || '').toLowerCase();
    const count = (k) => orders.filter((o) => (k === 'active' ? o.orderStatus !== 'delivered' : o.orderStatus === k)).length;
    $el.find('.order-tabs').html(TABS.map(([k, l]) => `<span class="chip ${tab === k ? 'active' : ''}" data-tab="${k}">${l}${k !== 'delivered' ? ` <b class="cnt">${count(k)}</b>` : ''}</span>`).join(''));
    const list = orders.filter((o) => (tab === 'active' ? o.orderStatus !== 'delivered' : o.orderStatus === tab)
      && (!q || `${o.number} ${o.customerName} ${Catalog.party('customers', o.customerId)?.phone || ''}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.orderStatus === 'delivered' ? 0 : (a.order.deliveryDate || '9').localeCompare(b.order.deliveryDate || '9')));
    pager($el.find('.orders-list'), list, (o) => {
      const cust = Catalog.party('customers', o.customerId);
      const lines = items.get(o.id) || [];
      const due = bal.get('C:' + o.customerId)?.balance || 0;
      const di = dueInfo(o); const st = ST[o.orderStatus];
      const idx = ORDER_FLOW.indexOf(o.orderStatus);
      const wa = cust?.phone ? waLink(cust.phone, message(o, due)) : '';
      return `<div class="order-card s-${o.orderStatus}" data-id="${esc(o.id)}">
        <div class="oc-top">${UI.avatar(o.customerName, 'round')}
          <div class="oc-who"><div class="nm">${esc(o.customerName)}</div><div class="sub">${esc(o.number)}${cust?.phone ? ' · ' + esc(cust.phone) : ''}</div></div>
          <div class="oc-due ${di.cls}">${esc(di.text)}</div></div>
        <div class="steps" aria-label="Progress: ${st.label}">${ORDER_FLOW.map((k, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><i class="bi bi-${i < idx ? 'check-lg' : ORDER_STATUS_ICON[k]}"></i><span>${ST[k].label}</span></div>`).join('<div class="bar"></div>')}</div>
        <div class="oc-items">${lines.slice(0, 3).map((l) => `<span class="it"><i class="bi bi-dot"></i>${esc(l.name)}</span>`).join('')}${lines.length > 3 ? `<span class="it text-body-secondary">+${lines.length - 3} more</span>` : ''}</div>
        ${o.order.rx && Optical.rxHasData(o.order.rx) ? `<div class="oc-rx">${rxTable(o.order.rx, { compact: true })}</div>` : ''}
        ${o.order.labNote ? `<div class="oc-note"><i class="bi bi-chat-left-text me-1"></i>${esc(o.order.labNote)}</div>` : ''}
        <div class="oc-foot"><div class="oc-money"><span class="text-body-secondary">Total</span> <b class="money">${money(o.total)}</b>${due > 0.004 ? ` <span class="badge text-bg-warning ms-1">Customer due ${money(due)}</span>` : ''}</div>
          <div class="oc-actions">
            ${wa ? `<a class="btn btn-sm btn-light btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp"><i class="bi bi-whatsapp"></i></a>` : ''}
            ${cust?.phone ? `<a class="btn btn-sm btn-light" href="tel:${esc(cust.phone)}" aria-label="Call"><i class="bi bi-telephone"></i></a>` : ''}
            <button class="btn btn-sm btn-light btn-print" aria-label="Print"><i class="bi bi-printer"></i></button>
            <a class="btn btn-sm btn-light" href="#/sales/${encodeURIComponent(o.id)}" aria-label="View sale"><i class="bi bi-eye"></i></a>
            ${due > 0.004 && o.orderStatus !== 'delivered' && Auth.can('voucher.create') ? '<button class="btn btn-sm btn-outline-success btn-collect"><i class="bi bi-cash-coin me-1"></i>Collect</button>' : ''}
            ${st.next && Auth.can('sale.create') ? `<button class="btn btn-sm btn-primary btn-next"><i class="bi bi-${ORDER_STATUS_ICON[st.next]} me-1"></i>${st.nextLabel}</button>` : ''}
            ${o.orderStatus === 'delivered' ? '<button class="btn btn-sm btn-link btn-undo">Undo</button>' : ''}
          </div></div></div>`;
    }, 30, UI.emptyState(tab === 'delivered' ? 'No delivered orders yet' : 'No job orders here', 'clipboard2-pulse',
      Auth.can('sale.create') ? '<div class="small mt-1">Add a prescription to a sale with the <i class="bi bi-eyeglasses"></i> button on the sale screen.</div><a class="btn btn-primary btn-sm mt-3" href="#/pos">New sale</a>' : ''));
  };

  const find = (e) => orders.find((o) => o.id === $(e.currentTarget).closest('.order-card').data('id'));
  $el.on('click', '[data-tab]', function () { tab = this.dataset.tab; history.replaceState(null, '', `#/orders/${tab === 'active' ? '' : tab}`); draw(); });
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('click', '.btn-next', async (e) => {
    const o = find(e); const next = ST[o.orderStatus].next;
    if (next === 'delivered') {
      const due = bal.get('C:' + o.customerId)?.balance || 0;
      if (due > 0.004 && !await UI.confirmDialog(`${o.customerName} still owes ${money(due)}. Deliver anyway?`, { title: 'Balance due', okLabel: 'Deliver anyway', okClass: 'btn-warning' })) return;
    }
    const $card = $(e.currentTarget).closest('.order-card').addClass('pulse-ok');
    try { await Optical.setOrderStatus(o.id, next); UI.toast(`${o.number} → ${ST[next].label}`); await load(); if (next === 'ready' && Optical.daysUntil(o.order.deliveryDate) !== null) UI.toast('Tap the WhatsApp button to tell the customer', 'info', 3500); } catch (err) { $card.removeClass('pulse-ok'); UI.toastError(err); }
  });
  $el.on('click', '.btn-undo', async (e) => {
    const o = find(e);
    if (!await UI.confirmDialog(`Move ${o.number} back to "Ready"?`)) return;
    try { await Optical.setOrderStatus(o.id, 'ready'); await load(); } catch (err) { UI.toastError(err); }
  });
  $el.on('click', '.btn-print', (e) => { const o = find(e); printDocument('sale', o); });
  $el.on('click', '.btn-collect', async (e) => {
    const o = find(e);
    const { newVoucher } = await import('./vouchers.js');
    if (await newVoucher({ type: 'receipt', counterAccountId: Posting.partyAccount('customers', o.customerId) })) await load();
  });
  const refresh = () => { if (location.hash.startsWith('#/orders')) load().catch(() => {}); };
  document.addEventListener('data:changed', refresh);
  render.off = () => document.removeEventListener('data:changed', refresh);
  await load();
}

const ORDER_STATUS_ICON = { new: 'hourglass-split', lab: 'tools', ready: 'check2-circle', delivered: 'bag-check' };

export default {
  async render(el, { params }) { render.off?.(); await render(el, params); },
  destroy() { render.off?.(); render.off = null; },
};
