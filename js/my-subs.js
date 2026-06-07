// ── MY SUBMISSIONS ──────────────────────────────────────────────────────────
// Shows the current user's own pending submissions with an edit button only.

function renderMySubs() {
  const el = $('my-subs-list');
  if (!el) return;
  const items = S.pending.filter(p => p.submittedBy === S.cu.id);
  if (!items.length) {
    el.innerHTML = '<div class="empty" style="padding:2rem;color:#aaa;text-align:center">No submissions yet.</div>';
    return;
  }
  el.innerHTML = items.map(p => subCard(p, ['edit'])).join('');
}
