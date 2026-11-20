import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// Laboratory-only adapters. The database is a disposable SQLite file and
// the model and Chatwoot ports are provided by the synthetic tests.
export class Atendimento {
  constructor(file, { model, channel, now = Date.now, ready = false, leaseMs = 30_000 }) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, enabled INTEGER, version INTEGER);
      INSERT OR IGNORE INTO settings VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, org TEXT, account TEXT, inbox TEXT);
    `);
    Object.assign(this, { model, channel, now, ready, leaseMs });
  }

  close() { this.db.close(); }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Provisioning is an explicit fixture, outside the event and operator APIs.
  provision(org, connection, account, inbox, members) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO tenants VALUES (?, ?)').run(org, JSON.stringify({
        enabled: false, version: 0, members, conversations: [],
      }));
      this.db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)').run(connection, org, account, inbox);
    });
  }

  tenant(org) {
    const row = this.db.prepare('SELECT state FROM tenants WHERE id = ?').get(org);
    if (!row) throw Error('tenant');
    return JSON.parse(row.state);
  }

  global() { return this.db.prepare('SELECT enabled, version FROM settings WHERE id = 1').get(); }

  edit(org, work) {
    return this.transaction(() => {
      const tenant = this.tenant(org);
      const result = work(tenant, this.global());
      this.db.prepare('UPDATE tenants SET state = ? WHERE id = ?').run(JSON.stringify(tenant), org);
      return result;
    });
  }

  policies(org, actor, enabled, { global = false } = {}) {
    if (typeof enabled !== 'boolean') throw Error('policy');
    if (global) {
      // The caller supplies an authenticated administrative scope in this lab.
      if (actor.platformAdmin !== true) throw Error('permission');
      return this.transaction(() => {
        this.db.prepare('UPDATE settings SET enabled = ?, version = version + 1 WHERE id = 1').run(Number(enabled));
        if (enabled) return;
        for (const { id } of this.db.prepare('SELECT id FROM tenants').all()) {
          const t = this.tenant(id);
          for (const c of t.conversations) this.stopAutomation(c, 'global_off');
          this.db.prepare('UPDATE tenants SET state = ? WHERE id = ?').run(JSON.stringify(t), id);
        }
      });
    }
    return this.edit(org, t => {
      if (!t.members.some(m => m.id === actor.id && m.active && m.manage)) throw Error('permission');
      t.enabled = enabled;
      t.version++;
      if (!enabled) for (const c of t.conversations) this.stopAutomation(c, 'org_off');
    });
  }

  conversation(t, id) {
    const c = t.conversations.find(row => row.id === id);
    if (!c) throw Error('conversation');
    return c;
  }

  invalidate(c) {
    c.generation = null;
    for (const job of c.jobs) {
      if (job.kind === 'ai' && job.state === 'pending') job.state = 'invalidated';
    }
  }

  transition(c, mode, reason, actor = null) {
    this.invalidate(c);
    c.version++;
    c.mode = mode;
    c.owner = mode === 'HUMAN' ? actor : null;
    c.desired = ['PREPARING', 'AI'].includes(mode) ? 'pending' : 'open';
    c.confirmed = false;
    c.audit.push({ version: c.version, mode, reason, actor });
  }

  stopAutomation(c, reason) {
    if (['PREPARING', 'AI'].includes(c.mode)) this.transition(c, 'HUMAN_REQUIRED', reason);
  }

  receive(connection, event) {
    // Boundary starts after existing raw HMAC verification. The fixture
    // connection, never payload tenant data, derives organization authority.
    const binding = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(connection);
    if (!binding || event.account !== binding.account || event.inbox !== binding.inbox) throw Error('binding');
    if (!event.conversation || !event.message || typeof event.text !== 'string') throw Error('event');
    const id = JSON.stringify([connection, event.conversation]);
    return this.edit(binding.org, (t, g) => {
      let c = t.conversations.find(row => row.id === id);
      if (!c) {
        c = { id, mode: 'HUMAN_REQUIRED', owner: null, version: 0, revision: 0,
          desired: 'open', confirmed: false, status: null, generation: null,
          messages: [], jobs: [], commands: [], statusSignals: [], audit: [] };
        t.conversations.push(c);
        if (event.verifiedNew === true && g.enabled && t.enabled && this.ready) {
          this.transition(c, 'PREPARING', 'first_contact');
        }
      }
      if (c.messages.some(m => m.id === event.message)) return id;
      c.messages.push({ id: event.message, text: event.text });
      c.revision++;
      this.invalidate(c);
      if (event.requestHuman) this.stopAutomation(c, 'customer_request');
      return id;
    });
  }

  control(org, id, { action, actor, key, expected, summary }) {
    return this.edit(org, (t, g) => {
      const c = this.conversation(t, id);
      const member = t.members.find(m => m.id === actor && m.active);
      if (!member || !key) throw Error('permission');
      const request = JSON.stringify([action, actor, expected, summary]);
      const previous = c.commands.find(cmd => cmd.key === key);
      if (previous) {
        if (previous.request !== request) throw Error('command conflict');
        return previous.version;
      }
      if (c.version !== expected) throw Error('version');
      if (action === 'takeover') {
        this.transition(c, 'HUMAN', 'takeover', actor);
      } else if (action === 'handback') {
        if (c.mode !== 'HUMAN' || c.owner !== actor || !member.manage || !summary?.trim() ||
            !g.enabled || !t.enabled || !this.ready || this.unresolved(c) ||
            c.jobs.some(j => j.kind === 'human' && j.state === 'pending' && j.version === c.version)) {
          throw Error('handback denied');
        }
        this.transition(c, 'PREPARING', 'handback', actor);
        c.summary = summary.trim();
        c.resumeAfter = c.revision;
      } else throw Error('action');
      c.commands.push({ key, request, version: c.version });
      return c.version;
    });
  }

  unresolved(c) {
    return c.jobs.some(j => j.kind === 'ai' && ['in_flight', 'unknown'].includes(j.state));
  }

  eligible(c, t, g) {
    return this.ready && c.mode === 'AI' && c.confirmed && t.enabled && g.enabled && !this.unresolved(c);
  }

  stamp(c, t, g) {
    return JSON.stringify([c.version, c.revision, t.version, g.version]);
  }

  observeStatus(org, id, delivery) {
    // The signed status event is a hint, not a command. Require remote
    // readback before acting; a late pending observation cannot enable AI.
    return this.edit(org, t => {
      const c = this.conversation(t, id);
      if (c.statusSignals.includes(delivery)) return false;
      c.statusSignals.push(delivery);
      c.inspectStatus = true;
      return true;
    });
  }

  async sync(org, id) {
    const claim = this.edit(org, t => {
      const c = this.conversation(t, id);
      if (c.status || (c.confirmed && !c.inspectStatus)) return null;
      c.status = { token: randomUUID(), version: c.version,
        desired: c.desired, observeOnly: c.confirmed, signals: c.statusSignals.length };
      return c.status;
    });
    if (!claim) return false;
    let observed;
    try {
      observed = await this.channel.readStatus(org, id);
      if (!claim.observeOnly && observed !== claim.desired) {
        const current = this.inspect(org, id);
        if (current.version === claim.version) await this.channel.setStatus(org, id, claim.desired);
        observed = await this.channel.readStatus(org, id);
      }
    } catch {
      this.edit(org, t => {
        const c = this.conversation(t, id);
        c.status.unknown = true;
        this.stopAutomation(c, 'status_unknown');
      });
      return false;
    }
    return this.edit(org, (t, g) => {
      const c = this.conversation(t, id);
      c.status = null;
      if (c.version !== claim.version) return false;
      c.inspectStatus = c.statusSignals.length !== claim.signals;
      if (observed !== claim.desired) {
        this.stopAutomation(c, 'status_diverged');
        return false;
      }
      c.confirmed = true;
      if (c.mode === 'PREPARING') {
        if (t.enabled && g.enabled && this.ready && !this.unresolved(c)) c.mode = 'AI';
        else this.stopAutomation(c, 'activation_denied');
      }
      return true;
    });
  }

  async generate(org, id) {
    const claim = this.edit(org, (t, g) => {
      const c = this.conversation(t, id);
      const stamp = this.stamp(c, t, g);
      if (!this.eligible(c, t, g) || c.inspectStatus || c.revision <= (c.resumeAfter ?? 0) ||
          c.jobs.some(j => j.kind === 'ai' && j.stamp === stamp) ||
          (c.generation && c.generation.expires > this.now())) return null;
      c.generation = { token: randomUUID(), expires: this.now() + this.leaseMs };
      return { stamp, token: c.generation.token, messages: c.messages, summary: c.summary };
    });
    if (!claim) return false;
    let result;
    try { result = await this.model({ org, messages: claim.messages, summary: claim.summary }); }
    catch { result = null; }
    return this.edit(org, (t, g) => {
      const c = this.conversation(t, id);
      if (c.generation?.token !== claim.token) return false;
      const expired = c.generation.expires <= this.now();
      c.generation = null;
      if (expired || !this.eligible(c, t, g) || c.inspectStatus || this.stamp(c, t, g) !== claim.stamp) return false;
      if (result?.kind !== 'answer' || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000) {
        this.stopAutomation(c, result?.kind === 'escalate' ? 'model_escalation' : 'model_failure');
        return false;
      }
      c.jobs.push({ key: 'ai:' + claim.stamp, kind: 'ai', stamp: claim.stamp, text: result.text, state: 'pending' });
      return true;
    });
  }

  humanReply(org, id, actor, key, text) {
    return this.edit(org, t => {
      const c = this.conversation(t, id);
      if (c.mode !== 'HUMAN' || c.owner !== actor || !t.members.some(m => m.id === actor && m.active)) throw Error('permission');
      const old = c.jobs.find(j => j.key === 'human:' + key);
      if (old) {
        if (old.text !== text || old.actor !== actor) throw Error('command conflict');
        return old.key;
      }
      const job = { key: 'human:' + key, actor, version: c.version, kind: 'human', text, state: 'pending' };
      c.jobs.push(job);
      return job.key;
    });
  }

  async dispatch(org, id, key) {
    const claim = this.edit(org, (t, g) => {
      const c = this.conversation(t, id);
      const job = c.jobs.find(j => j.key === key);
      if (job?.state !== 'pending') return null;
      if (job.kind === 'ai' && (!this.eligible(c, t, g) || c.inspectStatus || job.stamp !== this.stamp(c, t, g))) return null;
      if (job.kind === 'human' && (c.mode !== 'HUMAN' || c.version !== job.version || c.owner !== job.actor ||
          !t.members.some(m => m.id === job.actor && m.active))) return null;
      // This commit is the linearization point. Never retry an in-flight POST.
      job.state = 'in_flight';
      return job;
    });
    if (!claim) return false;
    let receipt;
    try { receipt = await this.channel.send(org, id, claim); }
    catch { receipt = null; }
    this.edit(org, t => {
      const job = this.conversation(t, id).jobs.find(j => j.key === key);
      job.state = receipt?.id ? 'sent' : 'unknown';
      job.receipt = receipt?.id ?? null;
    });
    return Boolean(receipt?.id);
  }

  inspect(org, id) { return this.conversation(this.tenant(org), id); }
}
