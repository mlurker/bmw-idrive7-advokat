'use strict';
/**
 * tuners.js - what each tuning software's DME code answers to. tune.js (TuneControl) owns the state,
 * the queue, the screen's words and the safety rules; a driver here only knows the bytes.
 *
 * A driver offers (all but `refresh` and the setters are plain fields):
 *   id, label            'mhd', 'MHD'
 *   features             { map, cooling, burbles, asd }: which pages the tune gets
 *   mapSlots             how many maps (1..mapSlots on screen)
 *   burbleSlots          null: burbles are an aggression (0..12); a number: that many slots (0..n-1)
 *   readback             true when a setting is read back from the DME (the screen says "confirmed")
 *   coolingNeedsEngine   Max Cooling ON is sent only with the engine running
 *   verified             the DME was identified as running this tune
 *   async refresh()      identify and read what the DME has -> { map, mapConfirmed, burbles, targetAgg,
 *                        validMaps (map numbers), validBurbles (slot numbers), note }  (nothing is sent when
 *                        there is nothing to read; a missing valid list = every slot)
 *   async setMap(n)      -> { map, confirmed }
 *   async setCooling(on) -> on
 *   async setBurbles(v)  aggression or null (off), or a slot -> { burbles, confirmed }
 *   async setAsd(on)     -> on
 * A failed command throws an Error whose message is the screen's note.
 *
 * Most tunes are a few short UDS requests: CommandDriver takes them as data (a SPEC, below). MHD and MG
 * Flasher are specs. BM3 reads and writes the DME's memory by its ROM's layout, so it is its own class.
 */
const { Bm3Protocol } = require('./bm3_protocol');
const bm3Profiles = require('./bm3_profiles');

const DME_HEX = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const NONE = { map: false, cooling: false, burbles: false, asd: false };

/* ------------------------------------------------------------------ SPEC -- */
/*
 * A SPEC describes a tune whose controls are short UDS requests to the DME (0x12):
 *
 *   id, label
 *   map      { slots, request(n) -> { sid, data } }               n = 1..slots
 *   cooling  { request(on) -> { sid, data }, needsEngine }
 *   burbles  { slots, request(slot) -> { sid, data } }            slot = 0..slots-1
 *   ack      optional (reply, req) -> bool; the default is the DME echoing the request (sid + 0x40, the data)
 *   retry    optional { nrc, times, delayMs }: ask again while the DME answers this negative response code
 *   identify optional { request() -> { sid, data }, parse(reply) -> text }   throws when this is not the tune
 *   read     optional { request() -> { sid, data }, parse(reply) -> { map, burbles, cooling, validMaps, validBurbles } }
 *            with it, a setting is read back after it is sent and the screen says "confirmed"
 *   A control whose `request` is null is declared but not configured: pressing it says so and sends nothing.
 */

/** MHD (captures by a1-mapping on PR #23; map switch confirmed on an MG1): 2F 01 <map-1>, 2F 03 <on>,
 * each accepted on the DME's echo. No identification and no read-back are known. */
const MHD = {
    id: 'mhd', label: 'MHD',
    map: { slots: 4, request: (n) => ({ sid: 0x2F, data: [0x01, n - 1] }) },
    cooling: { request: (on) => ({ sid: 0x2F, data: [0x03, on ? 0x01 : 0x00] }), needsEngine: true },
};

/**
 * MG Flasher (Custom Code 6.9 and later): Switchable Maps slots 0-4, Burbles slots 0-5, Max Cooling on / off.
 * From the MG Flasher Android app (v507, UniFlasherHelper in MgFlasher.Flasher.Services), which sends to the DME
 * (0x12) a UDS WriteDataByIdentifier whose two data bytes are the value and a checksum:
 *     2E <DID hi> <DID lo> <value> <(DID hi + DID lo + value) & 0xFF>      -> 6E <DID hi> <DID lo>
 *   0x6945 map slot (0-4), 0x6946 burble slot (0-5), 0x6947 Max Cooling (0 off, 1 on)
 * and retries while the DME answers NRC 0x21 (busy), up to 20 times, 200 ms apart. The app then reads the
 * active slot back from RAM at addresses that come from the Custom Code version's A2L: they are not known
 * here, so there is no `read` and no `identify` yet and the screen says "accepted", never "confirmed".
 * NOT yet tried on a car: nothing in the app's own code says what the DME does outside these steps.
 * Max Cooling is not gated on the engine speed (the app does not do it either).
 */
const mgWrite = (did, value) => ({ sid: 0x2E, data: [did >> 8, did & 0xFF, value, ((did >> 8) + (did & 0xFF) + value) & 0xFF] });
const MG_FLASHER = {
    id: 'mgflasher', label: 'MG Flasher',
    map: { slots: 5, request: (n) => mgWrite(0x6945, n - 1) },
    burbles: { slots: 6, request: (slot) => mgWrite(0x6946, slot) },
    cooling: { request: (on) => mgWrite(0x6947, on ? 1 : 0), needsEngine: false },
    // 6E + the DID (the value and checksum are not echoed)
    ack: (r, q) => r.sid === 0x6E && r.data && r.data[0] === q.data[0] && r.data[1] === q.data[1],
    retry: { nrc: 0x21, times: 20, delayMs: 200 },
    identify: null,    // the Custom Code version: not known how the app reads it
    read: null,        // the active slot / validity: RAM addresses from the A2L, not known here
};

