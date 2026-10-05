// Customers & suppliers: list, create/edit, ledger/statement, payments.
import * as UI from '../core/ui.js';
import { esc, today, monthStart, debounce, fmtDate, waLink } from '../core/utils.js';
import { balText, dateFilter, bindDateFilter, ledgerTable, pager } from '../core/views.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import { printHTML } from '../printer/printer.js';
import { getSettings } from '../core/settings.js';
import { storageKey } from '../config.js';
import * as Optical from '../services/optical.js';
import * as RxUI from '../optical/rx.js';

const $ = window.jQuery;
const LABEL = { customers: ['Customer', 'Customers', 'Receivable'], suppliers: ['Supplier', 'Suppliers', 'Payable'] };
const RECALL_DAYS = 365; // customers whose last eye test is older than this are due for a recall
const canEdit = (kind) => Auth.can(kind === 'customers' ? 'party.edit' : 'purchase.manage');

export async function editParty(kind, party = null) {
  const [one] = LABEL[kind];
  const p = party || {};
  return UI.formModal({
    title: party ? `Edit ${one.toLowerCase()}` : `New ${one.toLowerCase()}`,
    body: `<div class="row g-2">
      <div class="col-12"><label class="form-label">Name *</label><input name="name" class="form-control" required maxlength="120" value="${esc(p.name)}"></div>
      <div class="col-6"><label class="form-label">Phone</label><input name="phone" type="tel" class="form-control" value="${esc(p.phone)}"></div>
      <div class="col-6"><label class="form-label">Email</label><input name="email" type="email" class="form-control" value="${esc(p.email)}"></div>
      <div class="col-12"><label class="form-label">Address</label><input name="address" class="form-control" value="${esc(p.address)}"></div>
      <div class="col-6"><label class="form-label">Opening ${LABEL[kind][2].toLowerCase()}</label><input name="openingBalance" class="form-control" inputmode="decimal" value="${p.openingBalance || ''}" placeholder="0"><div class="form-text">Use a negative amount for an advance.</div></div>
      <div class="col-6"><label class="form-label">As of date</label><input name="openingDate" type="date" class="form-control" value="${esc(p.openingDate || today())}"></div>
      <div class="col-12"><label class="form-label">Note</label><textarea name="note" class="form-control" rows="2">${esc(p.note)}</textarea></div>
      ${party ? `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="active" id="pa-active" ${p.active ? 'checked' : ''}><label class="form-check-label" for="pa-active">Active</label></div></div>` : ''}
    </div>`,
    onSubmit: (v) => Posting.saveParty(kind, { ...v, id: party?.id, active: party ? v.active : true }),
  });
}

// Picker returning a party, null (none) or undefined (cancelled).
export async function partyPicker(kind, { noneLabel = null } = {}) {
  const bal = await Posting.allBalances();
  const r = await UI.pick({
    title: `Select ${LABEL[kind][0].toLowerCase()}`, noneLabel,
    placeholder: 'Search name or phone…',
    addNew: canEdit(kind) ? { label: `New ${LABEL[kind][0].toLowerCase()}`, create: () => editParty(kind) } : null,
    search: async (q) => Catalog.searchParties(kind, q).map((p) => {
      const b = bal.get(Posting.partyAccount(kind, p.id))?.balance || 0;
      return { id: p.id, title: p.name, subtitle: p.phone || p.email || '', right: b ? balText(b, kind === 'customers').replace(/&amp;/g, '&') : '', value: p };
    }),
  });
  if (r === undefined || r === null) return r;
  return r.value || r; // created parties are returned directly
}

