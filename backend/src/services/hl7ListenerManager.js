'use strict';

const { startMllpListener } = require('./hl7AdtListener');
const status = require('./hospitalStatus');

/**
 * hl7ListenerManager.js
 *
 * Starts, restarts and stops each hospital's MLLP listener from the
 * hospital registry, so a hospital added or edited in the System Admin UI
 * starts receiving ADT messages without a backend restart.
 *
 * Listeners are only opened when HL7_MLLP_ENABLED=true: local runs should
 * never bind TCP ports nobody asked for.
 */
class Hl7ListenerManager {
  constructor({ registry, inbox, mllpEnabled, tls = null, logger }) {
    this.registry = registry;
    this.inbox = inbox;
    this.mllpEnabled = mllpEnabled;
    this.tls = tls;
    this.logger = logger;
    this.listeners = new Map(); // hospitalID -> { inbound, port }
  }

  /** Brings every hospital's listener in line with the registry. */
  async syncAll() {
    const ids = new Set(this.registry.list().map((h) => h.hospitalID));
    for (const id of ids) await this.sync(id);
    for (const id of [...this.listeners.keys()]) if (!ids.has(id)) await this.stop(id);
  }

  /** Re-reads one hospital and (re)starts or stops its listener. */
  async sync(hospitalID) {
    const h = this.registry.get(hospitalID);
    if (!h) {
      await this.stop(hospitalID);
      status.removeHospital(hospitalID);
      return;
    }
    const hl7 = h.hl7 || {};
    await this.stop(hospitalID);
    status.configureHospital({ hospitalID, mode: h.integration, mllpPort: hl7.mllpEnabled ? hl7.mllpPort : null, hl7Version: hl7.hl7Version });
    this._restoreCounters(hospitalID);

    if (h.status !== 'active') return status.markDisabled(hospitalID, 'hospital is inactive');
    if (h.integration === 'manual') return status.markDisabled(hospitalID, 'manual roster: no live integration');
    if (h.integration === 'fhir') return status.markDisabled(hospitalID, 'FHIR REST: records are pulled on request');
    if (!hl7.mllpEnabled) return status.markDisabled(hospitalID, 'HL7 over HTTP only (POST /api/hl7/adt/' + hospitalID + ')');
    if (!this.mllpEnabled) return status.markDisabled(hospitalID, 'HL7_MLLP_ENABLED is not true on the server');

    const log = this.logger.child({ component: 'mllp', hospitalID });
    const inbound = startMllpListener({
      inbox: this.inbox,
      hospitalID,
      port: hl7.mllpPort,
      version: hl7.hl7Version || '2.5',
      tls: this.tls,
      allowedIps: hl7.allowedIps || [],
      bindAddress: hl7.bindAddress || undefined,
      log: {
        log: (...args) => {
          status.markListening(hospitalID);
          log.info(args.join(' '));
        },
        warn: (...args) => {
          if (args.some((arg) => String(arg).includes('listener error'))) status.markError(hospitalID, args.at(-1));
          log.warn(args.join(' '));
        },
      },
    });
    this.listeners.set(hospitalID, { inbound, port: hl7.mllpPort });
  }

  /** After a restart, start the message counters from the stored inbox history. */
  _restoreCounters(hospitalID) {
    const current = status.getHospitalStatus(hospitalID);
    if (!current || current.messagesReceived > 0 || !this.inbox) return;
    const msgs = this.inbox.list({ hospitalID });
    if (!msgs.length) return;
    const accepted = msgs.filter((m) => m.status === 'PROCESSED').length;
    const latest = msgs.reduce((a, m) => (!a || (m.receivedAt || '') > (a.receivedAt || '') ? m : a), null);
    status.restoreCounters(hospitalID, {
      messagesReceived: msgs.length,
      messagesAccepted: accepted,
      messagesRejected: msgs.filter((m) => m.status === 'REJECTED' || m.status === 'DEAD').length,
      lastMessageAt: latest ? latest.receivedAt : null,
      lastMessageStatus: latest ? (latest.status === 'PROCESSED' ? 'accepted' : 'rejected') : null,
    });
  }

  async stop(hospitalID) {
    const entry = this.listeners.get(hospitalID);
    if (!entry) return;
    this.listeners.delete(hospitalID);
    try {
      // Inbound.close() returns before the port is released; wait for the
      // underlying server so a restart on the same port doesn't collide.
      const srv = entry.inbound._socket;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        if (srv && srv.listening) srv.once('close', done);
        else setImmediate(done);
        entry.inbound.close();
      });
    } catch (err) {
      this.logger.warn('closing MLLP listener failed', { hospitalID, err });
    }
  }

  async closeAll() {
    await Promise.allSettled([...this.listeners.keys()].map((id) => this.stop(id)));
  }
}

module.exports = { Hl7ListenerManager };
