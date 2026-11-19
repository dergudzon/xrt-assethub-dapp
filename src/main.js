import { ApiPromise, WsProvider } from '@polkadot/api';
import { web3Accounts, web3Enable, web3FromSource } from '@polkadot/extension-dapp';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

// ---- config ---------------------------------------------------------------
const ROBONOMICS_RPC = import.meta.env.VITE_ROBONOMICS_RPC || 'wss://polkadot.rpc.robonomics.network/';
const ASSET_HUB_RPC = import.meta.env.VITE_ASSET_HUB_RPC || 'wss://polkadot-asset-hub-rpc.polkadot.io';
const EXPLORER = 'https://scan.robonomics.network';
const APP_NAME = 'XRT to Asset Hub';
const ASSET_HUB_PARA_ID = 1000;
const ROBONOMICS_SS58 = 32;
const POLKADOT_SS58 = 0;
// XRT as a foreign asset on Asset Hub
const XRT_ON_AH = { parents: 1, interior: { X1: [{ Parachain: 3388 }] } };
// Fee reserve for "Max" button, multiplier over the estimated tx fee
const FEE_MARGIN = 2n;

// ---- dom ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  connectBtn: $('connectBtn'),
  form: $('form'),
  account: $('account'),
  balance: $('balance'),
  amount: $('amount'),
  maxBtn: $('maxBtn'),
  recipient: $('recipient'),
  recipientInfo: $('recipientInfo'),
  feeInfo: $('feeInfo'),
  sendBtn: $('sendBtn'),
  log: $('log'),
};

// ---- state ----------------------------------------------------------------
let api; // Robonomics
let ahApi; // Asset Hub (lazy)
let decimals = 9;
let accounts = [];
let transferable = 0n;
let lastFee = 0n;
let recipientPk = null; // Uint8Array
let recipientOk = false;
let unsubBalance = null;
let sending = false;

// ---- helpers --------------------------------------------------------------
function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

function hint(node, text, kind = '') {
  node.textContent = text;
  node.className = `hint ${kind}`;
}