async function renderList(el, kind) {
  const [one, many, balLabel] = LABEL[kind];
  const $el = $(el);
  $el.html(UI.pageHeader(many, canEdit(kind) ? `<button class="btn btn-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i> Add</button>` : '') + `
    <div class="filters"><input type="search" class="form-control flex-grow-2 q" placeholder="Search ${many.toLowerCase()}…">
      <select class="form-select f-status"><option value="active">Active</option><option value="balance">With balance</option>${kind === 'customers' ? '<option value="recall">Eye test due (12m+)</option>' : ''}<option value="inactive">Inactive</option><option value="all">All</option></select></div>
    <div class="small text-body-secondary mb-2 summary"></div>
    <div class="list-card list"></div>`);
  const bal = await Posting.allBalances();
  const debitNormal = kind === 'customers';
  const lastRx = kind === 'customers' ? await Optical.latestRxDates() : new Map();
  const recallCut = new Date(); recallCut.setDate(recallCut.getDate() - RECALL_DAYS);
  const recallDate = recallCut.toISOString().slice(0, 10);
  const draw = () => {
    const q = $el.find('.q').val().toLowerCase();
    const f = $el.find('.f-status').val();
    const list = Catalog.allParties(kind).filter((p) => {
      const b = bal.get(Posting.partyAccount(kind, p.id))?.balance || 0;
      if (f === 'active' && !p.active) return false;
      if (f === 'inactive' && p.active) return false;
      if (f === 'balance' && Math.abs(b) < 0.005) return false;
      if (f === 'recall' && !(p.active && lastRx.get(p.id) && lastRx.get(p.id) < recallDate)) return false;
      return !q || `${p.name} ${p.phone} ${p.email}`.toLowerCase().includes(q);
    }).sort((a, b) => a.name.localeCompare(b.name));
    const total = list.reduce((s, p) => s + (bal.get(Posting.partyAccount(kind, p.id))?.balance || 0), 0);
    $el.find('.summary').html(`${list.length} ${many.toLowerCase()} · Total ${balLabel.toLowerCase()}: <b>${balText(total, debitNormal)}</b>`);
    pager($el.find('.list'), list, (p) => {
      const b = bal.get(Posting.partyAccount(kind, p.id))?.balance || 0;
      return `<a class="list-row" href="#/${kind}/${encodeURIComponent(p.id)}">
        ${UI.avatar(p.name, 'round')}
        <div class="main"><div class="title">${esc(p.name)} ${p.active ? '' : '<span class="badge text-bg-secondary">Inactive</span>'}</div><div class="sub">${esc(p.phone || p.email || '—')}${lastRx.get(p.id) ? ` · <i class="bi bi-eye"></i> ${esc(fmtDate(lastRx.get(p.id)))}` : ''}</div></div>
        <div class="end"><div class="fw-semibold money ${Math.abs(b) > 0.005 ? '' : 'text-body-secondary'}">${balText(b, debitNormal)}</div></div></a>`;
    }, 50, UI.emptyState(`No ${many.toLowerCase()} found`, 'people', canEdit(kind) ? `<button class="btn btn-primary btn-sm mt-3 btn-add">Add ${one.toLowerCase()}</button>` : ''));
  };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f-status', draw);
  $el.on('click', '.btn-add', async () => { const p = await editParty(kind); if (p) location.hash = `#/${kind}/${p.id}`; });
}

