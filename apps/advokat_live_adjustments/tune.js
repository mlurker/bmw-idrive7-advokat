'use strict';
/**
 * tune.js - the live adjustments a TUNED DME offers. The "Tuning software" setting says which
 * tune the car runs, and the tabs follow it:
 *
 *   Off (default)  nothing is sent at all and no tune tab is offered
 *   BM3            Engine Map, Burbles (aggression), Active Sound (ASD)
 *   MHD            Engine Map, Max Cooling
 *   MG Flasher     Engine Map (slots), Burbles (slots), Max Cooling
 *
 * TuneControl is the same for every tune: it owns the state the pages show, the one-conversation-at-a-time
 * queue, the refusals (no link, engine not running, a press during a refresh) and the words on screen. What a
 * tune sends is a driver in tuners.js (its header lists the interface); a new tune is a driver there, a choice
 * in "tuner" in app.json, and a test case (see the README).
 *
 *   BM3 (bm3_protocol.js / bm3_profiles.js, formerly the separate BM3 Live app): the
 *     CustomROM is identified by its marker and must match a known ROM; the map and burbles
 *     are written to the DME's memory and confirmed by reading them back. Unknown ROMs are
 *     rejected. ASD: 2E 5FFD 00 (on) | 01 (off), no read-back.
 *   MHD (captures by a1-mapping on PR #23; map switch confirmed on the owner's MG1,
 *     2026-10-30 - the engine note changed), DME 0x12:
 *     map switch : 2F 01 <map - 1>   -> 6F 01 <map - 1>   map 1..4 = 00..03
 *     max cooling: 2F 03 01 | 00     -> 6F 03 01 | 00     on | off
 *       ON is sent only with the engine running: live engine speed over MIN_COOLING_RPM
 *       (CDS statusEngineSpeed2; demo data never counts). OFF is always allowed.
 *     MHD's marker sits at a ROM-dependent address, so it is not read: a press counts only
 *     when the DME echoes the request back. No read-back of the active map is known.
 */
const { TUNERS, NONE, createDriver } = require('./tuners');

const MIN_COOLING_RPM = 500;     // Max Cooling: the engine must be running

class TuneControl {
    /** engine (optional): { rpm() -> live engine speed, or null when unknown / not live } */
    constructor(ctx, engine) {
        this.ctx = ctx;
        this.engine = engine || { rpm: () => null };
        this.log = ctx.log;
        this.link = null;
        this._drivers = {};          // one driver per tune, made when it is first picked
        this._ops = 0;               // commands and refreshes queued or running (busy while any)
        this._queue = Promise.resolve();
        this._refreshing = null;     // a refresh queued but not started yet
        this._refreshRuns = false;   // a refresh running
        this._waitNote = false;      // pressed during a refresh: the page says why nothing happened, until it ends
        this._reset();
        this.targetAgg = 1.5;        // burble aggression picked with -/+ (sent on Apply)
    }

    _reset() {
        this.map = null;             // 1..mapSlots, the map last confirmed (read back) or accepted
        this.mapConfirmed = false;   // true = read back from the DME
        this.cooling = null;         // 'ON' | 'OFF' | null (accepted by the DME)
        this.burbles = null;         // aggression tunes: 'off' | 'custom' | '4.5' | null (unknown); slot tunes: the slot
        this.asd = null;             // true | false | null (last accepted)
        this.validMaps = null;       // slots the DME offers (null: all)
        this.validBurbles = null;
        this.note = null;            // the status line under the page
        this.noteType = 'dim';       // dim | go | warn
    }

    /** The tune the owner picked in Settings; anything unknown counts as Off. */
    get tuner() {
        const v = this.ctx.settings.get('tuner');
        return TUNERS.indexOf(v) >= 0 ? v : 'off';
    }
    get armed() { return this.tuner !== 'off'; }
    get busy() { return this._ops > 0; }

    /** The picked tune's driver (tuners.js), or null for Off. */
    get driver() {
        const id = this.tuner;
        if (id === 'off') return null;
        if (!this._drivers[id]) this._drivers[id] = createDriver(id, this.link, this.ctx.spec.config || {}, this.log);
        return this._drivers[id];
    }
    /** The DME was identified as running the picked tune (BM3: its ROM matched a known profile). */
    get verified() { const d = this.driver; return !!(d && d.verified); }