/* ---------------------------------------------------------- CommandDriver -- */
class CommandDriver {
    constructor(spec, link, log) {
        this.spec = spec;
        this.link = link;
        this.log = log || { info() {}, warn() {} };
        this.id = spec.id;
        this.label = spec.label;
        this.features = { map: !!spec.map, cooling: !!spec.cooling, burbles: !!spec.burbles, asd: false };
        this.mapSlots = spec.map ? spec.map.slots : 0;
        this.burbleSlots = spec.burbles ? spec.burbles.slots : null;
        this.readback = !!spec.read;
        this.coolingNeedsEngine = !!(spec.cooling && spec.cooling.needsEngine);
        this.verified = !spec.identify;       // nothing to identify = nothing to verify
    }

    /** One request to the DME; a refusal or silence is an Error carrying the screen's note. */
    async _send(control, value) {
        const c = this.spec[control];
        if (!c || !c.request) throw new Error(this.label + ': commands not configured yet');
        if (!this.verified) throw new Error(this.label + ': DME not identified');
        const req = c.request(value);
        let r = await this.link.sendToDme(req.sid, req.data);
        const retry = this.spec.retry;     // the DME is busy (NRC 0x21): ask again, as the tune's own app does
        for (let i = 0; retry && r && r.nrc === retry.nrc && i < retry.times; i++) {
            await new Promise((done) => setTimeout(done, retry.delayMs));
            r = await this.link.sendToDme(req.sid, req.data);
        }
        const ack = this.spec.ack || ((reply, q) => reply.sid === q.sid + 0x40 && reply.data && reply.data.length >= q.data.length
            && q.data.every((b, i) => reply.data[i] === b));
        if (r && r.ok && ack(r, req)) return r;
        if (r && r.nrc != null) {
            this.log.info('tune: DME refused ' + req.sid.toString(16).toUpperCase() + ' ' + DME_HEX(req.data) + ' (' + r.reason + ')');
            throw new Error('Not available on this car');
        }
        throw new Error('No answer from the DME');
    }

    async _ask(q) {
        const req = q.request();
        const r = await this.link.sendToDme(req.sid, req.data);
        if (!r || !r.ok) throw new Error(r && r.reason ? this.label + ': ' + r.reason : 'No answer from the DME');
        return r;
    }

    async refresh() {
        const s = this.spec;
        this.verified = !s.identify;
        const out = {};
        if (s.identify) {
            out.note = this.label + ' ' + s.identify.parse(await this._ask(s.identify));
            this.verified = true;
        }
        if (s.read) { const st = await this._read(); Object.assign(out, st, { mapConfirmed: st.map !== undefined }); }
        return out;
    }

    async _read() {
        return this.spec.read.parse(await this._ask(this.spec.read));
    }

    async setMap(n) {
        await this._send('map', n);
        if (!this.spec.read) return { map: n, confirmed: false };
        const state = await this._read();
        if (state.map !== n) throw new Error('map readback differs: ' + state.map);
        return { map: n, confirmed: true, state };
    }

    async setCooling(on) {
        await this._send('cooling', on);
        return !!on;
    }

    async setBurbles(slot) {
        await this._send('burbles', slot);
        if (!this.spec.read) return { burbles: slot, confirmed: false };
        const state = await this._read();
        if (state.burbles !== slot) throw new Error('burble readback differs: ' + state.burbles);
        return { burbles: slot, confirmed: true, state };
    }
}

/* ------------------------------------------------------------- Bm3Driver -- */
/** BM3 CustomROM (bm3_protocol.js): identified by the ROM marker; the map and burbles are memory
 * writes confirmed by reading them back; ASD is a plain write. */
class Bm3Driver {
    constructor(link, config, log) {
        this.link = link;
        this.log = log || { info() {}, warn() {} };
        this.proto = link && link.diag ? new Bm3Protocol(link.diag, bm3Profiles, config || {}) : null;
        this.id = 'bm3';
        this.label = 'BM3';
        this.features = { map: true, cooling: false, burbles: true, asd: true };
        this.mapSlots = 4;
        this.burbleSlots = null;
        this.readback = true;
        this.coolingNeedsEngine = false;
        this.verified = false;
    }

    async _identify() {
        if (!this.proto) throw new Error('no diagnostic link');
        if (!this.verified) { await this.proto.identify(); this.verified = true; }
    }

    async refresh() {
        this.verified = false;
        await this._identify();
        const out = { map: (await this.proto.currentMap()) + 1, mapConfirmed: true };
        try {
            const s = await this.proto.readBurbles();
            out.burbles = !s.enabled ? 'off' : s.aggression === null ? 'custom' : s.aggression.toFixed(1);
            if (s.enabled && s.aggression !== null && s.aggression <= 12) out.targetAgg = s.aggression;
        } catch (e) {
            out.burbles = null;
            this.log.warn('burble readback: ' + String(e && e.message || e));
        }
        out.note = 'BM3 ROM ' + this.proto.rom + ' · map ' + out.map + ' active';
        return out;
    }

    async setMap(n) {
        await this._identify();
        return { map: (await this.proto.setMap(n - 1)) + 1, confirmed: true };
    }

    async setBurbles(aggression) {
        await this._identify();
        const v = await this.proto.setBurbles(aggression);
        return { burbles: v === null ? 'off' : v.toFixed(1), confirmed: true };
    }

    async setAsd(on) { return this.proto.setAsd(on); }
}

/* -------------------------------------------------------------- registry -- */
const DRIVERS = {
    off: () => null,
    bm3: (link, config, log) => new Bm3Driver(link, config, log),
    mhd: (link, config, log) => new CommandDriver(MHD, link, log),
    mgflasher: (link, config, log) => new CommandDriver(MG_FLASHER, link, log),
};
const TUNERS = Object.keys(DRIVERS);

function createDriver(id, link, config, log) { return DRIVERS[id](link, config, log); }

module.exports = { TUNERS, NONE, createDriver, CommandDriver, Bm3Driver, MHD, MG_FLASHER };