async function renderDetail(el, kind, id) {
  const [one, many, balLabel] = LABEL[kind];
  const $el = $(el).off();
  const p = Catalog.party(kind, id);
  if (!p) { $el.html(UI.pageHeader(one, '', `#/${kind}`) + UI.emptyState(`${one} not found`, 'person-x')); return; }
  const acc = Posting.partyAccount(kind, id);
  const debitNormal = kind === 'customers';
  let from = monthStart(); let to = today();
  const payType = kind === 'customers' ? 'receipt' : 'payment';
  const canPay = Auth.can(payType === 'receipt' ? 'voucher.create' : 'account.manage');
  $el.html(UI.pageHeader(p.name, `
      ${canEdit(kind) ? `<button class="btn btn-light btn-sm btn-edit" title="Edit"><i class="bi bi-pencil"></i></button>` : ''}
      ${Auth.can('party.delete') ? `<button class="btn btn-light btn-sm btn-del" title="Delete"><i class="bi bi-trash"></i></button>` : ''}`, `#/${kind}`) + `
    <div class="card stat-card mb-3"><div class="card-body d-flex flex-wrap align-items-center gap-3">
      <div class="flex-grow-1"><div class="stat-label">${balLabel} balance</div><div class="stat-value money bal"></div>
        <div class="small text-body-secondary">${esc([p.phone, p.email, p.address].filter(Boolean).join(' · ') || 'No contact details')}</div></div>
      <div class="d-flex gap-2 flex-wrap">
        ${canPay ? `<button class="btn btn-success btn-pay"><i class="bi bi-cash-coin me-1"></i>${kind === 'customers' ? 'Receive payment' : 'Make payment'}</button>` : ''}
        ${kind === 'customers' && Auth.can('sale.create') ? `<button class="btn btn-outline-primary btn-sell"><i class="bi bi-cart-plus me-1"></i>New sale</button>` : ''}
        ${kind === 'customers' && p.phone && waLink(p.phone) ? `<a class="btn btn-outline-success" href="${esc(waLink(p.phone))}" target="_blank" rel="noopener"><i class="bi bi-whatsapp me-1"></i>WhatsApp</a>` : ''}
        <button class="btn btn-outline-secondary btn-print"><i class="bi bi-printer me-1"></i>Statement</button>
      </div></div></div>
    ${p.active ? '' : '<div class="alert alert-secondary py-2">This account is inactive.</div>'}
    ${kind === 'customers' ? `<div class="section-title mt-0"><h2><i class="bi bi-eye me-1"></i>Eye prescriptions</h2>${Auth.can('party.edit') ? '<button class="btn btn-sm btn-primary btn-rx-add"><i class="bi bi-plus-lg"></i> Add Rx</button>' : ''}</div><div class="rx-list mb-3"></div>` : ''}
    <h2 class="h6">Ledger</h2>
    ${dateFilter(from, to)}
    <div class="card"><div class="card-body p-0 ledger"></div></div>`);
  let led;
  const load = async () => {
    const total = await Posting.accountBalance(acc);
    $el.find('.bal').html(balText(total, debitNormal));
    led = await Posting.ledger(acc, from, to);
    $el.find('.ledger').html(ledgerTable(led, { debitNormal }));
  };
  await load();
  let rxs = [];
  const loadRx = async () => {
    if (kind !== 'customers') return;
    rxs = await Optical.prescriptionsFor(id);
    $el.find('.rx-list').html(rxs.length ? rxs.map((r, i) => `<div class="card rx-item mb-2" data-i="${i}"><div class="card-body py-2">
        <div class="d-flex align-items-center gap-2 mb-2"><div class="icon-chip tint-cyan"><i class="bi bi-eye"></i></div>
          <div class="flex-grow-1 min-w-0"><div class="fw-semibold">${esc(fmtDate(r.date))}${i === 0 ? ' <span class="badge text-bg-success">Latest</span>' : ''}</div>
            <div class="small text-body-secondary text-truncate">${esc([r.purpose, r.doctor, r.note].filter(Boolean).join(' · ') || 'Prescription')}</div></div>
          <div class="dropdown"><button class="btn btn-light btn-sm" data-bs-toggle="dropdown" aria-label="Prescription actions"><i class="bi bi-three-dots-vertical"></i></button><ul class="dropdown-menu dropdown-menu-end">
            ${Auth.can('sale.create') ? '<li><button class="dropdown-item rx-sell"><i class="bi bi-cart-plus me-2"></i>Sell with this Rx</button></li>' : ''}
            <li><button class="dropdown-item rx-print"><i class="bi bi-printer me-2"></i>Print Rx slip</button></li>
            ${Auth.can('party.edit') ? '<li><button class="dropdown-item rx-edit"><i class="bi bi-pencil me-2"></i>Edit</button></li>' : ''}
            ${Auth.can('party.delete') ? '<li><button class="dropdown-item text-danger rx-del"><i class="bi bi-trash me-2"></i>Delete</button></li>' : ''}</ul></div></div>
        ${RxUI.rxTable(r)}</div></div>`).join('')
      : `<div class="card"><div class="card-body">${UI.emptyState('No prescription on file', 'eye', Auth.can('party.edit') ? '<button class="btn btn-primary btn-sm mt-3 btn-rx-add">Add prescription</button>' : '')}</div></div>`);
  };
  await loadRx();
  const rxOf = (el2) => rxs[+$(el2).closest('.rx-item').data('i')];
  $el.on('click', '.btn-rx-add', async () => { if (await RxUI.editRx({ customer: Catalog.party('customers', id) })) loadRx(); });
  $el.on('click', '.rx-edit', async function () { if (await RxUI.editRx({ customer: Catalog.party('customers', id), rx: rxOf(this) })) loadRx(); });
  $el.on('click', '.rx-print', function () { RxUI.printRx(Catalog.party('customers', id), rxOf(this)); });
  $el.on('click', '.rx-del', async function () {
    if (!await UI.confirmDialog('Delete this prescription?', { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { await Optical.deletePrescription(rxOf(this).id); UI.toast('Prescription deleted'); loadRx(); } catch (e) { UI.toastError(e); }
  });
  $el.on('click', '.rx-sell', function () {
    const r = rxOf(this); const days = Number(getSettings().optical?.deliveryDays) || 3;
    const key = storageKey('draft.sale');
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), mode: 'sale', partyId: id, partyName: p.name, order: { rx: r, rxId: r.id, deliveryDate: Optical.addDays(days), labNote: '' } }));
    location.hash = '#/pos';
  });
  bindDateFilter($el, (f, t) => { from = f; to = t; load(); });
  $el.on('click', '.btn-edit', async () => { if (await editParty(kind, Catalog.party(kind, id))) renderDetail(el, kind, id); });
  $el.on('click', '.btn-del', async () => {
    if (!await UI.confirmDialog(`Delete ${p.name}? If there are transactions, the ${one.toLowerCase()} will be deactivated instead.`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { const r = await Posting.deleteParty(kind, id); UI.toast(r === 'deleted' ? `${one} deleted` : `${one} deactivated (has transactions)`); location.hash = `#/${kind}`; } catch (e) { UI.toastError(e); }
  });
  $el.on('click', '.btn-pay', async () => {
    const { newVoucher } = await import('./vouchers.js');
    if (await newVoucher({ type: payType, counterAccountId: acc })) load();
  });
  $el.on('click', '.btn-sell', () => {
    const key = storageKey('draft.sale');
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), mode: 'sale', partyId: id, partyName: p.name }));
    location.hash = '#/pos';
  });
  $el.on('click', '.btn-print', () => {
    const b = getSettings().business;
    printHTML(`<div class="print-report"><h2>${esc(b.name)}</h2><div>${esc(one)} statement: <b>${esc(p.name)}</b> ${esc(p.phone || '')}</div>
      <div>Period: ${esc(from)} to ${esc(to)}</div><br>${ledgerTable(led, { debitNormal })}</div>`, { page: 'A4' });
  });
}

export default {
  async render(el, { route, params, setTitle }) {
    const kind = route;
    if (params[0]) {
      await renderDetail(el, kind, params[0]);
      setTitle(LABEL[kind][0]);
    } else await renderList(el, kind);
  },
};

