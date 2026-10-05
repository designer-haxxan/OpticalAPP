// Optical-store domain logic: eye prescriptions (Rx), job-order status tracking and first-run setup.
import * as idb from '../db/idb.js';
import { uuid, round2, num, nowISO, today, localDate, AppError, clean } from '../core/utils.js';
import * as Auth from './auth.js';
import * as Catalog from './catalog.js';
import * as Posting from './posting.js';

// ---------- Rx helpers ----------
const blank = (v) => v === '' || v === null || v === undefined;
const numOrNull = (v) => (blank(v) ? null : round2(num(v, NaN)));

export const emptyEye = () => ({ sph: null, cyl: null, axis: null, add: null });

export function normalizeEye(e = {}) {
  const out = { sph: numOrNull(e.sph), cyl: numOrNull(e.cyl), axis: blank(e.axis) ? null : Math.round(num(e.axis, NaN)), add: numOrNull(e.add) };
  for (const k of Object.keys(out)) if (Number.isNaN(out[k])) throw new AppError('Prescription values must be numbers.');
  if (out.sph !== null && Math.abs(out.sph) > 30) throw new AppError('SPH must be between −30.00 and +30.00.');
  if (out.cyl !== null && Math.abs(out.cyl) > 10) throw new AppError('CYL must be between −10.00 and +10.00.');
  if (out.add !== null && (out.add < 0 || out.add > 5)) throw new AppError('ADD must be between 0 and +5.00.');
  if (out.axis !== null && (out.axis < 0 || out.axis > 180)) throw new AppError('AXIS must be between 0 and 180.');
  if (out.cyl && !out.axis) throw new AppError('Enter the AXIS for the cylinder value.');
  return out;
}

export const eyeHasData = (e) => !!e && ['sph', 'cyl', 'axis', 'add'].some((k) => !blank(e[k]));
export const rxHasData = (rx) => !!rx && (eyeHasData(rx.od) || eyeHasData(rx.os) || !blank(rx.pd));

// Same prescription values (ignoring id/date/doctor)? Used to avoid saving duplicates.
export function sameRx(a, b) {
  if (!a || !b) return false;
  const k = (rx) => JSON.stringify([rx.od, rx.os, rx.pd ?? null, rx.pdNear ?? null].map((x) => (x && typeof x === 'object' ? ['sph', 'cyl', 'axis', 'add'].map((f) => x[f] ?? null) : x ?? null)));
  return k(a) === k(b);
}

// ---------- Prescriptions ----------
export async function savePrescription(data) {
  Auth.require('party.edit');
  if (!data.customerId) throw new AppError('Select a customer for this prescription.');
  const od = normalizeEye(data.od); const os = normalizeEye(data.os);
  const pd = numOrNull(data.pd); const pdNear = numOrNull(data.pdNear);
  if ([pd, pdNear].some((v) => v !== null && (v < 20 || v > 90))) throw new AppError('PD must be between 20 and 90 mm.');
  const rx = { od, os, pd, pdNear };
  if (!rxHasData(rx)) throw new AppError('Enter at least one prescription value.');
  const id = data.id || uuid(); const now = nowISO();
  const rec = await idb.write(['prescriptions', 'customers'], async (t) => {
    if (!await t.get('customers', data.customerId)) throw new AppError('Customer not found.');
    const old = data.id ? await t.get('prescriptions', id) : null;
    const r = { ...(old || { createdAt: now }), id, customerId: data.customerId, date: data.date || old?.date || today(), od, os, pd, pdNear,
      doctor: clean(data.doctor, 80), purpose: clean(data.purpose, 40), note: clean(data.note, 300), updatedAt: now };
    await t.put('prescriptions', r);
    return r;
  });
  document.dispatchEvent(new CustomEvent('data:changed'));
  return rec;
}

export async function deletePrescription(id) {
  Auth.require('party.delete');
  await idb.write(['prescriptions'], (t) => t.delete('prescriptions', id));
  document.dispatchEvent(new CustomEvent('data:changed'));
}