    /** Which pages this car gets: the picked tune's. */
    features() { const d = this.driver; return Object.assign({}, d ? d.features : NONE); }

    async start(link) {
        this.link = link;
        this._drivers = {};
        await this.refresh();
    }

    /** One DME conversation at a time: a refresh waits for the command in flight and the other way
     * round (BM3's 0x63 replies carry no address, so two reads in flight could swap answers). */
    _serial(fn) {
        this._ops++;
        const done = () => { this._ops--; };
        const p = this._queue.then(fn).then((v) => { done(); return v; }, (e) => { done(); throw e; });   // (no Promise.finally on the car's Node 8)
        this._queue = p.catch(() => {});
        return p;
    }

    /** The tune changed or the diagnostic link came up: start over. A driver identifies the DME and reads
     * what it has (BM3: memory reads only; MHD has nothing to read); Off sends nothing. A refresh already
     * waiting reads the settings when it starts, so a second one joins it. */
    refresh() {
        if (!this._refreshing) {
            this._refreshing = this._serial(() => {
                this._refreshing = null; this._refreshRuns = true;
                const end = () => { this._refreshRuns = this._waitNote = false; };
                return this._refresh().then((v) => { end(); return v; }, (e) => { end(); throw e; });
            });
        }
        return this._refreshing;
    }

    async _refresh() {
        const target = this.targetAgg;
        this._reset();
        this.targetAgg = target;
        const d = this.driver;
        if (!d) return;
        if (!this.link || !this.link.available) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
        try {
            this._apply(await d.refresh());
        } catch (e) {
            this.note = d.label + ': ' + String(e && e.message || e);
            this.noteType = 'warn';
            this.log.info('tune detect (' + d.label + '): ' + this.note);
        }
        this.log.info('tune: ' + this.tuner + (d.verified && d.proto && d.proto.rom ? ' (ROM ' + d.proto.rom + ')' : ''));
    }

    /** What a driver read from the DME -> the state the pages show. */
    _apply(r) {
        if (!r) return;
        if (r.map !== undefined) { this.map = r.map; this.mapConfirmed = !!r.mapConfirmed; }
        if (r.burbles !== undefined) this.burbles = r.burbles;
        if (r.cooling !== undefined) this.cooling = r.cooling ? 'ON' : 'OFF';
        if (r.targetAgg !== undefined) this.targetAgg = r.targetAgg;
        if (r.validMaps !== undefined) this.validMaps = r.validMaps;
        if (r.validBurbles !== undefined) this.validBurbles = r.validBurbles;
        if (r.note) { this.note = r.note; this.noteType = 'go'; }
    }

    /** The one place a command leaves: a tune picked, the feature is that tune's, the link is up
     * and nothing else is running. */
    async _run(feature, label, fn) {
        // one at a time: a press while a command runs is not sent (its note says so); during a refresh, say why
        if (this.busy) { if (this._refreshing || this._refreshRuns) this._waitNote = true; return; }
        const d = this.driver;
        if (!d || !d.features[feature]) { this.note = 'Not available for this tune'; this.noteType = 'warn'; return; }
        if (!this.link || !this.link.available) { this.note = 'Waiting for the diagnostic link'; this.noteType = 'warn'; return; }
        this.note = 'Sending ' + label + '…'; this.noteType = 'dim';
        return this._serial(async () => {
            try {
                this.note = await fn(d);
                this.noteType = 'go';
            } catch (e) {
                this.note = String(e && e.message || e);
                this.noteType = 'warn';
                this.log.warn('tune ' + label + ': ' + this.note);
            }
        });
    }

    /** "confirmed" when the DME's own answer showed it (a read-back), else "accepted". */
    static how(confirmed) { return confirmed ? 'confirmed' : 'accepted'; }

    /** Map 1..mapSlots: one press switches (no confirm step, the user's choice). */
    setMap(n) {
        return this._run('map', 'map ' + n, async (d) => {
            if (!(n >= 1 && n <= d.mapSlots)) throw new Error('No such map');
            if (this.validMaps && this.validMaps.indexOf(n) < 0) throw new Error('Map ' + n + ' is not available');
            const r = await d.setMap(n);
            this.map = r.map;
            this.mapConfirmed = !!r.confirmed;
            if (r.state) this._apply({ validMaps: r.state.validMaps, validBurbles: r.state.validBurbles });
            return 'Map ' + this.map + ' · ' + TuneControl.how(r.confirmed) + ' by the DME';
        });
    }