function log(html) {
  el.log.hidden = false;
  const time = new Date().toLocaleTimeString();
  el.log.innerHTML += `[${time}] ${html}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "12.5" -> 12500000000n (decimals=9). Returns null on invalid input. */
function parseAmount(str) {
  const s = str.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

function fmt(planck, maxFrac = 6) {
  const neg = planck < 0n;
  const v = neg ? -planck : planck;
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

function selectedAccount() {
  return accounts.find((a) => a.address === el.account.value);
}

function buildTx(amount) {
  const id = recipientPk ? u8aToHex(recipientPk) : u8aToHex(new Uint8Array(32));
  return api.tx.xcmPallet.transferAssets(
    { V5: { parents: 1, interior: { X1: [{ Parachain: ASSET_HUB_PARA_ID }] } } },
    { V5: { parents: 0, interior: { X1: [{ AccountId32: { network: null, id } }] } } },
    { V5: [{ id: { parents: 0, interior: 'Here' }, fun: { Fungible: amount } }] },
    0,
    'Unlimited',
  );
}

async function getAhApi() {
  if (!ahApi) ahApi = await ApiPromise.create({ provider: new WsProvider(ASSET_HUB_RPC), noInitWarn: true });
  return ahApi;
}

async function ahXrtBalance(address) {
  const ah = await getAhApi();
  const acc = await ah.query.foreignAssets.account(XRT_ON_AH, address);
  return acc.isSome ? acc.unwrap().balance.toBigInt() : 0n;
}

// ---- validation -----------------------------------------------------------
function validate() {
  const amount = parseAmount(el.amount.value);
  let ok = !sending && !!selectedAccount() && recipientOk && amount !== null && amount > 0n;
  if (amount !== null && amount > 0n) {
    if (amount + lastFee > transferable) {
      hint(el.feeInfo, `Not enough XRT: need ${fmt(amount + lastFee)} incl. fee, have ${fmt(transferable)}`, 'err');
      ok = false;
    } else {
      hint(
        el.feeInfo,
        `Robonomics fee ≈ ${fmt(lastFee, 9)} XRT. About 0.001 XRT more is spent on Asset Hub execution and taken from the amount.`,
      );
    }
    if (amount < parseAmount('0.01')) {
      hint(el.feeInfo, 'Amount too small: minimum is 0.01 XRT (Asset Hub execution fee is taken from it).', 'err');
      ok = false;
    }
  } else if (el.amount.value.trim()) {
    hint(el.feeInfo, `Invalid amount (max ${decimals} decimals)`, 'err');
    ok = false;
  } else {
    hint(el.feeInfo, '');
  }
  el.sendBtn.disabled = !ok;
}

async function updateFee() {
  const acc = selectedAccount();
  if (!acc) return;
  try {
    const amount = parseAmount(el.amount.value) || 10n ** BigInt(decimals);
    const info = await buildTx(amount).paymentInfo(acc.address);
    lastFee = info.partialFee.toBigInt();
  } catch (e) {
    console.warn('fee estimate failed', e);
  }
  validate();
}

let recipientSeq = 0;
async function checkRecipient() {
  const seq = ++recipientSeq;
  const raw = el.recipient.value.trim();
  recipientOk = false;
  recipientPk = null;
  validate();
  if (!raw) return hint(el.recipientInfo, '');

  try {
    const pk = decodeAddress(raw); // accepts any SS58 prefix or 0x hex
    if (pk.length !== 32) throw new Error('expected a 32-byte account');
    recipientPk = pk;
  } catch (e) {
    return hint(el.recipientInfo, `Invalid address: ${e.message}`, 'err');
  }

  const ahAddr = encodeAddress(recipientPk, POLKADOT_SS58);
  hint(el.recipientInfo, `Asset Hub address: ${ahAddr} — checking account…`);

  try {
    const ah = await getAhApi();
    const [sys, xrt] = await Promise.all([ah.query.system.account(ahAddr), ahXrtBalance(ahAddr)]);
    if (seq !== recipientSeq) return;
    const dot = sys.data.free.toBigInt();
    const exists = sys.providers.toNumber() > 0;
    const dotFmt = (Number(dot) / 1e10).toFixed(4);
    const xrtFmt = fmt(xrt);
    if (!exists) {
      // XRT is not a "sufficient" asset on Asset Hub: depositing into a
      // non-existent account fails and the XRT gets trapped.
      hint(
        el.recipientInfo,
        `Asset Hub address: ${ahAddr}\nThis account does not exist on Asset Hub (no DOT / no providers). XRT is not a sufficient asset there, so the deposit would fail. Send at least 0.1 DOT to it first.`,
        'err',
      );
      return;
    }
    recipientOk = true;
    hint(el.recipientInfo, `Asset Hub address: ${ahAddr}\nOn Asset Hub: ${dotFmt} DOT, ${xrtFmt} XRT`, 'ok');
  } catch (e) {
    if (seq !== recipientSeq) return;
    recipientOk = true; // don't block on AH RPC problems, but warn
    hint(el.recipientInfo, `Asset Hub address: ${ahAddr}\nCould not check the account on Asset Hub: ${e.message}`, 'err');
  }
  validate();
}

// ---- balance --------------------------------------------------------------
async function watchBalance() {
  if (unsubBalance) unsubBalance();
  unsubBalance = null;
  const acc = selectedAccount();
  if (!acc) return;
  el.balance.textContent = '…';
  unsubBalance = await api.derive.balances.all(acc.address, (all) => {
    const t = all.transferable ?? all.availableBalance;
    transferable = t.toBigInt();
    el.balance.textContent = `${fmt(transferable)} XRT`;
    validate();
  });
  updateFee();
}

// ---- connect --------------------------------------------------------------
async function connectExtension() {
  el.connectBtn.disabled = true;
  try {
    const exts = await web3Enable(APP_NAME);
    if (!exts.length) {
      setStatus('No extension found or access denied. Install Polkadot.js (or Talisman/SubWallet) and allow this site.', 'err');
      el.connectBtn.disabled = false;
      return;
    }
    accounts = (await web3Accounts({ ss58Format: ROBONOMICS_SS58 })).filter((a) => a.type !== 'ethereum');
    if (!accounts.length) {
      setStatus('Extension connected, but it has no Substrate accounts.', 'err');
      el.connectBtn.disabled = false;
      return;
    }
    el.account.innerHTML = accounts
      .map((a) => `<option value="${a.address}">${escapeHtml(a.meta.name || 'account')} — ${a.address}</option>`)
      .join('');
    el.form.hidden = false;
    el.connectBtn.hidden = true;
    setStatus(`Connected: ${exts.map((e) => e.name).join(', ')}. Robonomics: ${api.runtimeChain}.`, 'ok');
    await watchBalance();
  } catch (e) {
    setStatus(`Extension error: ${e.message}`, 'err');
    el.connectBtn.disabled = false;
  }
}

// ---- send -----------------------------------------------------------------
async function send(ev) {
  ev.preventDefault();
  const acc = selectedAccount();
  const amount = parseAmount(el.amount.value);
  if (!acc || !amount || !recipientPk) return;

  const ahAddr = encodeAddress(recipientPk, POLKADOT_SS58);
  sending = true;
  validate();

  let before = null;
  try {
    before = await ahXrtBalance(ahAddr);
  } catch {
    /* tracking is best-effort */
  }

  log(`Sending ${escapeHtml(fmt(amount, 9))} XRT from ${escapeHtml(acc.address)} to ${escapeHtml(ahAddr)} (Asset Hub)…`);

  try {
    const injector = await web3FromSource(acc.meta.source);
    const unsub = await buildTx(amount).signAndSend(acc.address, { signer: injector.signer }, async (res) => {
      const { status, dispatchError, txIndex } = res;
      if (status.isReady) log('Submitted, waiting for inclusion…');
      if (status.isInBlock) {
        const hash = status.asInBlock;
        const header = await api.rpc.chain.getHeader(hash);
        const id = `${header.number.toNumber()}-${txIndex}`;
        if (dispatchError) {
          let msg = dispatchError.toString();
          if (dispatchError.isModule) {
            const d = api.registry.findMetaError(dispatchError.asModule);
            msg = `${d.section}.${d.name}: ${d.docs.join(' ')}`;
          }
          log(`<span class="err">Failed in block: ${escapeHtml(msg)}</span>`);
          sending = false;
          validate();
          unsub();
          return;
        }
        const failed = res.events.find(({ event }) => event.section === 'xcmPallet' && event.method === 'Attempted' && !event.data[0].isComplete);
        if (failed) log(`<span class="err">XCM execution incomplete: ${escapeHtml(failed.event.data[0].toString())}</span>`);
        log(`In block: <a href="${EXPLORER}/extrinsics/${id}" target="_blank" rel="noopener">${id}</a>`);
        if (before !== null) trackArrival(ahAddr, before);
      }
      if (status.isFinalized) {
        log('Finalized on Robonomics.');
        sending = false;
        el.amount.value = '';
        validate();
        unsub();
      }
    });
  } catch (e) {
    log(`<span class="err">${escapeHtml(e.message)}</span>`);
    sending = false;
    validate();
  }
}

async function trackArrival(ahAddr, before) {
  log('Waiting for XRT to arrive on Asset Hub…');
  const ah = await getAhApi();
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    unsub();
    log('<span class="err">No deposit seen on Asset Hub after 3 min. Check the recipient on an Asset Hub explorer.</span>');
  }, 180_000);
  const unsub = await ah.query.foreignAssets.account(XRT_ON_AH, ahAddr, (acc) => {
    const now = acc.isSome ? acc.unwrap().balance.toBigInt() : 0n;
    if (done || now <= before) return;
    done = true;
    clearTimeout(timer);
    unsub();
    log(`<span class="ok">Arrived on Asset Hub: +${escapeHtml(fmt(now - before, 9))} XRT (balance ${escapeHtml(fmt(now))} XRT).</span>`);
  });
}

// ---- init -----------------------------------------------------------------
async function init() {
  el.connectBtn.disabled = true;
  try {
    api = await ApiPromise.create({ provider: new WsProvider(ROBONOMICS_RPC), noInitWarn: true });
    decimals = api.registry.chainDecimals[0] ?? 9;
    setStatus(`Robonomics: ${api.runtimeChain} connected.`, 'ok');
    el.connectBtn.disabled = false;
  } catch (e) {
    setStatus(`Cannot connect to ${ROBONOMICS_RPC}: ${e.message}`, 'err');
  }
}

let feeTimer;
el.connectBtn.addEventListener('click', connectExtension);
el.account.addEventListener('change', watchBalance);
el.amount.addEventListener('input', () => {
  validate();
  clearTimeout(feeTimer);
  feeTimer = setTimeout(updateFee, 400);
});
el.recipient.addEventListener('input', () => {
  clearTimeout(el.recipient._t);
  el.recipient._t = setTimeout(checkRecipient, 300);
});
el.maxBtn.addEventListener('click', () => {
  const max = transferable - lastFee * FEE_MARGIN;
  el.amount.value = max > 0n ? fmt(max, 9).replace(/,/g, '') : '0';
  validate();
});
el.form.addEventListener('submit', send);

init();
