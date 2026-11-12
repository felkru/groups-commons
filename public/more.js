// Account, moderation and leaderboard pages.

import { api, store } from './api.js';
import { card, go } from './app.js';
import { DEFAULT_BRAND, getBrand, isDefaultBrand, setBrand } from './brand.js';
import { watchPreviews } from './template.js';
import { $, KIND, esc, plural, state, timeAgo, toast, todo } from './ui.js';

async function refreshMeta() {
  state.meta = await api('/meta');
  state.votes = await api('/me/votes').catch(() => ({}));
}

// ---------------------------------------------------------------- account
async function afterSignIn(session) {
  store.set('commons_session', session.token);
  await refreshMeta();
  // The brand kit follows the account: take the saved one, or save this browser's kit when the account has none yet.
  const saved = await api('/me/brand').catch(() => null);
  if (saved && Object.keys(saved).length) {
    const patch = {};
    for (const k of Object.keys(DEFAULT_BRAND)) patch[k] = typeof saved[k] === 'string' ? saved[k] : DEFAULT_BRAND[k];
    setBrand(patch);
  } else if (!isDefaultBrand(getBrand())) await api('/me/brand', { method: 'PUT', body: getBrand() }).catch(() => {});
  else setBrand({ group_name: session.account.group });
  toast(`Signed in as ${session.account.username}`);
  go('/account', true);
}

export async function accountPage(root) {
  const me = state.meta.account;
  if (!me) {
    root.innerHTML = `
      <section class="hero compact"><div><h1>Your account</h1></div></section>
      <p class="muted" style="max-width:72ch">An account ties your votes, materials, brand kit and group website to you instead of to this browser, so they follow you to other devices. Browsing, voting and adding materials also work without one.</p>
      <div class="cols halves" style="margin-top:18px">
        <section class="panel form"><h2>Sign in</h2>
          <form id="signin"><label>User name<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p class="err" data-err></p><button class="btn primary">Sign in</button></form>
        </section>
        <section class="panel form"><h2>Create an account</h2>
          <form id="signup"><label>User name<input name="username" autocomplete="username" pattern="[a-z0-9][a-z0-9\\-]{2,29}" placeholder="lower-case letters, digits, hyphens" required></label><label>Your group<input name="group" maxlength="80" value="${esc(isDefaultBrand(getBrand()) ? '' : getBrand().group_name)}" required></label><label>Password (at least 8 characters)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label><p class="err" data-err></p><button class="btn primary">Create account</button></form>
          <p class="hint">No email address is stored. Password reset and sign-in with a university account ${todo()}</p>
        </section>
      </div>`;
    for (const [id, path] of [['#signin', '/session'], ['#signup', '/accounts']]) {
      $(id, root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await afterSignIn(await api(path, { method: 'POST', body: Object.fromEntries(f) }));
        } catch (err) {
          $('[data-err]', e.target).textContent = err.message;
        }
      });
    }
    return;
  }
  const sites = await api('/sites').catch(() => []);
  root.innerHTML = `
    <section class="hero compact"><div><h1>Your account</h1></div></section>
    <div class="cols" style="margin-top:18px">
      <div>
        <section class="panel"><h2>${esc(me.username)}</h2>
          <dl class="kv"><dt>Group</dt><dd>${esc(me.group)}</dd><dt>Role</dt><dd>${me.role === 'moderator' ? 'Moderator' : 'Member'}</dd></dl>
          <p class="hint">Your votes count once per account. Materials you add while signed in can be edited and deleted from any device. Your brand kit is saved to the account whenever you change it.</p>
          <div class="row" style="margin-top:12px"><a class="btn" href="/brand">Brand kit</a>${state.meta.admin ? '<a class="btn" href="/moderate">Moderation</a>' : ''}<button class="btn danger" id="signout">Sign out</button></div>
        </section>
        <section class="panel"><h2>Your group website</h2>
          ${sites.length ? `<ul class="files">${sites.map((s) => `<li><span><strong>${esc(s.title)}</strong> <span class="small muted">/s/${esc(s.name)} · ${s.status === 'published' ? 'live' : 'waiting for review'}</span></span><span class="row">${s.status === 'published' ? `<a class="btn small" href="/s/${esc(s.name)}" target="_blank">Open ↗</a>` : ''}<button class="btn small danger" data-del="${esc(s.name)}">Take down</button></span></li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
          <p class="hint">Open the <a href="/?c=website">website template</a>, change the texts, then choose “Publish as website”. Your own domain and server access ${todo()}</p>
        </section>
        <section class="panel form"><h2>Password</h2>
          <form id="password"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password (at least 8 characters)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label><p class="err" data-err></p><button class="btn">Change password</button></form>
          <p class="hint">Changing it signs you out on your other devices. There is no password reset, so keep it somewhere safe.</p>
        </section>
        <section class="panel form"><h2>Delete account</h2>
          <p class="small muted">This removes your account, your group website, your saved brand kit and your votes, and deletes materials of yours that are still waiting for review. It cannot be undone. See <a href="/privacy">what is stored</a>.</p>
          <form id="delete"><label>Materials you published<select name="materials"><option value="keep">Keep them in the commons, without my user name</option><option value="delete">Delete them too</option></select></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p class="err" data-err></p><button class="btn danger">Delete my account</button></form>
        </section>
      </div>
    </div>`;
  $('#password', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const session = await api('/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      store.set('commons_session', session.token);
      e.target.reset();
      $('[data-err]', e.target).textContent = '';
      toast('Password changed');
    } catch (err) {
      $('[data-err]', e.target).textContent = err.message;
    }
  });
  $('#delete', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm(`Delete the account ${me.username}? This cannot be undone.`)) return;
    try {
      await api('/me/delete', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      store.del('commons_session');
      await refreshMeta();
      toast('Your account is deleted');
      go('/account', true);
    } catch (err) {
      $('[data-err]', e.target).textContent = err.message;
    }
  });
  $('#signout', root).addEventListener('click', async () => {
    store.del('commons_session');
    await refreshMeta();
    go('/account', true);
  });
  root.addEventListener('click', async (e) => {
    const name = e.target.closest('[data-del]')?.dataset.del;
    if (!name || !confirm(`Take down the website /s/${name}?`)) return;
    await api(`/sites/${name}`, { method: 'DELETE' }).catch((err) => toast(err.message));
    go('/account', true);
  });
}