    /** Live engine speed, or null (no live value: unknown, or demo data). */
    rpm() {
        const r = this.engine.rpm();
        return typeof r === 'number' && isFinite(r) ? r : null;
    }
    engineRunning() { const r = this.rpm(); return r !== null && r > MIN_COOLING_RPM; }

    setCooling(on) {
        const d = this.driver;
        if (on && d && d.features.cooling && d.coolingNeedsEngine && !this.busy && !this.engineRunning()) {
            this.note = 'Start the engine first · Max Cooling needs over ' + MIN_COOLING_RPM + ' rpm';
            this.noteType = 'warn';
            return Promise.resolve();
        }
        return this._run('cooling', 'cooling ' + (on ? 'on' : 'off'), async (drv) => {
            this.cooling = (await drv.setCooling(on)) ? 'ON' : 'OFF';
            return 'Max Cooling ' + this.cooling.toLowerCase() + ' · accepted by the DME';
        });
    }

    /** -/+ only pick the aggression on screen; nothing is sent until Apply. */
    stepAggression(delta) {
        this.targetAgg = Math.max(0, Math.min(12, this.targetAgg + delta));
        this.note = 'Aggression ' + this.targetAgg.toFixed(1) + ' selected · press Apply to send';
        this.noteType = 'dim';
    }

    /** Apply the picked aggression, or turn the override off (off = true). */
    applyBurbles(off) {
        return this._run('burbles', off ? 'burbles off' : 'burbles ' + this.targetAgg.toFixed(1), async (d) => {
            if (d.burbleSlots !== null) throw new Error('Not available for this tune');   // slot tunes: setBurbleSlot
            const r = await d.setBurbles(off ? null : this.targetAgg);
            this.burbles = r.burbles;
            return 'Burbles ' + r.burbles + ' · ' + TuneControl.how(r.confirmed) + ' by the DME';
        });
    }

    /** Slot tunes (MG Flasher): one press picks the burble slot. */
    setBurbleSlot(n) {
        return this._run('burbles', 'burbles ' + n, async (d) => {
            if (d.burbleSlots === null || !(n >= 0 && n < d.burbleSlots)) throw new Error('No such burble slot');
            if (this.validBurbles && this.validBurbles.indexOf(n) < 0) throw new Error('Burble slot ' + n + ' is not available');
            const r = await d.setBurbles(n);
            this.burbles = r.burbles;
            if (r.state) this._apply({ validMaps: r.state.validMaps, validBurbles: r.state.validBurbles });
            return 'Burbles slot ' + r.burbles + ' · ' + TuneControl.how(r.confirmed) + ' by the DME';
        });
    }

    /** Active Sound Design on / off (the DME accepts it; its state is not reported back). */
    setAsd(on) {
        return this._run('asd', 'ASD ' + (on ? 'on' : 'off'), async (d) => {
            this.asd = await d.setAsd(on);
            return 'ASD ' + (this.asd ? 'on' : 'off') + ' · accepted by the DME';
        });
    }

    view() {
        const d = this.driver;
        return {
            armed: this.armed,
            tuner: this.tuner,
            features: this.features(),
            map: this.map,
            mapConfirmed: this.mapConfirmed,
            mapSlots: d ? d.mapSlots : 0,
            validMaps: this.validMaps,
            readback: !!(d && d.readback),   // MHD: no read-back of the active map
            cooling: this.cooling,
            burbles: this.burbles,
            burbleSlots: d ? d.burbleSlots : null,   // null: burbles are an aggression
            validBurbles: this.validBurbles,
            asd: this.asd,
            rpm: this.rpm(),
            minCoolingRpm: MIN_COOLING_RPM,
            targetAgg: this.targetAgg,
            busy: this.busy,
            note: this._waitNote ? 'Reading the DME - press again in a moment' : this.note,
            noteType: this._waitNote ? 'warn' : this.noteType,
        };
    }
}

module.exports = { TuneControl, TUNERS, MIN_COOLING_RPM };
