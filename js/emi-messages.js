// ── EMI MESSAGES ───────────────────────────────────────────────────────────
// Admin-only tab: generates WhatsApp click-to-chat links for EMI-related messages

const UPI_ID = 'paytmqr6njiga@ptys';

function ymd(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? null : d;
}

async function initEmiMsgsPage() {
  const today = ymd(new Date());
  $('emsg-start').value = today;
  $('emsg-results').innerHTML = '';
  $('emsg-mark-wrap').style.display = 'none';
  try {
    const res = await fetch(S.sheetsUrl + '?action=readConfig');
    const data = await res.json();
    if (data.ok && data.lastMessageSent) {
      const last = parseDate(data.lastMessageSent);
      if (last) {
        last.setDate(last.getDate() + 1);
        const from = ymd(last);
        $('emsg-from').value = from;
        $('emsg-from-label').textContent = '(last marked: ' + data.lastMessageSent + ', +1 day)';
      } else {
        $('emsg-from').value = today;
        $('emsg-from-label').textContent = '(invalid last-sent date)';
      }
    } else {
      $('emsg-from').value = today;
      $('emsg-from-label').textContent = '(no last-sent date)';
    }
  } catch(e) {
    $('emsg-from').value = today;
    $('emsg-from-label').textContent = '(could not load config)';
  }
}

async function generateMessages() {
  const fromVal  = $('emsg-from').value;
  const endVal   = $('emsg-start').value;
  if (!fromVal || !endVal) { showAlert('Please fill both From and To dates.', 'e'); return; }

  const startDate = parseDate(fromVal);
  const endDate   = parseDate(endVal);
  if (!startDate || !endDate) { showAlert('Invalid date.', 'e'); return; }
  if (startDate > endDate) { showAlert('From date cannot be after To date.', 'e'); return; }

  showLoader();
  try {
    const lRes = await fetch(S.sheetsUrl + '?action=readAllLoansForMsgs');
    const lData = await lRes.json();
    if (!lData.ok) { showAlert('Failed to load loans: ' + (lData.error||''), 'e'); return; }

    const loans = lData.loans || [];

    const messages = [];

    loans.forEach(loan => {
      const name  = loan.customerName || '';
      const phone = loan.phone || '';
      if (!phone) return;
      const li    = loan.loanId || '';

      const loanTemplates = {
        'Welcome':      loan.welcomeMsgText,
        'EMI Reminder': loan.emiMsgText,
        'Last Date':    loan.lastDateMsgText,
        'Thank You':    loan.thankYouMsgText,
        'Loan Closing': loan.loanClosingMsgText,
      };

      function addIfInRange(label, dateStr, extra) {
        const template = loanTemplates[label];
        if (!dateStr || !template) return;
        const dt = parseSheetDate(dateStr);
        if (!dt) return;
        const t = dt.getTime();
        if (t < startDate.getTime() || t > endDate.getTime()) return;
        const amt = extra && extra.amount != null ? extra.amount : (loan.monthlyEmi || '');
        let msg = template
          .replace(/\{customer\}/g, name)
          .replace(/\{loan\}/g, li)
          .replace(/\{amount\}/g, amt)
          .replace(/\{date\}/g, fmtDisplayDate(dateStr))
          .replace(/\{total\}/g, loan.totalPending != null ? loan.totalPending : amt);
        if (extra && extra.emiNum != null) {
          msg = msg.replace(/\{emi\}/g, extra.emiNum);
        } else {
          msg = msg.replace(/\{emi\}/g, '');
        }
        const upi = `upi://pay?pa=${UPI_ID}&pn=AKS+Finance&am=${amt}&cu=INR&tn=EMI+${li}`;
        msg = msg.replace(/\{upilink\}/g, upi);
        messages.push({ label, phone, customerName: name, loanId: li, emiNum: extra && extra.emiNum, date: dateStr, msg });
      }

      // Welcome: billDate + 1 day
      if (loan.billDate) {
        const wd = parseSheetDate(loan.billDate);
        if (wd) { wd.setDate(wd.getDate() + 1); addIfInRange('Welcome', ymd(wd)); }
      }

      // Process slots
      const slots = loan.slots || [];
      slots.forEach(slot => {
        const sd = slot.scheduledDate;
        if (!sd) return;
        const sdDt = parseSheetDate(sd);
        if (!sdDt) return;
        const sdTime = sdDt.getTime();

        // Last Date and EMI Reminder: only if scheduled date >= endDate
        if (sdTime >= endDate.getTime()) {
          const lastDateInRange = sdTime >= startDate.getTime() && sdTime <= endDate.getTime();
          if (lastDateInRange)
            addIfInRange('Last Date', sd, { emiNum: slot.num });

          // EMI Reminder: suppressed if Last Date is in range for this slot
          if (!lastDateInRange) {
            const reminderOffsets = [-7, -2, -1];
            let selectedOffset = null;
            for (const offset of reminderOffsets) {
              const d = new Date(sdDt);
              d.setDate(d.getDate() + offset);
              const t = d.getTime();
              if (t >= startDate.getTime() && t <= endDate.getTime()) selectedOffset = offset;
            }
            if (selectedOffset !== null) {
              const rd = new Date(sdDt);
              rd.setDate(rd.getDate() + selectedOffset);
              addIfInRange('EMI Reminder', ymd(rd), { emiNum: slot.num, amount: loan.monthlyEmi });
            }
          }
        }

        if (slot.received && slot.receivedDate) {
          const td = parseSheetDate(slot.receivedDate);
          if (td) { td.setDate(td.getDate() + 1); addIfInRange('Thank You', ymd(td), { emiNum: slot.num }); }
        }
      });

      if (loan.emiCompleted) {
        const rcvSlots = slots.filter(s => s.received && s.receivedDate);
        const lastRcv = rcvSlots[rcvSlots.length - 1];
        if (lastRcv && lastRcv.receivedDate) {
          const cd = parseSheetDate(lastRcv.receivedDate);
          if (cd) { cd.setDate(cd.getDate() + 1); addIfInRange('Loan Closing', ymd(cd), { amount: loan.totalPending || loan.monthlyEmi }); }
        }
      }
    });

    const TYPE_ORDER = { 'Welcome':1, 'Loan Closing':2, 'Thank You':3, 'Last Date':4, 'EMI Reminder':4 };
    messages.sort((a, b) =>
      (TYPE_ORDER[a.label]||99) - (TYPE_ORDER[b.label]||99) ||
      a.date.localeCompare(b.date) ||
      a.customerName.localeCompare(b.customerName)
    );
    renderMessageResults(messages);
    $('emsg-mark-wrap').style.display = messages.length ? 'block' : 'none';
  } catch (err) { showAlert('Error: ' + err.message, 'e'); }
  finally { hideLoader(); }
}