// ---------------------------------------------------------------- moderation
export async function moderatePage(root) {
  if (!state.meta.admin) {
    root.innerHTML = `<section class="hero compact"><div><h1>Moderation</h1></div></section><div class="empty"><p>This page is for moderators. Sign in with a moderator account on the <a href="/account">account page</a>, or enter the moderator token on the <a href="/about">About page</a>.</p></div>`;
    return;
  }
  const [{ items }, sites, accounts] = await Promise.all([api('/items?pending=1&sort=new'), api('/sites'), api('/accounts').catch(() => [])]);
  const pendingSites = sites.filter((s) => s.status !== 'published');
  root.innerHTML = `
    <section class="hero compact"><div><h1>Moderation</h1></div></section>
    <section class="panel"><h2>Materials waiting for review <span class="badge">${items.length}</span></h2>
      ${items.length ? `<table class="spec"><thead><tr><th>Material</th><th>Kind</th><th>From</th><th>Added</th><th></th></tr></thead><tbody>${items.map((i) => `<tr><td><a href="/m/${esc(i.slug)}"><strong>${esc(i.title)}</strong></a><br><span class="small muted">${esc(i.summary)}</span></td><td data-label="Kind">${esc(KIND[i.kind])}<br><span class="small muted">${esc(state.meta.categories[i.category] || i.category)}</span></td><td data-label="From">${esc(i.group)}${i.author ? `<br><span class="small muted">${esc(i.author)}</span>` : ''}${i.forked_from ? `<br><span class="small muted">fork of ${esc(i.forked_from)}</span>` : ''}</td><td data-label="Added">${timeAgo(i.created_at)}</td><td><div class="row"><button class="btn small primary" data-approve="${esc(i.slug)}">Approve</button><button class="btn small danger" data-reject="${esc(i.slug)}">Reject</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing is waiting.</p>'}
    </section>
    <section class="panel"><h2>Group websites waiting for review <span class="badge">${pendingSites.length}</span></h2>
      ${sites.length ? `<table class="spec"><thead><tr><th>Site</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>${sites.map((s) => `<tr><td><strong>${esc(s.title)}</strong><br><span class="small muted">/s/${esc(s.name)}</span></td><td data-label="Owner">${esc(String(s.owner || '').replace(/^acct-/, ''))}</td><td data-label="Status">${s.status === 'published' ? 'live' : 'waiting'}</td><td><div class="row"><button class="btn small" data-site-preview="${esc(s.name)}">Preview</button>${s.status === 'published' ? `<a class="btn small" href="/s/${esc(s.name)}" target="_blank">Open ↗</a>` : `<button class="btn small primary" data-site-approve="${esc(s.name)}">Approve</button>`}<button class="btn small danger" data-site-del="${esc(s.name)}">Take down</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No websites yet.</p>'}
      <div id="sitepreview"></div>
    </section>
    <section class="panel"><h2>Accounts <span class="badge">${accounts.length}</span></h2>
      ${accounts.length ? `<table class="spec"><thead><tr><th>User</th><th>Group</th><th>Role</th><th></th></tr></thead><tbody>${accounts.map((a) => `<tr><td><strong>${esc(a.username)}</strong></td><td data-label="Group">${esc(a.group)}</td><td data-label="Role">${a.role === 'moderator' ? 'Moderator' : 'Member'}</td><td><button class="btn small" data-role="${esc(a.username)}" data-to="${a.role === 'moderator' ? 'member' : 'moderator'}">${a.role === 'moderator' ? 'Remove moderator role' : 'Make moderator'}</button></td></tr>`).join('')}</tbody></table><p class="hint">A role change takes effect within a minute, without signing in again.</p>` : '<p class="muted">No accounts yet.</p>'}
    </section>`;
  root.addEventListener('click', async (e) => {
    const d = e.target.closest('button')?.dataset;
    if (!d) return;
    try {
      if (d.approve) await api(`/items/${d.approve}/approve`, { method: 'POST' });
      else if (d.reject) {
        if (!confirm('Reject and delete this material?')) return;
        await api(`/items/${d.reject}`, { method: 'DELETE' });
      } else if (d.siteApprove) await api(`/sites/${d.siteApprove}/approve`, { method: 'POST' });
      else if (d.siteDel) {
        if (!confirm('Take this website down?')) return;
        await api(`/sites/${d.siteDel}`, { method: 'DELETE' });
      } else if (d.role) await api(`/accounts/${d.role}/role`, { method: 'POST', body: { role: d.to } });
      else if (d.sitePreview) {
        const { html } = await api(`/sites/${d.sitePreview}/html`);
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', '');
        frame.style.cssText = 'width:100%;height:560px;border:1px solid var(--line);border-radius:12px;margin-top:14px;background:#fff';
        frame.srcdoc = html;
        $('#sitepreview', root).replaceChildren(frame);
        return;
      } else return;
      toast('Done');
      go('/moderate', true);
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------------------------------------------------------------- leaderboard
export async function leaderboardPage(root) {
  const data = await api('/leaderboard');
  root.innerHTML = `
    <section class="hero compact"><div><h1>Leaderboard</h1></div></section>
    <section class="panel pink">
      <h2>${esc(data.semester.label)}: most upvoted new material</h2>
      <p style="margin:0;max-width:75ch">Every material added this semester takes part. The one with the most upvotes when the semester ends wins, and so does the group that collected the most upvotes on its new materials. ${plural(data.semester.days_left, 'day')} left. Prizes ${todo('not decided yet')}</p>
    </section>
    ${data.simulated ? '<div class="notice">Votes on the seed materials are simulated, so this board shows how a competition would look, not real standings.</div>' : ''}
    <div class="cols">
      <div>
        <h2 style="margin:6px 0 14px">This semester’s top materials</h2>
        ${data.materials.length ? `<div class="grid two">${data.materials.map((i, n) => card(i).replace('<div class="meta">', `<div class="meta"><span class="badge pending">#${n + 1}</span>`)).join('')}</div>` : '<div class="empty">No material has been added this semester yet. <a href="/add">Add the first one</a>.</div>'}
      </div>
      <aside>
        <section class="panel">
          <h3 style="margin-top:0">Groups, all time</h3>
          <table class="spec"><thead><tr><th>#</th><th>Group</th><th>Score</th></tr></thead><tbody>
          ${data.groups.map((g, n) => `<tr><td>${n + 1}</td><td><strong>${esc(g.group)}</strong><br><span class="small muted">${plural(g.materials, 'material')} · ${plural(g.uses, 'use')}${g.forked ? ` · forked ${g.forked}×` : ''}${g.this_semester ? ` · ${g.this_semester} this semester` : ''}</span></td><td><strong>${g.score}</strong></td></tr>`).join('')}
          </tbody></table>
          <p class="hint">Score is upvotes minus downvotes over all of a group’s materials.</p>
        </section>
      </aside>
    </div>`;
  watchPreviews(root);
}

// ---------------------------------------------------------------- privacy
// Keep this page in step with the code: it states what the server stores (server/store.js, server/index.js),
// what the browser keeps (public/api.js, public/brand.js) and how long (server/ops.js, infra/commons.tf).
export async function privacyPage(root) {
  root.innerHTML = `
    <section class="hero compact"><div><h1>Privacy</h1></div></section>
    <p class="muted" style="max-width:75ch">What this site stores about you, for how long, and how you delete it. You can browse, vote and add materials without an account.</p>
    <div class="notice"><strong>[TO BE FILLED IN BY THE OPERATOR BEFORE THE SITE IS MADE PUBLIC: name and postal address of the person or organization that runs this site, and a contact address for privacy requests.]</strong></div>
    <section class="panel"><h2>What is stored</h2>
      <div class="md">
        <ul>
          <li><strong>A random browser id.</strong> Your browser makes up a random id on your first visit and keeps it in its own storage. It is sent with your requests so that you have one vote per material and can see and change what you added. It says nothing about who you are.</li>
          <li><strong>Votes.</strong> For each vote: the material, up or down, the time, and your browser id (or your user name when you are signed in).</li>
          <li><strong>Materials you add.</strong> The texts and files you upload and the group name you give, with the browser id or user name that added them. Published materials and their group name are public. Your user name is shown to moderators only.</li>
          <li><strong>Accounts</strong> (optional). Your user name, your group, a salted hash of your password (not the password itself), your role and the date the account was made. When you are signed in, your brand kit is saved with the account, including a contact address if you put one into the kit, and a group website if you publish one.</li>
          <li><strong>Use counts.</strong> A download, copy or print adds one to the material’s counter. Which browser was already counted is kept in the server’s memory only.</li>
          <li><strong>Server logs.</strong> The hosting provider records every request: IP address, time, the address requested and the browser’s identification. Logs are kept for 30 days. A setup command made with “Set up my AI” carries the group details you entered in its address, so they appear in these logs. The server also holds IP addresses in memory for up to an hour to limit the number of requests per address.</li>
        </ul>
      </div>
    </section>
    <section class="panel"><h2>What is not</h2>
      <div class="md">
        <ul>
          <li>No email address is asked for. That is also why a forgotten password cannot be reset.</li>
          <li>No analytics, no advertising and no tracking across sites.</li>
          <li>No cookies, with one exception: opening the private preview link of a group website that is waiting for review sets a cookie for that preview, for two days, so that the pages of the preview can load.</li>
          <li>Your browser keeps a few things for itself and they stay there: your brand kit, the texts you changed in templates, ticked kit checklists, the keys for materials you added, and your sign-in.</li>
        </ul>
      </div>
    </section>
    <section class="panel"><h2>Other services involved</h2>
      <div class="md">
        <ul>
          <li><strong>Google Cloud</strong> hosts the site, its database and the uploaded files, in the United States (Iowa).</li>
          <li><strong>Google Fonts.</strong> The fonts of the site and of the templates are loaded from Google’s font servers, so your browser connects to them and they see your IP address.</li>
          <li><strong>Google’s AI models (Vertex AI).</strong> What you type into the search box, a printable you send to the converter and the group name you enter for logo suggestions are sent to these models to be processed.</li>
          <li><strong>Group websites</strong> under <code>/s/…</code> are made by the groups themselves and may load content from elsewhere.</li>
        </ul>
      </div>
    </section>
    <section class="panel"><h2>How long, and how to delete it</h2>
      <div class="md">
        <ul>
          <li><strong>Votes:</strong> until you take them back. Click the same arrow again.</li>
          <li><strong>Materials:</strong> until they are deleted. Open the material in the browser or account that added it and choose “Delete this material”. An upload that was started and never submitted is removed after two days.</li>
          <li><strong>Account:</strong> until you delete it on the <a href="/account">account page</a>. That removes the account, your group website, your saved brand kit and your votes, and deletes your materials that are still waiting for review. Materials you published either stay in the commons without your user name, or are deleted too; you choose.</li>
          <li><strong>Browser id and everything else in your browser:</strong> clear this site’s data in your browser’s settings.</li>
          <li><strong>Copies:</strong> deleted data can remain in the hosting provider’s backups for up to 30 days.</li>
          <li><strong>If you cannot reach it yourself</strong> (another browser added it, or the password is lost), write to the operator named above.</li>
        </ul>
      </div>
    </section>`;
}