export async function prescriptionsFor(customerId) {
  const list = await idb.getAllByIndex('prescriptions', 'customerId', customerId);
  return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

// customerId → date of the latest prescription (for "eye test due" reminders).
export async function latestRxDates() {
  const map = new Map();
  for (const r of await idb.getAll('prescriptions')) if (!map.get(r.customerId) || r.date > map.get(r.customerId)) map.set(r.customerId, r.date);
  return map;
}

// ---------- Job orders ----------
// Stored on the sale: sale.order = { rx, rxId, deliveryDate, labNote, status, <status>At } and sale.orderStatus (indexed copy).
export const ORDER_STATUS = {
  new: { label: 'Ordered', icon: 'hourglass-split', tint: 'amber', next: 'lab', nextLabel: 'Send to lab' },
  lab: { label: 'In lab', icon: 'tools', tint: 'cyan', next: 'ready', nextLabel: 'Mark ready' },
  ready: { label: 'Ready', icon: 'check2-circle', tint: 'green', next: 'delivered', nextLabel: 'Deliver' },
  delivered: { label: 'Delivered', icon: 'bag-check', tint: 'slate', next: null, nextLabel: '' },
};
export const ORDER_FLOW = ['new', 'lab', 'ready', 'delivered'];

export async function setOrderStatus(saleId, status) {
  Auth.require('sale.create');
  if (!ORDER_STATUS[status]) throw new AppError('Unknown order status.');
  const doc = await idb.write(['sales'], async (t) => {
    const s = await t.get('sales', saleId);
    if (!s?.order) throw new AppError('Job order not found.');
    if (s.status === 'void') throw new AppError('This sale was voided.');
    s.order = { ...s.order, status, [status + 'At']: nowISO() };
    s.orderStatus = status; s.updatedAt = nowISO();
    await t.put('sales', s);
    return s;
  });
  document.dispatchEvent(new CustomEvent('data:changed'));
  return doc;
}

export async function ordersByStatus(statuses) {
  const lists = await Promise.all(statuses.map((s) => idb.getAllByIndex('sales', 'orderStatus', s)));
  return lists.flat().filter((s) => s.status !== 'void');
}

export async function orderCounts() {
  const out = { new: 0, lab: 0, ready: 0, dueToday: 0, overdue: 0 };
  const t = today();
  for (const s of await ordersByStatus(['new', 'lab', 'ready'])) {
    out[s.orderStatus]++;
    const d = s.order?.deliveryDate;
    if (d && s.orderStatus !== 'ready') { if (d === t) out.dueToday++; else if (d < t) out.overdue++; }
  }
  return out;
}

export const addDays = (days, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + days); return localDate(d); };

// Days until a delivery date (negative = overdue).
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const a = new Date(today() + 'T00:00:00'); const b = new Date(dateStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// ---------- First-run setup ----------
const CATEGORIES = ['Frames', 'Sunglasses', 'Lenses', 'Contact Lenses', 'Reading Glasses', 'Lens Solution & Care', 'Cases & Accessories', 'Services'];
const SERVICES = [['Eye Test', 500], ['Lens Fitting Charges', 300], ['Frame Repair / Adjustment', 150]];

// Adds optical categories and a few service items on a brand-new database. Runs once.
export async function seedOptical() {
  if (!Auth.can('product.edit')) return;
  if (await idb.get('meta', 'opticalSeed')) return;
  if (!Catalog.allCategories().length && !Catalog.allProducts().length) {
    let servicesId = '';
    for (const name of CATEGORIES) {
      const id = await Posting.saveCategory({ name });
      if (name === 'Services') servicesId = id;
    }
    for (const [name, salePrice] of SERVICES) await Posting.saveProduct({ name, salePrice, purchasePrice: 0, trackStock: false, unit: 'pcs', categoryId: servicesId });
  }
  await idb.write(['meta'], (t) => t.put('meta', { key: 'opticalSeed', value: true }));
}