const _emsgCollapsed = {};

function renderMessageResults(messages) {
  const el = $('emsg-results');
  if (!messages.length) {
    el.innerHTML = '<div class="card" style="text-align:center;color:#888;font-size:13px">No messages to send in this date range.</div>';
    return;
  }

  const TYPE_META = {
    'Welcome':      { color:'#0F6E56', bg:'#E1F5EE', icon:'\uD83D\uDC4B' },
    'Loan Closing': { color:'#888',    bg:'#F1EFE8', icon:'\uD83D\uDD12' },
    'Thank You':    { color:'#1A73E8', bg:'#E8F0FE', icon:'\u2705' },
    'Last Date':    { color:'#A32D2D', bg:'#FCEBEB', icon:'\u26A0\uFE0F' },
    'EMI Reminder': { color:'#BA7517', bg:'#FAEEDA', icon:'\uD83D\uDD14' },
  };
  const TYPE_ORDER = { 'Welcome':1, 'Loan Closing':2, 'Thank You':3, 'Last Date':4, 'EMI Reminder':4 };

  const groups = {};
  messages.forEach(m => { if (!groups[m.label]) groups[m.label] = []; groups[m.label].push(m); });

  const sortedLabels = Object.keys(groups).sort((a, b) => (TYPE_ORDER[a]||99) - (TYPE_ORDER[b]||99));
  sortedLabels.forEach(l => { if (_emsgCollapsed[l] === undefined) _emsgCollapsed[l] = false; });

  function toggle(label) { _emsgCollapsed[label] = !_emsgCollapsed[label]; renderMessageResults(messages); }

  el.innerHTML =
    `<div style="font-size:12px;color:#888;margin-bottom:0.5rem">${messages.length} message(s) found</div>` +
    sortedLabels.map(label => {
      const group = groups[label];
      const meta  = TYPE_META[label] || { color:'#888', bg:'#F1EFE8', icon:'\uD83D\uDCE7' };
      const collapsed = _emsgCollapsed[label];
      return `<div class="card" style="margin-bottom:0.5rem;padding:0;overflow:hidden">
        <div onclick="window.__emsgToggle('${label}')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:${meta.bg};user-select:none">
          <span style="font-size:14px">${collapsed ? '\u25B6' : '\u25BC'}</span>
          <span style="font-size:12px;font-weight:600;color:${meta.color}">${meta.icon} ${label}</span>
          <span style="font-size:11px;color:#888;margin-left:auto">${group.length}</span>
        </div>
        ${collapsed ? '' :
          `<div style="overflow-x:auto"><table class="emi-table" style="width:100%"><thead><tr>
            <th>Customer</th><th>Phone</th><th>Loan</th><th>EMI</th><th>Date</th><th>Preview</th><th>Action</th>
          </tr></thead><tbody>` +
          group.map(m => {
            const url = `https://wa.me/91${m.phone}?text=${encodeURIComponent(m.msg)}`;
            const preview = m.msg.length > 120 ? m.msg.slice(0, 120) + '…' : m.msg;
            return `<tr>
              <td style="white-space:nowrap">${m.customerName}</td>
              <td style="white-space:nowrap">${m.phone}</td>
              <td style="white-space:nowrap">${m.loanId}</td>
              <td>${m.emiNum || '\u2014'}</td>
              <td style="white-space:nowrap">${fmtDisplayDate(m.date)}</td>
              <td style="font-size:11px;color:#555;max-width:260px;word-break:break-word;line-height:1.3" title="${m.msg.replace(/"/g,'&quot;')}">${preview}</td>
              <td><a href="${url}" target="_blank" class="btn btn-sm" style="background:#25D366;color:#fff;border-color:#25D366;text-decoration:none">\uD83D\uDCF1 Send</a></td>
            </tr>`;
          }).join('') +
          `</tbody></table></div>`
        }
      </div>`;
    }).join('');

  window.__emsgToggle = toggle;
}

async function markMessagesDone() {
  const today = $('emsg-start').value || ymd(new Date());
  showLoader();
  try {
    await gasPost({ action: 'updateLastMessageSent', date: today });
    const next = parseDate(today);
    if (next) { next.setDate(next.getDate() + 1); $('emsg-from').value = ymd(next); }
    $('emsg-from-label').textContent = '(last marked: ' + today + ', +1 day)';
    $('emsg-results').innerHTML = '<div class="card" style="text-align:center;color:#888;font-size:13px">Marked as done.</div>';
    $('emsg-mark-wrap').style.display = 'none';
    showAlert('Last message sent date updated to ' + today);
  } catch(err) { showAlert('Error: ' + err.message, 'e'); }
  finally { hideLoader(); }
}
